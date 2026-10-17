import asyncio
import hashlib
import hmac
import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app import events
from app.config import get_settings
from app.db import SessionLocal
from app.models import Channel, ChannelKind, Check, Incident, Monitor
from app.worker.checker import Result, Target, perform
from app.worker.runner import Worker, claim_due, record
from tests.factories import add_checks


def target(url: str = "https://api.example.com/health", **overrides) -> Target:
    fields = {"monitor_id": 1, "owner_id": 1, "url": url, "method": "GET", "timeout_seconds": 5, "expected_status": 200}
    return Target(**(fields | overrides))


def mock(handler: Callable[[httpx.Request], httpx.Response]) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


# --- checker ---------------------------------------------------------------------------------


async def test_successful_check():
    async with mock(lambda r: httpx.Response(200)) as client:
        result = await perform(client, target())
    assert result.ok
    assert result.status_code == 200
    assert result.latency_ms is not None and result.latency_ms >= 0


async def test_unexpected_status_fails():
    async with mock(lambda r: httpx.Response(503)) as client:
        result = await perform(client, target())
    assert not result.ok
    assert result.status_code == 503
    assert result.error == "Expected HTTP 200, got 503"


async def test_expected_status_can_be_anything():
    async with mock(lambda r: httpx.Response(401)) as client:
        assert (await perform(client, target(expected_status=401))).ok


async def test_timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    async with mock(handler) as client:
        result = await perform(client, target())
    assert not result.ok
    assert result.error == "Timed out after 5s"


async def test_overall_deadline_caps_slow_targets():
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200)

    async with mock(handler) as client:
        result = await perform(client, target(timeout_seconds=1))
    assert result.error == "Timed out after 1s"


async def test_connection_error():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Name or service not known", request=request)

    async with mock(handler) as client:
        result = await perform(client, target())
    assert result.error == "Connection failed: Name or service not known"


async def test_redirects_are_followed():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/old":
            return httpx.Response(301, headers={"Location": "/new"})
        return httpx.Response(200)

    async with mock(handler) as client:
        assert (await perform(client, target("https://api.example.com/old"))).ok


async def test_redirect_to_private_address_is_blocked():
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data/"})

    async with mock(handler) as client:
        result = await perform(client, target())
    assert not result.ok
    assert "non-public" in result.error
    assert requested == ["https://api.example.com/health"]  # the metadata URL was never requested


async def test_redirect_loop():
    async with mock(lambda r: httpx.Response(302, headers={"Location": "/again"})) as client:
        result = await perform(client, target())
    assert result.error.startswith("TooManyRedirects")


# --- state + incidents -----------------------------------------------------------------------


async def feed(monitor_id: int, outcomes: str, start: datetime) -> list:
    """Record one check per character ('x' fail, '.' ok), a minute apart. Returns the actions."""
    actions = []
    for i, char in enumerate(outcomes):
        result = Result(
            ok=char == ".",
            checked_at=start + timedelta(minutes=i),
            status_code=200 if char == "." else 503,
            latency_ms=100,
            error=None if char == "." else "Expected HTTP 200, got 503",
        )
        async with SessionLocal() as session:
            _, _, action = await record(session, target(monitor_id=monitor_id), result)
        actions.append(action)
    return actions


async def test_incident_opens_at_first_failure_and_resolves(make_monitor):
    monitor = await make_monitor()
    start = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)
    actions = await feed(monitor["id"], ".xxx.x..", start)
    assert [a and a.value for a in actions] == [None, None, None, "open", None, None, None, "resolve"]

    async with SessionLocal() as session:
        incident = await session.scalar(select(Incident))
        # Started at the first failure of the streak, not when the threshold was crossed.
        assert incident.started_at == start + timedelta(minutes=1)
        assert incident.resolved_at == start + timedelta(minutes=7)
        assert incident.cause == "Expected HTTP 200, got 503"
        row = await session.get(Monitor, monitor["id"])
        assert (row.status, row.failing_since) == ("up", None)
        assert await session.scalar(select(func.count()).select_from(Check)) == 8


async def test_flapping_opens_nothing(make_monitor):
    monitor = await make_monitor()
    await feed(monitor["id"], "xx.xx.xx.", datetime(2026, 10, 17, 9, 0, tzinfo=UTC))
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(Incident)) == 0


async def test_result_for_paused_monitor_is_dropped(client, auth, make_monitor):
    monitor = await make_monitor()
    await client.post(f"/api/monitors/{monitor['id']}/pause", headers=auth)
    async with SessionLocal() as session:
        assert await record(session, target(monitor_id=monitor["id"]), Result(True, datetime.now(UTC))) is None
        assert await session.scalar(select(func.count()).select_from(Check)) == 0


async def test_database_allows_one_open_incident_per_monitor(make_monitor):
    monitor = await make_monitor()
    now = datetime.now(UTC)
    async with SessionLocal() as session:
        session.add(Incident(monitor_id=monitor["id"], started_at=now, cause="a"))
        await session.commit()
        session.add(Incident(monitor_id=monitor["id"], started_at=now, cause="b"))
        with pytest.raises(IntegrityError):
            await session.commit()


# --- scheduling ------------------------------------------------------------------------------


