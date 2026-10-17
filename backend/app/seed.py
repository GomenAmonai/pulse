"""Demo account with real monitors and 90 days of synthetic history: `python -m app.seed`.

Idempotent: does nothing if the demo user already exists.
"""

import asyncio
import random
from datetime import UTC, datetime, timedelta

from sqlalchemy import DateTime, Integer, bindparam, select, text

from app.db import SessionLocal, engine
from app.models import Incident, Monitor, StatusPage, User
from app.security import hash_password

DEMO_EMAIL = "demo@pulse.dev"
DEMO_PASSWORD = "pulse-demo-2026"

# name, url, expected status, timeout, typical latency (ms)
MONITORS = [
    ("Website", "https://example.com/", 200, 10, 120),
    ("GitHub API", "https://api.github.com/", 200, 10, 180),
    ("Cloudflare DNS", "https://1.1.1.1/", 200, 10, 40),
    ("httpbin", "https://httpbin.org/get", 200, 10, 350),
    # Always fails, so a fresh install shows an incident opening within three checks.
    ("Payments (broken on purpose)", "https://httpbin.org/status/503", 200, 10, 300),
]

BACKFILL = text(
    """
    INSERT INTO checks (monitor_id, checked_at, ok, status_code, latency_ms, error)
    SELECT :id, ts, true, 200, greatest(5, round(:base * (0.7 + random() * 0.6 + power(random(), 12) * 4)))::int, NULL
    FROM generate_series(:start, :end, interval '5 minutes') AS ts
    """
).bindparams(
    bindparam("id", type_=Integer),
    bindparam("base", type_=Integer),
    bindparam("start", type_=DateTime(timezone=True)),
    bindparam("end", type_=DateTime(timezone=True)),
)

OUTAGE = text(
    """
    UPDATE checks SET ok = false, status_code = 503, latency_ms = NULL, error = 'Expected HTTP 200, got 503'
    WHERE monitor_id = :id AND checked_at >= :start AND checked_at < :end
    """
).bindparams(bindparam("start", type_=DateTime(timezone=True)), bindparam("end", type_=DateTime(timezone=True)))


async def seed() -> None:
    async with SessionLocal() as session:
        if await session.scalar(select(User).where(User.email == DEMO_EMAIL)):
            print("demo data already present")
            return
        user = User(email=DEMO_EMAIL, password_hash=hash_password(DEMO_PASSWORD))
        session.add(user)
        await session.flush()
        page = StatusPage(owner_id=user.id, slug="acme", title="Acme", description="Status of Acme services")
        session.add(page)
        await session.flush()

        now = datetime.now(UTC).replace(second=0, microsecond=0)
        rng = random.Random(42)
        for position, (name, url, expected, timeout, base) in enumerate(MONITORS):
            monitor = Monitor(
                owner_id=user.id,
                status_page_id=page.id,
                position=position,
                name=name,
                url=url,
                expected_status=expected,
                timeout_seconds=timeout,
                created_at=now - timedelta(days=90),
            )
            session.add(monitor)
            await session.flush()
            await session.execute(
                BACKFILL,
                {"id": monitor.id, "base": base, "start": now - timedelta(days=90), "end": now - timedelta(minutes=5)},
            )
            # A couple of resolved outages per monitor, so the 90-day bars have some colour.
            for _ in range(rng.randint(0, 3)):
                start = now - timedelta(days=rng.uniform(1, 89))
                end = start + timedelta(minutes=rng.choice([10, 15, 25, 45, 90]))
                await session.execute(OUTAGE, {"id": monitor.id, "start": start, "end": end})
                session.add(
                    Incident(
                        monitor_id=monitor.id, started_at=start, resolved_at=end, cause="Expected HTTP 200, got 503"
                    )
                )
        await session.commit()
        print(f"seeded {DEMO_EMAIL} / {DEMO_PASSWORD}, status page /status/acme")


async def main() -> None:
    try:
        await seed()
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
