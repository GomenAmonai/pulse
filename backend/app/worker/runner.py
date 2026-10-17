"""The check scheduler.

Every tick the worker claims due monitors in one statement:

    UPDATE monitors SET next_check_at = now + interval
    WHERE id IN (SELECT id ... WHERE next_check_at <= now FOR UPDATE SKIP LOCKED LIMIT n)
    RETURNING ...

so several worker replicas can run side by side without checking the same monitor twice,
and a monitor is rescheduled before its request starts (a slow target can't pile up
checks). Requests run concurrently, bounded by a semaphore. Each result is stored
together with the state machine step under a row lock on the monitor, then live events
and notifications go out after the commit.
"""

import asyncio
import contextlib
import logging
from dataclasses import asdict
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app import events
from app.config import Settings, get_settings
from app.models import Channel, Check, Incident, Monitor
from app.notifier import Notice, broadcast
from app.services.flapping import Action, State, step
from app.worker.checker import Result, Target, perform

log = logging.getLogger("pulse.worker")

RETENTION_LOCK = 0x50554C5345  # "PULSE": advisory lock id, one pruner at a time
RETENTION_BATCH = 10_000


async def claim_due(session: AsyncSession, now: datetime, limit: int) -> list[Target]:
    due = (
        select(Monitor.id)
        .where(Monitor.is_active, Monitor.next_check_at <= now)
        .order_by(Monitor.next_check_at)
        .limit(limit)
        .with_for_update(skip_locked=True)
        .scalar_subquery()
    )
    stmt = (
        update(Monitor)
        .where(Monitor.id.in_(due))
        .values(next_check_at=now + func.make_interval(0, 0, 0, 0, 0, 0, Monitor.interval_seconds))
        .returning(
            Monitor.id,
            Monitor.owner_id,
            Monitor.url,
            Monitor.method,
            Monitor.timeout_seconds,
            Monitor.expected_status,
        )
        .execution_options(synchronize_session=False)
    )
    rows = (await session.execute(stmt)).all()
    await session.commit()
    return [Target(r.id, r.owner_id, r.url, str(r.method), r.timeout_seconds, r.expected_status) for r in rows]


async def record(
    session: AsyncSession, target: Target, result: Result
) -> tuple[Monitor, Incident | None, Action | None] | None:
    """Store a check and advance the monitor's state. None if the monitor was paused or deleted meanwhile."""
    monitor = await session.get(Monitor, target.monitor_id, with_for_update=True)
    if monitor is None or not monitor.is_active:
        await session.rollback()
        return None

    session.add(
        Check(
            monitor_id=monitor.id,
            checked_at=result.checked_at,
            ok=result.ok,
            status_code=result.status_code,
            latency_ms=result.latency_ms,
            error=result.error,
        )
    )
    state, action = step(
        State(monitor.status, monitor.consecutive_failures, monitor.consecutive_successes),
        result.ok,
        failure_threshold=monitor.failure_threshold,
        recovery_threshold=monitor.recovery_threshold,
    )
    monitor.status = state.status
    monitor.consecutive_failures = state.failures
    monitor.consecutive_successes = state.successes
    monitor.last_checked_at = result.checked_at
    monitor.last_latency_ms = result.latency_ms
    if result.ok:
        monitor.failing_since = None
    elif monitor.failing_since is None:
        monitor.failing_since = result.checked_at

    incident: Incident | None = None
    if action is Action.OPEN:
        incident = Incident(
            monitor_id=monitor.id,
            started_at=monitor.failing_since or result.checked_at,
            cause=result.error or "Check failed",
        )
        session.add(incident)
    elif action is Action.RESOLVE:
        incident = await session.scalar(
            select(Incident).where(Incident.monitor_id == monitor.id, Incident.resolved_at.is_(None))
        )
        if incident is not None:
            incident.resolved_at = result.checked_at
    await session.commit()
    return monitor, incident, action


def check_event(monitor: Monitor, result: Result) -> dict:
    return {
        "monitor_id": monitor.id,
        "status": monitor.status,
        "check": asdict(result),
    }


