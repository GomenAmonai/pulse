"""Live events from the worker to dashboards.

The worker publishes one JSON message per check and per incident change to the owner's
Redis channel; each API process subscribes for the users it is streaming to. Without
Redis an in-process broker is used, which is what tests and single-process dev runs need.
"""

import asyncio
import json
from collections import defaultdict
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any, Protocol

from app.redis import get_redis


def channel(user_id: int) -> str:
    return f"pulse:events:{user_id}"


class Subscription(Protocol):
    async def next(self, wait: float) -> str | None:
        """The next raw JSON message, or None if nothing arrived within `wait` seconds."""
        ...


class _QueueSubscription:
    def __init__(self, queue: asyncio.Queue[str]) -> None:
        self.queue = queue

    async def next(self, wait: float) -> str | None:
        try:
            return await asyncio.wait_for(self.queue.get(), wait)
        except TimeoutError:
            return None


class _RedisSubscription:
    def __init__(self, pubsub: Any) -> None:
        self.pubsub = pubsub

    async def next(self, wait: float) -> str | None:
        # get_message() returns None for the subscribe confirmation too, so keep reading
        # until a real message arrives or the time is up.
        loop = asyncio.get_running_loop()
        deadline = loop.time() + wait
        while (remaining := deadline - loop.time()) > 0:
            message = await self.pubsub.get_message(ignore_subscribe_messages=True, timeout=remaining)
            if message is not None:
                return message["data"]
        return None


class MemoryBroker:
    def __init__(self) -> None:
        self._queues: dict[str, set[asyncio.Queue[str]]] = defaultdict(set)

    def publish(self, name: str, message: str) -> None:
        for queue in self._queues.get(name, ()):
            if not queue.full():  # a stalled client loses events rather than memory
                queue.put_nowait(message)

    @asynccontextmanager
    async def subscribe(self, name: str) -> AsyncIterator[asyncio.Queue[str]]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=1000)
        self._queues[name].add(queue)
        try:
            yield queue
        finally:
            self._queues[name].discard(queue)
            if not self._queues[name]:
                del self._queues[name]


memory_broker = MemoryBroker()


async def publish(user_id: int, event: str, data: dict[str, Any]) -> None:
    message = json.dumps({"event": event, "data": data}, default=str)
    redis = get_redis()
    if redis is not None:
        await redis.publish(channel(user_id), message)
    else:
        memory_broker.publish(channel(user_id), message)


@asynccontextmanager
async def subscribe(user_id: int) -> AsyncIterator[Subscription]:
    redis = get_redis()
    if redis is None:
        async with memory_broker.subscribe(channel(user_id)) as queue:
            yield _QueueSubscription(queue)
        return

    pubsub = redis.pubsub()
    await pubsub.subscribe(channel(user_id))
    try:
        yield _RedisSubscription(pubsub)
    finally:
        await pubsub.unsubscribe()
        await pubsub.aclose()


async def sse_stream(user_id: int, heartbeat: float = 15.0) -> AsyncIterator[str]:
    """Server-sent events for one user, with a comment line as keep-alive for proxies."""
    async with subscribe(user_id) as subscription:
        yield "retry: 3000\n: connected\n\n"
        while True:
            raw = await subscription.next(heartbeat)
            if raw is None:
                yield ": ping\n\n"
                continue
            message = json.loads(raw)
            yield f"event: {message['event']}\ndata: {json.dumps(message['data'])}\n\n"
