"""Helpers shared by the tests (fixtures live in conftest.py)."""

from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import insert

from app.db import SessionLocal
from app.models import Check

NOW = datetime(2026, 10, 17, 12, 30, tzinfo=UTC)


async def register(client: httpx.AsyncClient, email: str = "owner@example.com") -> dict[str, str]:
    response = await client.post("/api/auth/register", json={"email": email, "password": "correct-horse"})
    assert response.status_code == 201, response.text
    return {"Authorization": f"Bearer {response.json()['access']}"}


async def add_checks(monitor_id: int, rows: Iterable[tuple[datetime, bool, int | None]]) -> None:
    """Bulk-insert checks as (checked_at, ok, latency_ms)."""
    values = [
        {
            "monitor_id": monitor_id,
            "checked_at": at,
            "ok": ok,
            "latency_ms": latency,
            "status_code": 200 if ok else 503,
            "error": None if ok else "Expected HTTP 200, got 503",
        }
        for at, ok, latency in rows
    ]
    async with SessionLocal() as session:
        await session.execute(insert(Check), values)
        await session.commit()


def minutes_ago(now: datetime, minutes: float) -> datetime:
    return now - timedelta(minutes=minutes)