def incident_event(monitor: Monitor, incident: Incident) -> dict:
    return {
        "id": incident.id,
        "monitor_id": monitor.id,
        "monitor_name": monitor.name,
        "started_at": incident.started_at,
        "resolved_at": incident.resolved_at,
        "cause": incident.cause,
    }


class Worker:
    def __init__(
        self,
        sessionmaker: async_sessionmaker[AsyncSession],
        client: httpx.AsyncClient,
        settings: Settings | None = None,
    ) -> None:
        self.sessionmaker = sessionmaker
        self.client = client
        self.settings = settings or get_settings()
        self.semaphore = asyncio.Semaphore(self.settings.worker_concurrency)
        self.in_flight: set[asyncio.Task] = set()
        self._last_prune: datetime | None = None

    async def process(self, target: Target) -> None:
        async with self.semaphore:
            result = await perform(self.client, target)
        async with self.sessionmaker() as session:
            recorded = await record(session, target, result)
            if recorded is None:
                return
            monitor, incident, action = recorded
            channels = []
            if action is not None:
                channels = list(
                    await session.scalars(
                        select(Channel).where(Channel.owner_id == monitor.owner_id, Channel.is_active)
                    )
                )

        await events.publish(monitor.owner_id, "check", check_event(monitor, result))
        if incident is None or action is None:
            return
        name = "incident.opened" if action is Action.OPEN else "incident.resolved"
        await events.publish(monitor.owner_id, name, incident_event(monitor, incident))
        log.info("%s: monitor %s (%s)", name, monitor.id, incident.cause)
        if channels:
            notice = Notice(
                event=name,
                monitor_id=monitor.id,
                monitor_name=monitor.name,
                monitor_url=monitor.url,
                incident_id=incident.id,
                started_at=incident.started_at,
                resolved_at=incident.resolved_at,
                cause=incident.cause,
            )
            await broadcast(self.client, channels, notice)

    def _spawn(self, target: Target) -> None:
        task = asyncio.create_task(self.process(target), name=f"check-{target.monitor_id}")
        self.in_flight.add(task)
        task.add_done_callback(self._done)

    def _done(self, task: asyncio.Task) -> None:
        self.in_flight.discard(task)
        if not task.cancelled() and task.exception() is not None:
            log.error("check task failed", exc_info=task.exception())

    async def tick(self, now: datetime | None = None) -> int:
        """Claim what is due and start checking it. Returns the number of monitors claimed."""
        # Claim only what can start soon: work claimed beyond capacity would sit behind the
        # semaphore while another replica could have taken it.
        free = self.settings.worker_concurrency * 2 - len(self.in_flight)
        if free <= 0:
            return 0
        async with self.sessionmaker() as session:
            targets = await claim_due(session, now or datetime.now(UTC), min(free, self.settings.worker_batch_size))
        for target in targets:
            self._spawn(target)
        return len(targets)

    async def prune(self, now: datetime) -> int:
        """Delete checks past retention in small batches; one replica at a time via an advisory lock."""
        cutoff = now - timedelta(days=self.settings.check_retention_days)
        deleted = 0
        async with self.sessionmaker() as session:
            while True:
                async with session.begin():
                    if not await session.scalar(select(func.pg_try_advisory_xact_lock(RETENTION_LOCK))):
                        return deleted
                    batch = select(Check.id).where(Check.checked_at < cutoff).limit(RETENTION_BATCH)
                    result = await session.execute(delete(Check).where(Check.id.in_(batch.scalar_subquery())))
                deleted += result.rowcount
                if result.rowcount < RETENTION_BATCH:
                    return deleted

    async def run(self, stop: asyncio.Event) -> None:
        log.info("worker started: concurrency=%s", self.settings.worker_concurrency)
        while not stop.is_set():
            now = datetime.now(UTC)
            try:
                await self.tick(now)
                if self._last_prune is None or now - self._last_prune > timedelta(hours=1):
                    self._last_prune = now
                    if pruned := await self.prune(now):
                        log.info("pruned %s old checks", pruned)
            except Exception:  # the database may be briefly unavailable; keep the loop alive
                log.exception("tick failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), self.settings.worker_tick_seconds)
        log.info("stopping, waiting for %s checks in flight", len(self.in_flight))
        if self.in_flight:
            await asyncio.wait(self.in_flight, timeout=35)
