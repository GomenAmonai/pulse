from redis.asyncio import Redis

from app.config import get_settings

_client: Redis | None = None


def get_redis() -> Redis | None:
    """Shared client, or None when REDIS_URL is not configured."""
    global _client
    url = get_settings().redis_url
    if url is None:
        return None
    if _client is None:
        _client = Redis.from_url(str(url), decode_responses=True)
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
