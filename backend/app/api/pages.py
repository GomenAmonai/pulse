from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.deps import CurrentUser, Session
from app.errors import NotFound, SlugTaken
from app.models import Incident, Monitor, MonitorStatus, StatusPage, User
from app.ratelimit import RateLimit
from app.schemas import (
    DayOut,
    OverallStatus,
    PublicIncident,
    PublicMonitor,
    PublicStatus,
    StatusPageIn,
    StatusPageOut,
    StatusPagePatch,
)
from app.services import stats

router = APIRouter(prefix="/api", tags=["status pages"])

INCIDENT_HISTORY_DAYS = 14


async def _page_out(session: Session, page: StatusPage) -> StatusPageOut:
    ids = await session.scalars(
        select(Monitor.id).where(Monitor.status_page_id == page.id).order_by(Monitor.position, Monitor.id)
    )
    return StatusPageOut(
        id=page.id, slug=page.slug, title=page.title, description=page.description, monitor_ids=list(ids)
    )


async def _owned_page(session: Session, user: User, page_id: int) -> StatusPage:
    page = await session.scalar(select(StatusPage).where(StatusPage.id == page_id, StatusPage.owner_id == user.id))
    if page is None:
        raise NotFound("Status page not found.")
    return page


@router.get("/status-pages")
async def list_pages(session: Session, user: CurrentUser) -> list[StatusPageOut]:
    pages = await session.scalars(select(StatusPage).where(StatusPage.owner_id == user.id).order_by(StatusPage.id))
    return [await _page_out(session, p) for p in pages]


@router.post("/status-pages", status_code=status.HTTP_201_CREATED)
async def create_page(body: StatusPageIn, session: Session, user: CurrentUser) -> StatusPageOut:
    page = StatusPage(owner_id=user.id, **body.model_dump())
    session.add(page)
    try:
        await session.commit()
    except IntegrityError:
        raise SlugTaken(f"/status/{body.slug} is already taken.") from None
    return await _page_out(session, page)


@router.patch("/status-pages/{page_id}")
async def update_page(page_id: int, body: StatusPagePatch, session: Session, user: CurrentUser) -> StatusPageOut:
    page = await _owned_page(session, user, page_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(page, field, value)
    await session.commit()
    return await _page_out(session, page)


@router.delete("/status-pages/{page_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_page(page_id: int, session: Session, user: CurrentUser) -> Response:
    await session.delete(await _owned_page(session, user, page_id))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def overall(statuses: list[MonitorStatus]) -> OverallStatus:
    judged = [s for s in statuses if s in (MonitorStatus.UP, MonitorStatus.DOWN)]
    if not judged:
        return "unknown"
    down = sum(s is MonitorStatus.DOWN for s in judged)
    if down == 0:
        return "operational"
    if down == len(judged):
        return "major_outage"
    return "partial_outage"


@router.get(
    "/status/{slug}",
    dependencies=[Depends(RateLimit("status", get_settings().public_rate_limit))],
)
async def public_status(slug: str, session: Session, response: Response) -> PublicStatus:
    page = await session.scalar(select(StatusPage).where(StatusPage.slug == slug))
    if page is None:
        raise NotFound("Status page not found.")
    now = datetime.now(UTC)
    monitors = list(
        await session.scalars(
            select(Monitor).where(Monitor.status_page_id == page.id).order_by(Monitor.position, Monitor.id)
        )
    )
    ids = [m.id for m in monitors]
    days = await stats.daily(session, ids, now, 90)
    incidents = await session.execute(
        select(Incident, Monitor.name)
        .join(Monitor, Monitor.id == Incident.monitor_id)
        .where(
            Incident.monitor_id.in_(ids),
            # Ongoing incidents always show, however old.
            (Incident.resolved_at.is_(None)) | (Incident.started_at >= now - timedelta(days=INCIDENT_HISTORY_DAYS)),
        )
        .order_by(Incident.started_at.desc())
        .limit(50)
    )

    def uptime(bars: list[stats.Day]) -> float | None:
        checks = sum(d.checks for d in bars)
        return round((checks - sum(d.failures for d in bars)) * 100 / checks, 3) if checks else None

    # Cached briefly by browsers and CDNs: a status page gets hammered exactly when things break.
    response.headers["Cache-Control"] = "public, max-age=15"
    return PublicStatus(
        slug=page.slug,
        title=page.title,
        description=page.description,
        status=overall([m.status for m in monitors]),
        updated_at=now,
        monitors=[
            PublicMonitor(
                id=m.id,
                name=m.name,
                status=m.status,
                uptime_90d=uptime(days[m.id]),
                days=[DayOut.model_validate(d, from_attributes=True) for d in days[m.id]],
            )
            for m in monitors
        ],
        incidents=[
            PublicIncident(
                id=i.id,
                monitor_name=name,
                started_at=i.started_at,
                resolved_at=i.resolved_at,
                duration_seconds=max(0, round(((i.resolved_at or now) - i.started_at).total_seconds())),
            )
            for i, name in incidents
        ],
    )
