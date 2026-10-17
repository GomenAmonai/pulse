from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from app.api.pages import overall
from app.db import SessionLocal
from app.models import Incident, Monitor, MonitorStatus
from tests.factories import add_checks, register


@pytest.fixture
async def page(client: AsyncClient, auth) -> dict:
    response = await client.post(
        "/api/status-pages", json={"slug": "acme", "title": "Acme", "description": "Our services"}, headers=auth
    )
    assert response.status_code == 201
    return response.json()


async def test_public_page(client: AsyncClient, page, make_monitor):
    api = await make_monitor(name="API", status_page_id=page["id"])
    web = await make_monitor(name="Website", url="https://example.com", status_page_id=page["id"])
    await make_monitor(name="Internal cron")  # not on the page
    now = datetime.now(UTC)
    await add_checks(api["id"], [(now - timedelta(minutes=i), i != 0, 120) for i in range(4)])
    async with SessionLocal() as session:
        (await session.get(Monitor, api["id"])).status = MonitorStatus.DOWN
        (await session.get(Monitor, web["id"])).status = MonitorStatus.UP
        session.add(Incident(monitor_id=api["id"], started_at=now - timedelta(minutes=3), cause="secret stack trace"))
        session.add(
            Incident(
                monitor_id=web["id"],
                started_at=now - timedelta(days=30),
                resolved_at=now - timedelta(days=30) + timedelta(minutes=5),
                cause="old",
            )
        )
        await session.commit()

    response = await client.get("/api/status/acme")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "public, max-age=15"
    body = response.json()
    assert (body["title"], body["status"]) == ("Acme", "partial_outage")
    assert [m["name"] for m in body["monitors"]] == ["API", "Website"]
    first = body["monitors"][0]
    assert set(first) == {"id", "name", "status", "uptime_90d", "days"}  # no URL, no internals
    assert first["uptime_90d"] == 75.0
    assert len(first["days"]) == 90
    # Only recent incidents, and without the raw error text.
    assert len(body["incidents"]) == 1
    assert "cause" not in body["incidents"][0]
    assert body["incidents"][0]["resolved_at"] is None


async def test_unknown_page(client: AsyncClient):
    response = await client.get("/api/status/nope")
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


async def test_slug_is_unique_and_validated(client: AsyncClient, page):
    other = await register(client, "other@example.com")
    taken = await client.post("/api/status-pages", json={"slug": "acme", "title": "Mine"}, headers=other)
    assert taken.status_code == 409
    assert taken.json()["code"] == "slug_taken"
    bad = await client.post("/api/status-pages", json={"slug": "Not A Slug", "title": "x"}, headers=other)
    assert bad.status_code == 422


async def test_cannot_attach_monitor_to_someone_elses_page(client: AsyncClient, page):
    other = await register(client, "other@example.com")
    response = await client.post(
        "/api/monitors",
        json={"name": "x", "url": "https://example.com", "status_page_id": page["id"]},
        headers=other,
    )
    assert response.status_code == 404


async def test_page_crud(client: AsyncClient, auth, page, make_monitor):
    await make_monitor(status_page_id=page["id"])
    listed = (await client.get("/api/status-pages", headers=auth)).json()
    assert listed == [page | {"monitor_ids": [1]}]
    updated = await client.patch(f"/api/status-pages/{page['id']}", json={"title": "Acme Inc."}, headers=auth)
    assert updated.json()["title"] == "Acme Inc."
    assert (await client.delete(f"/api/status-pages/{page['id']}", headers=auth)).status_code == 204
    # The monitor survives, detached.
    assert (await client.get("/api/monitors/1", headers=auth)).json()["status_page_id"] is None


async def test_public_page_is_rate_limited(client: AsyncClient, page, monkeypatch):
    from app.api import pages

    limiter = next(d.dependency for d in pages.router.routes[-1].dependencies)
    monkeypatch.setattr(limiter, "limit", 3)
    statuses = [(await client.get("/api/status/acme")).status_code for _ in range(4)]
    assert statuses == [200, 200, 200, 429]


@pytest.mark.parametrize(
    ("statuses", "expected"),
    [
        ([], "unknown"),
        (["pending", "paused"], "unknown"),
        (["up", "up", "pending"], "operational"),
        (["up", "down"], "partial_outage"),
        (["down", "down", "paused"], "major_outage"),
    ],
)
def test_overall_status(statuses, expected):
    assert overall([MonitorStatus(s) for s in statuses]) == expected
