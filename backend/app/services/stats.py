"""Uptime and latency, computed in PostgreSQL.

Every function takes a batch of monitor ids, so a dashboard with 25 monitors costs one
query per widget instead of one per monitor. Gaps are filled with generate_series, which
means a bucket with no checks comes back as an explicit empty bucket (a grey bar), not a
missing row the client has to guess about.
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Literal

from sqlalchemy import ARRAY, DateTime, Integer, Interval, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

Range = Literal["24h", "7d", "30d"]

# Bucket width per chart range: ~100-170 points, enough for a smooth line.
RANGES: dict[Range, tuple[timedelta, timedelta]] = {
    "24h": (timedelta(hours=24), timedelta(minutes=10)),
    "7d": (timedelta(days=7), timedelta(hours=1)),
    "30d": (timedelta(days=30), timedelta(hours=6)),
}

# Typed binds: the asyncpg dialect renders them as $1::INTEGER[], $2::TIMESTAMPTZ, so
# overloaded functions such as date_trunc() know which variant to use.
_ids = bindparam("ids", type_=ARRAY(Integer))
_id = bindparam("id", type_=Integer)
_now = bindparam("now", type_=DateTime(timezone=True))
_since = bindparam("since", type_=DateTime(timezone=True))
_step = bindparam("step", type_=Interval)
_days = bindparam("days", type_=Integer)


def _pct(ok: int, total: int) -> float | None:
    return round(ok * 100 / total, 3) if total else None


def _ms(value: float | None) -> int | None:
    return None if value is None else round(value)


@dataclass(frozen=True, slots=True)
class Window:
    checks: int
    uptime: float | None
    avg_ms: int | None
    p95_ms: int | None


_SUMMARY = text(
    """
    SELECT monitor_id,
           count(*) FILTER (WHERE checked_at >= :now - interval '24 hours') AS checks_24h,
           count(*) FILTER (WHERE ok AND checked_at >= :now - interval '24 hours') AS ok_24h,
           avg(latency_ms) FILTER (WHERE ok AND checked_at >= :now - interval '24 hours') AS avg_24h,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
               FILTER (WHERE ok AND checked_at >= :now - interval '24 hours') AS p95_24h,
           count(*) FILTER (WHERE checked_at >= :now - interval '7 days') AS checks_7d,
           count(*) FILTER (WHERE ok AND checked_at >= :now - interval '7 days') AS ok_7d,
           avg(latency_ms) FILTER (WHERE ok AND checked_at >= :now - interval '7 days') AS avg_7d,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
               FILTER (WHERE ok AND checked_at >= :now - interval '7 days') AS p95_7d,
           count(*) AS checks_30d,
           count(*) FILTER (WHERE ok) AS ok_30d,
           avg(latency_ms) FILTER (WHERE ok) AS avg_30d,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok) AS p95_30d
    FROM checks
    WHERE monitor_id = ANY(:ids)
      AND checked_at >= :now - interval '30 days'
      AND checked_at <= :now
    GROUP BY monitor_id
    """
).bindparams(_ids, _now)


async def summary(session: AsyncSession, ids: list[int], now: datetime) -> dict[int, dict[str, Window]]:
    """Uptime %, average and p95 latency over 24h / 7d / 30d. Latency counts successful checks only."""
    empty = {key: Window(0, None, None, None) for key in ("24h", "7d", "30d")}
    result: dict[int, dict[str, Window]] = {i: dict(empty) for i in ids}
    if not ids:
        return result
    for row in (await session.execute(_SUMMARY, {"ids": ids, "now": now})).mappings():
        result[row["monitor_id"]] = {
            key: Window(
                checks=row[f"checks_{key}"],
                uptime=_pct(row[f"ok_{key}"], row[f"checks_{key}"]),
                avg_ms=_ms(row[f"avg_{key}"]),
                p95_ms=_ms(row[f"p95_{key}"]),
            )
            for key in ("24h", "7d", "30d")
        }
    return result


_SPARKLINES = text(
    """
    WITH buckets AS (
        SELECT m.id AS monitor_id, b.bucket
        FROM unnest(:ids) AS m(id)
        CROSS JOIN generate_series(
            date_trunc('hour', :now) - interval '23 hours', date_trunc('hour', :now), interval '1 hour'
        ) AS b(bucket)
    ),
    hourly AS (
        SELECT monitor_id, date_trunc('hour', checked_at) AS bucket, avg(latency_ms) FILTER (WHERE ok) AS avg_ms
        FROM checks
        WHERE monitor_id = ANY(:ids) AND checked_at >= date_trunc('hour', :now) - interval '23 hours'
        GROUP BY 1, 2
    )
    SELECT buckets.monitor_id, hourly.avg_ms
    FROM buckets LEFT JOIN hourly USING (monitor_id, bucket)
    ORDER BY buckets.monitor_id, buckets.bucket
    """
).bindparams(_ids, _now)


async def sparklines(session: AsyncSession, ids: list[int], now: datetime) -> dict[int, list[int | None]]:
    """Average latency per hour for the last 24 hours, oldest first."""
    result: dict[int, list[int | None]] = {i: [] for i in ids}
    if ids:
        for monitor_id, avg_ms in await session.execute(_SPARKLINES, {"ids": ids, "now": now}):
            result[monitor_id].append(_ms(avg_ms))
    return result


@dataclass(frozen=True, slots=True)
class LatencyBucket:
    t: datetime
    checks: int
    failures: int
    avg_ms: int | None
    p50_ms: int | None
    p95_ms: int | None


_LATENCY = text(
    """
    WITH binned AS (
        SELECT date_bin(:step, checked_at, timestamptz '2000-01-01') AS bucket,
               count(*) AS checks,
               count(*) FILTER (WHERE NOT ok) AS failures,
               avg(latency_ms) FILTER (WHERE ok) AS avg_ms,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok) AS p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok) AS p95_ms
        FROM checks
        WHERE monitor_id = :id AND checked_at >= :since AND checked_at <= :now
        GROUP BY 1
    )
    SELECT s.bucket, coalesce(binned.checks, 0), coalesce(binned.failures, 0),
           binned.avg_ms, binned.p50_ms, binned.p95_ms
    FROM generate_series(
        date_bin(:step, :since, timestamptz '2000-01-01'),
        date_bin(:step, :now, timestamptz '2000-01-01'),
        :step
    ) AS s(bucket)
    LEFT JOIN binned USING (bucket)
    ORDER BY s.bucket
    """
).bindparams(_id, _now, _since, _step)


async def latency(session: AsyncSession, monitor_id: int, range_: Range, now: datetime) -> list[LatencyBucket]:
    span, step = RANGES[range_]
    rows = await session.execute(_LATENCY, {"id": monitor_id, "now": now, "since": now - span, "step": step})
    return [
        LatencyBucket(t, checks, failures, _ms(avg_ms), _ms(p50), _ms(p95))
        for t, checks, failures, avg_ms, p50, p95 in rows
    ]


@dataclass(frozen=True, slots=True)
class Day:
    date: date
    checks: int
    failures: int
    uptime: float | None
    downtime_seconds: int
    incidents: int


_DAILY = text(
    """
    WITH days AS (
        SELECT m.id AS monitor_id, d.day
        FROM unnest(:ids) AS m(id)
        CROSS JOIN generate_series(
            date_trunc('day', :now) - (:days - 1) * interval '1 day', date_trunc('day', :now), interval '1 day'
        ) AS d(day)
    ),
    per_day AS (
        SELECT monitor_id, date_trunc('day', checked_at) AS day,
               count(*) AS checks, count(*) FILTER (WHERE NOT ok) AS failures
        FROM checks
        WHERE monitor_id = ANY(:ids) AND checked_at >= date_trunc('day', :now) - (:days - 1) * interval '1 day'
        GROUP BY 1, 2
    ),
    -- Downtime is the overlap of each incident with the day, so an outage across midnight
    -- is split between both days and an ongoing one counts up to now.
    downtime AS (
        SELECT days.monitor_id, days.day, count(*) AS incidents,
               sum(extract(epoch FROM
                   least(coalesce(i.resolved_at, :now), days.day + interval '1 day')
                   - greatest(i.started_at, days.day)
               )) AS seconds
        FROM days
        JOIN incidents i
          ON i.monitor_id = days.monitor_id
         AND i.started_at < days.day + interval '1 day'
         AND coalesce(i.resolved_at, :now) > days.day
        GROUP BY 1, 2
    )
    SELECT days.monitor_id, days.day::date, coalesce(per_day.checks, 0), coalesce(per_day.failures, 0),
           coalesce(downtime.seconds, 0), coalesce(downtime.incidents, 0)
    FROM days
    LEFT JOIN per_day USING (monitor_id, day)
    LEFT JOIN downtime USING (monitor_id, day)
    ORDER BY days.monitor_id, days.day
    """
).bindparams(_ids, _now, _days)


async def daily(session: AsyncSession, ids: list[int], now: datetime, days: int = 90) -> dict[int, list[Day]]:
    """One bar per UTC day, oldest first: uptime from checks, downtime from incidents."""
    result: dict[int, list[Day]] = {i: [] for i in ids}
    if not ids:
        return result
    rows = await session.execute(_DAILY, {"ids": ids, "now": now, "days": days})
    for monitor_id, day, checks, failures, seconds, incidents in rows:
        result[monitor_id].append(
            Day(day, checks, failures, _pct(checks - failures, checks), round(seconds), incidents)
        )
    return result
