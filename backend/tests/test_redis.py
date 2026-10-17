"""The Redis-backed paths of the rate limiter and the event broker, on fakeredis."""

import ipaddress

import pytest
from fakeredis import FakeAsyncRedis
from httpx import AsyncClient

from app import events, ratelimit
from app.config import get_settings
from app.targets import TargetError, ensure_public
from app.targets import resolve as real_resolve


@pytest.fixture
def redis(monkeypatch) -> FakeAsyncRedis:
    fake = FakeAsyncRedis(decode_responses=True)
    monkeypatch.setattr(ratelimit, "get_redis", lambda: fake)
    monkeypatch.setattr(events, "get_redis", lambda: fake)
    return fake


async def test_rate_limit_counter_is_shared_in_redis(client: AsyncClient, redis):
    body = {"email": "a@example.com", "password": "whatever-1"}
    statuses = [(await client.post("/api/auth/login", json=body)).status_code for _ in range(11)]
    assert statuses[-1] == 429
    assert await redis.get("pulse:rl:login:203.0.113.10") == "11"
    assert 0 < await redis.ttl("pulse:rl:login:203.0.113.10") <= 60


async def test_pubsub_round_trip(redis):
    async with events.subscribe(5) as subscription:
        await events.publish(5, "check", {"monitor_id": 1})
        assert await subscription.next(1) == '{"event": "check", "data": {"monitor_id": 1}}'
        assert await subscription.next(0.01) is None
    assert await redis.pubsub_numsub(events.channel(5)) == [(events.channel(5), 0)]


async def test_real_resolver():
    assert await real_resolve("127.0.0.1") == [ipaddress.ip_address("127.0.0.1")]
    assert all(a.is_loopback for a in await real_resolve("localhost"))


async def test_private_targets_allowed_in_dev(monkeypatch):
    monkeypatch.setattr(get_settings(), "allow_private_targets", True)
    await ensure_public("http://127.0.0.1:8000/")
    monkeypatch.setattr(get_settings(), "allow_private_targets", False)
    with pytest.raises(TargetError, match="no host"):
        await ensure_public("http:///path")
