import ipaddress
import os
from collections.abc import AsyncIterator, Callable

# Settings are read on first import, so the test database must be chosen before app.*.
os.environ.setdefault("DATABASE_URL", "postgresql+asyncpg://pulse:pulse@localhost:5432/pulse_test")
os.environ.pop("REDIS_URL", None)  # in-process rate limiter and event broker

import httpx
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text

from app import ratelimit, targets
from app.db import Base, engine
from app.main import app
from tests.factories import register

TABLES = ", ".join(t.name for t in Base.metadata.sorted_tables)

# Fake DNS so tests never depend on the network: public names resolve to public addresses,
# the "internal" ones to private ranges.
DNS = {
    "example.com": "93.184.215.14",
    "api.example.com": "93.184.215.15",
    "hooks.example.com": "93.184.215.16",
    "internal.example.com": "10.0.0.7",
    "metadata.example.com": "169.254.169.254",
}


@pytest.fixture(scope="session", autouse=True)
async def database() -> AsyncIterator[None]:
    """A clean schema built by the real migrations, once per run."""

    def upgrade(connection) -> None:
        config = Config("alembic.ini")
        config.attributes["connection"] = connection
        command.upgrade(config, "head")

    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA public CASCADE"))
        await conn.execute(text("CREATE SCHEMA public"))
        await conn.run_sync(upgrade)
    yield
    await engine.dispose()


@pytest.fixture(autouse=True)
async def clean() -> AsyncIterator[None]:
    yield
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE {TABLES} RESTART IDENTITY CASCADE"))
    ratelimit.memory.clear()


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    async def resolve(host: str):
        try:
            return [ipaddress.ip_address(host)]
        except ValueError:
            pass
        if host not in DNS:
            raise targets.TargetError(f"Can't resolve {host}")
        return [ipaddress.ip_address(DNS[host])]

    monkeypatch.setattr(targets, "resolve", resolve)


@pytest.fixture
async def client() -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app, client=("203.0.113.10", 50000))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture
async def auth(client: httpx.AsyncClient) -> dict[str, str]:
    return await register(client)


@pytest.fixture
def make_monitor(client: httpx.AsyncClient, auth: dict[str, str]) -> Callable:
    async def make(**fields) -> dict:
        body = {"name": "API", "url": "https://api.example.com/health"} | fields
        response = await client.post("/api/monitors", json=body, headers=auth)
        assert response.status_code == 201, response.text
        return response.json()

    return make
