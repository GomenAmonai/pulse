"""Run the checker: `python -m app.worker`."""

import asyncio
import contextlib
import logging
import signal

import httpx

from app.config import get_settings
from app.db import SessionLocal, engine
from app.redis import close_redis
from app.worker.runner import Worker


async def main() -> None:
    settings = get_settings()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        # Not available on Windows' default loop; Ctrl+C still raises KeyboardInterrupt there.
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop.set)

    limits = httpx.Limits(max_connections=settings.worker_concurrency, max_keepalive_connections=20)
    async with httpx.AsyncClient(limits=limits, headers={"User-Agent": settings.user_agent}, timeout=10) as client:
        try:
            await Worker(SessionLocal, client, settings).run(stop)
        finally:
            await close_redis()
            await engine.dispose()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per check is too chatty
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
