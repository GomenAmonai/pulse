from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.config import get_settings
from app.db import SessionLocal
from app.models import Incident, Monitor
from tests.factories import add_checks, register


async def test_create_with_defaults(make_monitor):
    monitor = await make_monitor()
    assert monitor["status"] == "pending"
    assert monitor["interval_seconds"] == 60
    assert (monitor["failure_threshold"], monitor["recovery_threshold"]) == (3, 2)
    assert monitor["stats"]["24h"] == {"checks": 0, "uptime": None, "avg_ms": None, "p95_ms": None}
    assert monitor["sparkline"] == [None] * 24


@pytest.mark.parametrize(
    ("fields", "message"),
    [
        ({"url": "ftp://example.com/"}, "URL scheme"),
        ({"interval_seconds": 10}, "greater than or equal to 30"),
        ({"interval_seconds": 30, "timeout_seconds": 30}, "lower than interval"),
        ({"expected_status": 700}, "less than or equal to 599"),
        ({"name": "   "}, "at least 1 character"),
    ],
)
async def test_validation(client: AsyncClient, auth, fields, message):
    body = {"name": "API", "url": "https://example.com"} | fields
    response = await client.post("/api/monitors", json=body, headers=auth)
    assert response.status_code == 422
    assert message in response.text


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1:8000/",
        "http://localhost/",
        "http://internal.example.com/",
        "http://metadata.example.com/latest/meta-data/",
        "http://[::1]/",
        "http://does-not-resolve.example.com/",
    ],
)
async def test_private_targets_are_blocked(client: AsyncClient, auth, url):
    response = await client.post("/api/monitors", json={"name": "x", "url": url}, headers=auth)
    assert response.status_code == 422
    assert response.json()["code"] == "blocked_target"


async def test_monitor_limit(client: AsyncClient, auth, make_monitor, monkeypatch):
    monkeypatch.setattr(get_settings(), "max_monitors_per_user", 2)
    await make_monitor()
    await make_monitor()
    response = await client.post("/api/monitors", json={"name": "3", "url": "https://example.com"}, headers=auth)
    assert response.status_code == 409
    assert response.json()["code"] == "monitor_limit"


async def test_other_users_monitors_are_invisible(client: AsyncClient, make_monitor):
    monitor = await make_monitor()
    stranger = await register(client, "stranger@example.com")
    assert (await client.get("/api/monitors", headers=stranger)).json() == []
    for method, path in [
        ("GET", ""),
        ("PATCH", ""),
        ("DELETE", ""),
        ("POST", "/pause"),
        ("GET", "/latency"),
        ("GET", "/checks"),
    ]:
        response = await client.request(
            method, f"/api/monitors/{monitor['id']}{path}", headers=stranger, json={} if method == "PATCH" else None
        )
        assert response.status_code == 404, (method, path)


async def test_update(client: AsyncClient, auth, make_monitor):
    monitor = await make_monitor()
    response = await client.patch(
        f"/api/monitors/{monitor['id']}", json={"name": "Public API", "interval_seconds": 300}, headers=auth
    )
    assert response.status_code == 200
    assert response.json()["name"] == "Public API"
    assert response.json()["interval_seconds"] == 300


async def test_update_checks_timeout_against_stored_interval(client: AsyncClient, auth, make_monitor):
    monitor = await make_monitor(interval_seconds=30, timeout_seconds=10)
    response = await client.patch(f"/api/monitors/{monitor['id']}", json={"timeout_seconds": 30}, headers=auth)
    assert response.status_code == 422
    assert response.json()["code"] == "invalid"


async def test_update_rechecks_url(client: AsyncClient, auth, make_monitor):
    monitor = await make_monitor()
    response = await client.patch(
        f"/api/monitors/{monitor['id']}", json={"url": "http://internal.example.com/"}, headers=auth
    )
    assert response.json()["code"] == "blocked_target"


async def test_pause_resolves_open_incident_and_resume_restarts(client: AsyncClient, auth, make_monitor):
    monitor = await make_monitor()
    async with SessionLocal() as session:
        row = await session.get(Monitor, monitor["id"])
        row.status, row.consecutive_failures = "down", 5
        session.add(Incident(monitor_id=row.id, started_at=datetime.now(UTC) - timedelta(minutes=5), cause="503"))
        await session.commit()

    paused = (await client.post(f"/api/monitors/{monitor['id']}/pause", headers=auth)).json()
    assert (paused["status"], paused["is_active"], paused["consecutive_failures"]) == ("paused", False, 0)
    async with SessionLocal() as session:
        incident = await session.scalar(select(Incident))
        assert incident.resolved_at is not None

    resumed = (await client.post(f"/api/monitors/{monitor['id']}/resume", headers=auth)).json()
    assert (resumed["status"], resumed["is_active"]) == ("pending", True)


async def test_delete_cascades(client: AsyncClient, auth, make_monitor):
    monitor = await make_monitor()
    await add_checks(monitor["id"], [(datetime.now(UTC), True, 120)])
    assert (await client.delete(f"/api/monitors/{monitor['id']}", headers=auth)).status_code == 204
    assert (await client.get(f"/api/monitors/{monitor['id']}", headers=auth)).status_code == 404


async def test_checks_keyset_pagination(client: AsyncClient, auth, make_monitor):
    monitor = await make_monitor()
    now = datetime.now(UTC)
    await add_checks(monitor["id"], [(now - timedelta(minutes=i), i % 4 != 0, 100 + i) for i in range(10)])
    first = (await client.get(f"/api/monitors/{monitor['id']}/checks?limit=4", headers=auth)).json()
    second = (
        await client.get(f"/api/monitors/{monitor['id']}/checks?limit=4&before={first[-1]['id']}", headers=auth)
    ).json()
    assert [c["id"] for c in first] == [10, 9, 8, 7]
    assert [c["id"] for c in second] == [6, 5, 4, 3]
    failed = (await client.get(f"/api/monitors/{monitor['id']}/checks?failed=true", headers=auth)).json()
    assert {c["ok"] for c in failed} == {False}
    assert len(failed) == 3


async def test_incident_list(client: AsyncClient, auth, make_monitor):
    monitor = await make_monitor()
    now = datetime.now(UTC)
    async with SessionLocal() as session:
        session.add_all(
            [
                Incident(
                    monitor_id=monitor["id"],
                    started_at=now - timedelta(hours=3),
                    resolved_at=now - timedelta(hours=2),
                    cause="Timed out",
                ),
                Incident(monitor_id=monitor["id"], started_at=now - timedelta(minutes=10), cause="HTTP 503"),
            ]
        )
        await session.commit()
    everything = (await client.get("/api/incidents", headers=auth)).json()
    assert [i["cause"] for i in everything] == ["HTTP 503", "Timed out"]
    assert everything[1]["duration_seconds"] == 3600
    assert everything[0]["monitor_name"] == "API"
    open_ = (await client.get("/api/incidents?state=open", headers=auth)).json()
    assert [i["cause"] for i in open_] == ["HTTP 503"]
    resolved = (await client.get("/api/incidents?state=resolved", headers=auth)).json()
    assert [i["cause"] for i in resolved] == ["Timed out"]
