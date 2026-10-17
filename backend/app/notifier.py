"""Incident notifications: Telegram messages and signed webhooks.

Webhooks are signed like Stripe's: `X-Pulse-Signature: t=<unix>,v1=<hex>` where v1 is
HMAC-SHA256 over "<unix>.<raw body>" with the channel secret. Receivers recompute it and
reject old timestamps, which rules out both forgery and replay.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import time
from dataclasses import dataclass
from datetime import datetime
from html import escape
from typing import Any, Literal

import httpx

from app.config import get_settings
from app.models import Channel, ChannelKind
from app.targets import TargetError, ensure_public

log = logging.getLogger("pulse.notifier")

Event = Literal["incident.opened", "incident.resolved", "test"]
ATTEMPTS = 3


@dataclass(frozen=True, slots=True)
class Notice:
    event: Event
    monitor_id: int
    monitor_name: str
    monitor_url: str
    incident_id: int | None = None
    started_at: datetime | None = None
    resolved_at: datetime | None = None
    cause: str | None = None

    def payload(self) -> dict[str, Any]:
        duration = (
            round((self.resolved_at - self.started_at).total_seconds())
            if self.started_at and self.resolved_at
            else None
        )
        return {
            "event": self.event,
            "monitor": {"id": self.monitor_id, "name": self.monitor_name, "url": self.monitor_url},
            "incident": None
            if self.incident_id is None
            else {
                "id": self.incident_id,
                "started_at": self.started_at.isoformat() if self.started_at else None,
                "resolved_at": self.resolved_at.isoformat() if self.resolved_at else None,
                "duration_seconds": duration,
                "cause": self.cause,
            },
        }

    def text(self) -> str:
        name = escape(self.monitor_name)
        if self.event == "incident.opened":
            return f"🔴 <b>{name}</b> is down\n{escape(self.cause or '')}\n{escape(self.monitor_url)}"
        if self.event == "incident.resolved":
            seconds = (self.payload()["incident"] or {}).get("duration_seconds") or 0
            return f"🟢 <b>{name}</b> is back up after {format_duration(seconds)}"
        return f"✅ Test notification from Pulse for <b>{name}</b>"


def format_duration(seconds: int) -> str:
    minutes, sec = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {sec}s"
    return f"{sec}s"


def sign(secret: str, body: bytes, timestamp: int) -> str:
    digest = hmac.new(secret.encode(), f"{timestamp}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


class DeliveryError(Exception):
    pass


async def _send_webhook(client: httpx.AsyncClient, channel: Channel, notice: Notice) -> None:
    try:
        await ensure_public(channel.target)
    except TargetError as exc:
        raise DeliveryError(str(exc)) from exc
    body = json.dumps(notice.payload(), separators=(",", ":")).encode()
    headers = {
        "Content-Type": "application/json",
        "User-Agent": get_settings().user_agent,
        "X-Pulse-Event": notice.event,
        "X-Pulse-Signature": sign(channel.secret or "", body, int(time.time())),
    }
    response = await client.post(channel.target, content=body, headers=headers, timeout=10)
    if response.status_code >= 300:
        raise DeliveryError(f"Webhook answered HTTP {response.status_code}")


async def _send_telegram(client: httpx.AsyncClient, channel: Channel, notice: Notice) -> None:
    settings = get_settings()
    if not settings.telegram_bot_token:
        raise DeliveryError("TELEGRAM_BOT_TOKEN is not configured")
    response = await client.post(
        f"{settings.telegram_api_url}/bot{settings.telegram_bot_token}/sendMessage",
        json={
            "chat_id": channel.target,
            "text": notice.text(),
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        },
        timeout=10,
    )
    if response.status_code != 200:
        raise DeliveryError(f"Telegram answered HTTP {response.status_code}: {response.text[:200]}")


async def deliver(client: httpx.AsyncClient, channel: Channel, notice: Notice, *, retry_delay: float = 1.0) -> None:
    """Send one notice with retries on network errors and 5xx; raise DeliveryError on final failure."""
    send = _send_telegram if channel.kind is ChannelKind.TELEGRAM else _send_webhook
    for attempt in range(1, ATTEMPTS + 1):
        try:
            await send(client, channel, notice)
            return
        except (httpx.HTTPError, DeliveryError) as exc:
            retryable = isinstance(exc, httpx.HTTPError) or "HTTP 5" in str(exc)
            if attempt == ATTEMPTS or not retryable:
                raise DeliveryError(str(exc) or type(exc).__name__) from exc
            await asyncio.sleep(retry_delay * 2 ** (attempt - 1))


async def broadcast(client: httpx.AsyncClient, channels: list[Channel], notice: Notice) -> None:
    async def one(channel: Channel) -> None:
        try:
            await deliver(client, channel, notice)
        except DeliveryError as exc:
            log.warning("notification to channel %s failed: %s", channel.id, exc)

    await asyncio.gather(*(one(c) for c in channels))
