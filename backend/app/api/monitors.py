from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response, status
from sqlalchemy import func, select, update

from app.config import get_settings
from app.deps import CurrentUser, Session
from app.errors import BlockedTarget, Invalid, MonitorLimit, NotFound
from app.models import Check, Incident, Monitor, MonitorStatus, StatusPage, User
from app.schemas import (
    CheckOut,
    DayOut,
    IncidentOut,
    LatencyPoint,
    MonitorIn,
    MonitorOut,
    MonitorPatch,
    MonitorSummary,
    WindowOut,
)
from app.services import stats
from app.targets import TargetError, ensure_public

router = APIRouter(prefix="/api", tags=["monitors"])


async def owned_monitor(session: Session, user: User, monitor_id: int, *, lock: bool = False) -> Monitor:
    stmt = select(Monitor).where(Monitor.id == monitor_id, Monitor.owner_id == user.id)
    if lock:
        stmt = stmt.with_for_update()
    monitor = await session.scalar(stmt)
    # Someone else's monitor is a 404, not a 403: ids don't leak what exists.
    if monitor is None:
        raise NotFound("Monitor not found.")
    return monitor


async def _check_target(url: str) -> None:
    try:
        await ensure_public(url)
    except TargetError as exc:
        raise BlockedTarget(str(exc)) from None


async def _check_page(session: Session, user: User, page_id: int | None) -> None:
    if (
        page_id is not None
        and await session.scalar(select(StatusPage.id).where(StatusPage.id == page_id, StatusPage.owner_id == user.id))
        is None
    ):
        raise NotFound("Status page not found.")


async def summarize(session: Session, monitors: list[Monitor]) -> list[MonitorSummary]:
    now = datetime.now(UTC)
    ids = [m.id for m in monitors]
    summary = await stats.summary(session, ids, now)
    lines = await stats.sparklines(session, ids, now)
    return [
        MonitorSummary(
            **MonitorOut.model_validate(m).model_dump(),
            stats={k: WindowOut.model_validate(w, from_attributes=True) for k, w in summary[m.id].items()},
            sparkline=lines[m.id],
        )
        for m in monitors
    ]


def incident_out(incident: Incident, monitor_name: str, now: datetime) -> IncidentOut:
    end = incident.resolved_at or now
    return IncidentOut(
        id=incident.id,
        monitor_id=incident.monitor_id,
        monitor_name=monitor_name,
        started_at=incident.started_at,
        resolved_at=incident.resolved_at,
        cause=incident.cause,
        duration_seconds=max(0, round((end - incident.started_at).total_seconds())),
    )


@router.get("/monitors")
async def list_monitors(session: Session, user: CurrentUser) -> list[MonitorSummary]:
    monitors = list(
        await session.scalars(select(Monitor).where(Monitor.owner_id == user.id).order_by(Monitor.position, Monitor.id))
    )
    return await summarize(session, monitors)


@router.post("/monitors", status_code=status.HTTP_201_CREATED)
async def create_monitor(body: MonitorIn, session: Session, user: CurrentUser) -> MonitorSummary:
    # Serialise creates per user so two parallel requests can't both pass the limit check.
    await session.execute(select(User.id).where(User.id == user.id).with_for_update())
    count = await session.scalar(select(func.count()).select_from(Monitor).where(Monitor.owner_id == user.id))
    limit = get_settings().max_monitors_per_user
    if count >= limit:
        raise MonitorLimit(f"You can have at most {limit} monitors.")
    await _check_target(str(body.url))
    await _check_page(session, user, body.status_page_id)

    monitor = Monitor(owner_id=user.id, position=count, **body.model_dump(mode="json"))
    session.add(monitor)
    await session.commit()
    await session.refresh(monitor)
    return (await summarize(session, [monitor]))[0]


@router.get("/monitors/{monitor_id}")
async def get_monitor(monitor_id: int, session: Session, user: CurrentUser) -> MonitorSummary:
    return (await summarize(session, [await owned_monitor(session, user, monitor_id)]))[0]


