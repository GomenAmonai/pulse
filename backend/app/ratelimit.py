"""Fixed-window rate limiting keyed by client IP.

With Redis the counter is shared by every API process (INCR + EXPIRE in one pipeline);
without it each process keeps its own window in memory.
"""

import math
import time

from fastapi import Request

from app.errors import RateLimited
from app.redis import get_redis


class _MemoryWindow:
    def __init__(self) -> None:
        self._hits: dict[str, tuple[int, float]] = {}

    def hit(self, key: str, window: int) -> tuple[int, float]:
        now = time.monotonic()
        count, reset_at = self._hits.get(key, (0, now + window))
        if now >= reset_at:
            count, reset_at = 0, now + window
        count += 1
        self._hits[key] = (count, reset_at)
        if len(self._hits) > 10_000:  # drop expired windows now and then
            self._hits = {k: v for k, v in self._hits.items() if v[1] > now}
        return count, reset_at - now

    def clear(self) -> None:
        self._hits.clear()


memory = _MemoryWindow()


def client_ip(request: Request) -> str:
    # Behind a proxy run uvicorn with --proxy-headers so request.client is the real address.
    return request.client.host if request.client else "unknown"


class RateLimit:
    """Dependency: `Depends(RateLimit("login", limit=10, window=60))`."""

    def __init__(self, scope: str, limit: int, window: int = 60):
        self.scope, self.limit, self.window = scope, limit, window

    async def __call__(self, request: Request) -> None:
        key = f"pulse:rl:{self.scope}:{client_ip(request)}"
        redis = get_redis()
        if redis is not None:
            async with redis.pipeline(transaction=True) as pipe:
                pipe.incr(key)
                pipe.expire(key, self.window, nx=True)
                pipe.ttl(key)
                count, _, ttl = await pipe.execute()
            retry_after = max(int(ttl), 1)
        else:
            count, remaining = memory.hit(key, self.window)
            retry_after = max(math.ceil(remaining), 1)
        if count > self.limit:
            raise RateLimited("Too many requests. Try again later.", headers={"Retry-After": str(retry_after)})