async def test_claim_reschedules_due_monitors(make_monitor):
    due = await make_monitor(interval_seconds=60)
    later = await make_monitor()
    paused = await make_monitor()
    now = datetime.now(UTC) + timedelta(seconds=1)
    async with SessionLocal() as session:
        await session.execute(
            update(Monitor).where(Monitor.id == later["id"]).values(next_check_at=now + timedelta(minutes=5))
        )
        await session.execute(update(Monitor).where(Monitor.id == paused["id"]).values(is_active=False))
        await session.commit()
        claimed = await claim_due(session, now, limit=10)
        assert [t.monitor_id for t in claimed] == [due["id"]]
        assert await claim_due(session, now, limit=10) == []  # already pushed a minute ahead
        row = await session.get(Monitor, due["id"])
        assert row.next_check_at == now + timedelta(seconds=60)


async def test_concurrent_workers_never_claim_the_same_monitor(make_monitor):
    for _ in range(6):
        await make_monitor()
    now = datetime.now(UTC) + timedelta(seconds=1)
    async with SessionLocal() as worker_a, SessionLocal() as worker_b:
        # Worker A has locked three rows and is still inside its transaction...
        locked = (
            await worker_a.scalars(
                select(Monitor.id).order_by(Monitor.next_check_at).limit(3).with_for_update(skip_locked=True)
            )
        ).all()
        # ...so worker B skips them instead of waiting or double-claiming.
        claimed = [t.monitor_id for t in await claim_due(worker_b, now, limit=10)]
        await worker_a.rollback()
    assert len(locked) == 3
    assert set(claimed) == {1, 2, 3, 4, 5, 6} - set(locked)


async def test_worker_end_to_end(client, auth, make_monitor):
    """tick → HTTP check → stored result → incident → live events → signed webhook."""
    monitor = await make_monitor(failure_threshold=1)
    channel = (
        await client.post(
            "/api/channels",
            json={"kind": "webhook", "name": "Ops", "target": "https://hooks.example.com/pulse"},
            headers=auth,
        )
    ).json()
    webhooks: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "hooks.example.com":
            webhooks.append(request)
            return httpx.Response(204)
        return httpx.Response(500)

    settings = get_settings().model_copy(update={"worker_concurrency": 4})
    async with events.subscribe(1) as subscription, mock(handler) as http:
        worker = Worker(SessionLocal, http, settings)
        assert await worker.tick(datetime.now(UTC) + timedelta(seconds=1)) == 1
        await asyncio.gather(*worker.in_flight)
        received = [json.loads(await subscription.next(1)) for _ in range(2)]

    assert [m["event"] for m in received] == ["check", "incident.opened"]
    assert received[0]["data"]["monitor_id"] == monitor["id"]
    assert received[0]["data"]["check"]["status_code"] == 500
    assert received[1]["data"]["cause"] == "Expected HTTP 200, got 500"

    assert len(webhooks) == 1
    request = webhooks[0]
    assert request.headers["X-Pulse-Event"] == "incident.opened"
    timestamp, signature = (part.split("=", 1)[1] for part in request.headers["X-Pulse-Signature"].split(","))
    expected = hmac.new(channel["secret"].encode(), f"{timestamp}.".encode() + request.content, hashlib.sha256)
    assert hmac.compare_digest(signature, expected.hexdigest())
    assert json.loads(request.content)["monitor"]["name"] == "API"


async def test_worker_skips_inactive_channels(client, auth, make_monitor):
    await make_monitor(failure_threshold=1)
    async with SessionLocal() as session:
        session.add(
            Channel(
                owner_id=1, kind=ChannelKind.WEBHOOK, name="off", target="https://hooks.example.com/", is_active=False
            )
        )
        await session.commit()
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.host)
        return httpx.Response(500)

    async with mock(handler) as http:
        worker = Worker(SessionLocal, http)
        await worker.tick(datetime.now(UTC) + timedelta(seconds=1))
        await asyncio.gather(*worker.in_flight)
    assert calls == ["api.example.com"]


async def test_prune_deletes_only_expired_checks(make_monitor):
    monitor = await make_monitor()
    now = datetime.now(UTC)
    await add_checks(monitor["id"], [(now - timedelta(days=91), True, 100), (now - timedelta(days=89), True, 100)])
    async with mock(lambda r: httpx.Response(200)) as http:
        assert await Worker(SessionLocal, http).prune(now) == 1
    async with SessionLocal() as session:
        assert await session.scalar(select(func.count()).select_from(Check)) == 1


async def test_run_loop_stops_cleanly(make_monitor):
    await make_monitor()
    stop = asyncio.Event()
    settings = get_settings().model_copy(update={"worker_tick_seconds": 0.05})
    async with mock(lambda r: httpx.Response(200)) as http:
        worker = Worker(SessionLocal, http, settings)
        task = asyncio.create_task(worker.run(stop))
        for _ in range(100):
            await asyncio.sleep(0.05)
            async with SessionLocal() as session:
                if await session.scalar(select(func.count()).select_from(Check)):
                    break
        stop.set()
        await asyncio.wait_for(task, 5)
    async with SessionLocal() as session:
        assert (await session.scalar(select(Monitor))).status == "up"
