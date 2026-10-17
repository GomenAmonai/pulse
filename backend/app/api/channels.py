import secrets

import httpx
from fastapi import APIRouter, Response, status
from sqlalchemy import select

from app.config import get_settings
from app.deps import CurrentUser, Session
from app.errors import BlockedTarget, NotFound
from app.models import Channel, ChannelKind, User
from app.notifier import DeliveryError, Notice, deliver
from app.schemas import ChannelCreated, ChannelIn, ChannelOut, DeliveryResult
from app.targets import TargetError, ensure_public

router = APIRouter(prefix="/api/channels", tags=["notifications"])

# Overridable in tests with an httpx.MockTransport.
transport: httpx.AsyncBaseTransport | None = None


async def _owned(session: Session, user: User, channel_id: int) -> Channel:
    channel = await session.scalar(select(Channel).where(Channel.id == channel_id, Channel.owner_id == user.id))
    if channel is None:
        raise NotFound("Channel not found.")
    return channel


@router.get("")
async def list_channels(session: Session, user: CurrentUser) -> list[ChannelOut]:
    rows = await session.scalars(select(Channel).where(Channel.owner_id == user.id).order_by(Channel.id))
    return [ChannelOut.model_validate(c) for c in rows]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_channel(body: ChannelIn, session: Session, user: CurrentUser) -> ChannelCreated:
    secret = None
    if body.kind is ChannelKind.WEBHOOK:
        try:
            await ensure_public(body.target)
        except TargetError as exc:
            raise BlockedTarget(str(exc)) from None
        secret = secrets.token_hex(24)
    channel = Channel(owner_id=user.id, kind=body.kind, name=body.name, target=body.target, secret=secret)
    session.add(channel)
    await session.commit()
    await session.refresh(channel)
    return ChannelCreated.model_validate(channel)


@router.delete("/{channel_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_channel(channel_id: int, session: Session, user: CurrentUser) -> Response:
    await session.delete(await _owned(session, user, channel_id))
    await session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{channel_id}/test")
async def test_channel(channel_id: int, session: Session, user: CurrentUser) -> DeliveryResult:
    """Send a test notification right away and report what the receiver said."""
    channel = await _owned(session, user, channel_id)
    notice = Notice(event="test", monitor_id=0, monitor_name=channel.name, monitor_url="https://example.com")
    async with httpx.AsyncClient(transport=transport, headers={"User-Agent": get_settings().user_agent}) as client:
        try:
            await deliver(client, channel, notice, retry_delay=0)
        except DeliveryError as exc:
            return DeliveryResult(ok=False, detail=str(exc))
    return DeliveryResult(ok=True, detail="Delivered.")