@router.patch("/monitors/{monitor_id}")
async def update_monitor(monitor_id: int, body: MonitorPatch, session: Session, user: CurrentUser) -> MonitorSummary:
    monitor = await owned_monitor(session, user, monitor_id, lock=True)
    changes = body.model_dump(mode="json", exclude_unset=True)
    if (changes.get("timeout_seconds", monitor.timeout_seconds)) >= changes.get(
        "interval_seconds", monitor.interval_seconds
    ):
        raise Invalid("timeout_seconds must be lower than interval_seconds")
    if "url" in changes:
        await _check_target(changes["url"])
    if "status_page_id" in changes:
        await _check_page(session, user, changes["status_page_id"])
    for field, value in changes.items():
        setattr(monitor, field, value)
    await session.commit()
    await session.refresh(monitor)
    return (await summarize(session, [monitor]))[0]


@router.delete("/monitors/{monitor_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_monitor(monitor_id: int, session: Session, user: CurrentUser) -> Response:
    await session.delete(await owned_monitor(session, user, monitor_id))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/monitors/{monitor_id}/pause")
async def pause_monitor(monitor_id: int, session: Session, user: CurrentUser) -> MonitorSummary:
    monitor = await owned_monitor(session, user, monitor_id, lock=True)
    now = datetime.now(UTC)
    # A paused monitor makes no claims about the target, so an open incident ends here.
    await session.execute(
        update(Incident)
        .where(Incident.monitor_id == monitor.id, Incident.resolved_at.is_(None))
        .values(resolved_at=now)
    )
    monitor.is_active = False
    monitor.status = MonitorStatus.PAUSED
    monitor.consecutive_failures = monitor.consecutive_successes = 0
    monitor.failing_since = None
    await session.commit()
    return (await summarize(session, [monitor]))[0]


@router.post("/monitors/{monitor_id}/resume")
async def resume_monitor(monitor_id: int, session: Session, user: CurrentUser) -> MonitorSummary:
    monitor = await owned_monitor(session, user, monitor_id, lock=True)
    if not monitor.is_active:
        monitor.is_active = True
        monitor.status = MonitorStatus.PENDING
        monitor.next_check_at = datetime.now(UTC)
        await session.commit()
    return (await summarize(session, [monitor]))[0]


@router.get("/monitors/{monitor_id}/latency")
async def monitor_latency(
    monitor_id: int,
    session: Session,
    user: CurrentUser,
    range_: Annotated[Literal["24h", "7d", "30d"], Query(alias="range")] = "24h",
) -> list[LatencyPoint]:
    monitor = await owned_monitor(session, user, monitor_id)
    buckets = await stats.latency(session, monitor.id, range_, datetime.now(UTC))
    return [LatencyPoint.model_validate(b, from_attributes=True) for b in buckets]


@router.get("/monitors/{monitor_id}/uptime")
async def monitor_uptime(
    monitor_id: int, session: Session, user: CurrentUser, days: Annotated[int, Query(ge=1, le=90)] = 90
) -> list[DayOut]:
    monitor = await owned_monitor(session, user, monitor_id)
    result = await stats.daily(session, [monitor.id], datetime.now(UTC), days)
    return [DayOut.model_validate(d, from_attributes=True) for d in result[monitor.id]]


@router.get("/monitors/{monitor_id}/checks")
async def monitor_checks(
    monitor_id: int,
    session: Session,
    user: CurrentUser,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    before: Annotated[int | None, Query(description="Keyset cursor: id of the last check on the previous page")] = None,
    failed: bool = False,
) -> list[CheckOut]:
    monitor = await owned_monitor(session, user, monitor_id)
    stmt = select(Check).where(Check.monitor_id == monitor.id)
    if before is not None:
        stmt = stmt.where(Check.id < before)
    if failed:
        stmt = stmt.where(Check.ok.is_(False))
    rows = await session.scalars(stmt.order_by(Check.id.desc()).limit(limit))
    return [CheckOut.model_validate(c) for c in rows]


@router.get("/incidents")
async def list_incidents(
    session: Session,
    user: CurrentUser,
    state: Literal["open", "resolved", "all"] = "all",
    monitor: int | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[IncidentOut]:
    stmt = (
        select(Incident, Monitor.name)
        .join(Monitor, Monitor.id == Incident.monitor_id)
        .where(Monitor.owner_id == user.id)
        .order_by(Incident.started_at.desc())
        .limit(limit)
    )
    if state == "open":
        stmt = stmt.where(Incident.resolved_at.is_(None))
    elif state == "resolved":
        stmt = stmt.where(Incident.resolved_at.is_not(None))
    if monitor is not None:
        stmt = stmt.where(Incident.monitor_id == monitor)
    now = datetime.now(UTC)
    return [incident_out(incident, name, now) for incident, name in await session.execute(stmt)]
