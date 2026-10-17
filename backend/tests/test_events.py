import asyncio

from httpx import AsyncClient

from app import events


async def test_sse_stream_formats_events_and_keeps_alive():
    stream = events.sse_stream(user_id=7, heartbeat=0.05)
    assert await anext(stream) == "retry: 3000\n: connected\n\n"
    assert await anext(stream) == ": ping\n\n"  # nothing published within the heartbeat

    next_chunk = asyncio.ensure_future(anext(stream))
    await asyncio.sleep(0)
    await events.publish(7, "incident.opened", {"monitor_id": 1})
    await events.publish(8, "check", {"monitor_id": 2})  # someone else's
    assert await next_chunk == 'event: incident.opened\ndata: {"monitor_id": 1}\n\n'
    await stream.aclose()
    assert events.memory_broker._queues == {}  # the subscription is cleaned up on disconnect


async def test_events_are_isolated_per_user():
    async with events.subscribe(1) as mine:
        await events.publish(2, "check", {})
        assert await mine.next(0.05) is None
        await events.publish(1, "check", {"ok": True})
        assert await mine.next(0.05) == '{"event": "check", "data": {"ok": true}}'


async def test_stream_requires_auth(client: AsyncClient):
    response = await client.get("/api/stream")
    assert response.status_code == 401


async def test_health(client: AsyncClient):
    assert (await client.get("/api/health")).json() == {"status": "ok"}
