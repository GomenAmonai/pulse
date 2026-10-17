"""The SQL aggregates against values computed by hand in Python."""

from datetime import UTC, date, datetime, timedelta

from app.db import SessionLocal
from app.models import Incident
from app.services import stats
from tests.factories import NOW, add_checks


def percentile_cont(values: list[int], q: float) -> float:
    """PostgreSQL's percentile_cont: linear interpolation between the closest ranks."""
    ordered = sorted(values)
    position = q * (len(ordered) - 1)
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


async def test_summary_windows(make_monitor):
    monitor = await make_monitor()
    latencies = [80 + (i * 37) % 400 for i in range(100)]
    rows = [(NOW - timedelta(minutes=10 * i), True, latency) for i, latency in enumerate(latencies)]  # last ~16.5h
    rows += [(NOW - timedelta(minutes=5 + 10 * i), False, None) for i in range(4)]  # 4 failures in the last 24h
    rows += [(NOW - timedelta(days=3), False, None), (NOW - timedelta(days=3, minutes=1), True, 5000)]  # 7d only
    rows += [(NOW - timedelta(days=20), True, 10)]  # 30d only
    rows += [(NOW - timedelta(days=40), False, None)]  # outside every window
    rows += [(NOW + timedelta(minutes=1), False, None)]  # after "now": ignored
    await add_checks(monitor["id"], rows)

    async with SessionLocal() as session:
        result = (await stats.summary(session, [monitor["id"]], NOW))[monitor["id"]]

    day = result["24h"]
    assert day.checks == 104
    assert day.uptime == round(100 * 100 / 104, 3)
    assert day.p95_ms == round(percentile_cont(latencies, 0.95))
    assert day.avg_ms == round(sum(latencies) / len(latencies))

    week = result["7d"]
    assert week.checks == 106
    assert week.uptime == round(101 * 100 / 106, 3)
    assert week.p95_ms == round(percentile_cont([*latencies, 5000], 0.95))

    month = result["30d"]
    assert (month.checks, month.uptime) == (107, round(102 * 100 / 107, 3))


async def test_summary_for_monitor_without_checks(make_monitor):
    monitor = await make_monitor()
    async with SessionLocal() as session:
        result = await stats.summary(session, [monitor["id"]], NOW)
        assert await stats.summary(session, [], NOW) == {}
    assert result[monitor["id"]]["30d"] == stats.Window(0, None, None, None)


async def test_sparkline_is_hourly_and_keeps_gaps(make_monitor):
    monitor = await make_monitor()
    hour = NOW.replace(minute=0)
    await add_checks(
        monitor["id"],
        [
            (hour + timedelta(minutes=5), True, 100),
            (hour + timedelta(minutes=6), True, 300),
            (hour - timedelta(hours=2, minutes=-10), True, 50),
            (hour - timedelta(hours=2, minutes=-11), False, None),  # failures don't count towards latency
            (hour - timedelta(hours=30), True, 999),  # too old
        ],
    )
    async with SessionLocal() as session:
        line = (await stats.sparklines(session, [monitor["id"]], NOW))[monitor["id"]]
    assert len(line) == 24
    assert line[-1] == 200
    assert line[-3] == 50
    assert line.count(None) == 22


async def test_latency_buckets(make_monitor):
    monitor = await make_monitor()
    # Two 10-minute buckets: 12:10-12:20 with three checks and 12:20-12:30 with one failure.
    await add_checks(
        monitor["id"],
        [
            (datetime(2026, 10, 17, 12, 11, tzinfo=UTC), True, 100),
            (datetime(2026, 10, 17, 12, 13, tzinfo=UTC), True, 200),
            (datetime(2026, 10, 17, 12, 19, tzinfo=UTC), True, 900),
            (datetime(2026, 10, 17, 12, 25, tzinfo=UTC), False, None),
        ],
    )
    async with SessionLocal() as session:
        buckets = await stats.latency(session, monitor["id"], "24h", NOW)
    assert len(buckets) == 145  # 24h of 10-minute buckets, both ends included
    assert buckets[0].t == datetime(2026, 10, 16, 12, 30, tzinfo=UTC)
    assert buckets[-1].t == datetime(2026, 10, 17, 12, 30, tzinfo=UTC)
    full, failed = buckets[-3], buckets[-2]
    assert (full.checks, full.failures, full.avg_ms, full.p50_ms) == (3, 0, 400, 200)
    assert full.p95_ms == round(percentile_cont([100, 200, 900], 0.95))
    assert (failed.checks, failed.failures, failed.avg_ms) == (1, 1, None)
    assert sum(b.checks for b in buckets) == 4

    async with SessionLocal() as session:
        assert len(await stats.latency(session, monitor["id"], "7d", NOW)) == 169
        assert len(await stats.latency(session, monitor["id"], "30d", NOW)) == 121


async def test_daily_bars_with_incident_across_midnight(make_monitor):
    monitor = await make_monitor()
    await add_checks(
        monitor["id"],
        [
            (datetime(2026, 10, 16, 23, 0, tzinfo=UTC), True, 100),
            (datetime(2026, 10, 16, 23, 50, tzinfo=UTC), False, None),
            (datetime(2026, 10, 17, 0, 10, tzinfo=UTC), False, None),
            (datetime(2026, 10, 17, 1, 0, tzinfo=UTC), True, 100),
            (datetime(2026, 10, 17, 2, 0, tzinfo=UTC), True, 100),
        ],
    )
    async with SessionLocal() as session:
        session.add_all(
            [
                # 23:45 → 00:30: 15 minutes on the 16th, 30 on the 17th.
                Incident(
                    monitor_id=monitor["id"],
                    started_at=datetime(2026, 10, 16, 23, 45, tzinfo=UTC),
                    resolved_at=datetime(2026, 10, 17, 0, 30, tzinfo=UTC),
                    cause="503",
                ),
                # Still open: counts up to now (12:30).
                Incident(monitor_id=monitor["id"], started_at=datetime(2026, 10, 17, 12, 0, tzinfo=UTC), cause="503"),
            ]
        )
        await session.commit()
        bars = (await stats.daily(session, [monitor["id"]], NOW, 90))[monitor["id"]]

    assert len(bars) == 90
    assert bars[0].date == date(2026, 7, 20)
    yesterday, today = bars[-2], bars[-1]
    assert yesterday == stats.Day(date(2026, 10, 16), 2, 1, 50.0, 15 * 60, 1)
    assert today.date == date(2026, 10, 17)
    assert (today.checks, today.failures, today.incidents) == (3, 1, 2)
    assert today.downtime_seconds == 30 * 60 + 30 * 60
    assert bars[-3].uptime is None  # no data is not the same as 100%


async def test_monitor_endpoints_expose_stats(client, auth, make_monitor):
    monitor = await make_monitor()
    now = datetime.now(UTC)
    await add_checks(monitor["id"], [(now - timedelta(minutes=i), i != 3, 100 + i) for i in range(10)])
    summary = (await client.get("/api/monitors", headers=auth)).json()[0]
    assert summary["stats"]["24h"]["uptime"] == 90.0
    assert summary["stats"]["24h"]["checks"] == 10
    latency = (await client.get(f"/api/monitors/{monitor['id']}/latency?range=7d", headers=auth)).json()
    assert sum(p["checks"] for p in latency) == 10
    uptime = (await client.get(f"/api/monitors/{monitor['id']}/uptime?days=30", headers=auth)).json()
    assert len(uptime) == 30
    assert (await client.get(f"/api/monitors/{monitor['id']}/latency?range=1y", headers=auth)).status_code == 422
