import hashlib
import hmac
import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from httpx import AsyncClient

from app.api import channels
from app.config import get_settings
from app.models import Channel, ChannelKind
from app.notifier import DeliveryError, Notice, deliver, format_duration, sign
from tests.factories import register

WEBHOOK = {"kind": "webhook", "name": "Ops", "target": "https://hooks.example.com/pulse"}


@pytest.fixture
def receiver(monkeypatch) -> list[httpx.Request]:
    """Route the test-send endpoint to a mock receiver that records requests."""
    received: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        received.append(request)
        return httpx.Response(200, json={"ok": True})

    monkeypatch.setattr(channels, "transport", httpx.MockTransport(handler))
    return received


async def test_webhook_secret_is_shown_once(client: AsyncClient, auth):
    created = (await client.post("/api/channels", json=WEBHOOK, headers=auth)).json()
    assert len(created["secret"]) == 48
    listed = (await client.get("/api/channels", headers=auth)).json()
    assert "secret" not in listed[0]


@pytest.mark.parametrize(
    "body",
    [
        WEBHOOK | {"target": "not a url"},
        WEBHOOK | {"target": "ftp://hooks.example.com/"},
        {"kind": "telegram", "name": "Me", "target": "hello"},
        {"kind": "sms", "name": "Me", "target": "+100"},
    ],
)
async def test_validation(client: AsyncClient, auth, body):
    assert (await client.post("/api/channels", json=body, headers=auth)).status_code == 422


async def test_private_webhook_is_blocked(client: AsyncClient, auth):
    response = await client.post(
        "/api/channels", json=WEBHOOK | {"target": "http://internal.example.com/"}, headers=auth
    )
    assert response.json()["code"] == "blocked_target"


async def test_send_test_webhook(client: AsyncClient, auth, receiver):
    created = (await client.post("/api/channels", json=WEBHOOK, headers=auth)).json()
    result = await client.post(f"/api/channels/{created['id']}/test", headers=auth)
    assert result.json() == {"ok": True, "detail": "Delivered."}
    assert json.loads(receiver[0].content)["event"] == "test"


async def test_send_test_telegram(client: AsyncClient, auth, receiver, monkeypatch):
    monkeypatch.setattr(get_settings(), "telegram_bot_token", "123:abc")
    created = (
        await client.post("/api/channels", json={"kind": "telegram", "name": "Me", "target": "-100200"}, headers=auth)
    ).json()
    assert created["secret"] is None
    result = (await client.post(f"/api/channels/{created['id']}/test", headers=auth)).json()
    assert result["ok"]
    request = receiver[0]
    assert request.url.path == "/bot123:abc/sendMessage"
    assert json.loads(request.content)["chat_id"] == "-100200"


async def test_telegram_without_bot_token_reports_why(client: AsyncClient, auth, receiver):
    created = (
        await client.post("/api/channels", json={"kind": "telegram", "name": "Me", "target": "@ops"}, headers=auth)
    ).json()
    result = (await client.post(f"/api/channels/{created['id']}/test", headers=auth)).json()
    assert result == {"ok": False, "detail": "TELEGRAM_BOT_TOKEN is not configured"}
    assert receiver == []


async def test_delete_and_ownership(client: AsyncClient, auth):
    created = (await client.post("/api/channels", json=WEBHOOK, headers=auth)).json()
    stranger = await register(client, "stranger@example.com")
    assert (await client.delete(f"/api/channels/{created['id']}", headers=stranger)).status_code == 404
    assert (await client.delete(f"/api/channels/{created['id']}", headers=auth)).status_code == 204


# --- delivery --------------------------------------------------------------------------------


def webhook_channel() -> Channel:
    return Channel(id=1, kind=ChannelKind.WEBHOOK, name="Ops", target="https://hooks.example.com/", secret="s3cret")


NOTICE = Notice(event="incident.opened", monitor_id=1, monitor_name="API", monitor_url="https://api.example.com/")


async def test_retries_server_errors_then_succeeds():
    answers = iter([503, 502, 200])
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(next(answers)))) as client:
        await deliver(client, webhook_channel(), NOTICE, retry_delay=0)


async def test_gives_up_after_three_attempts():
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ConnectError("refused", request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DeliveryError):
            await deliver(client, webhook_channel(), NOTICE, retry_delay=0)
    assert len(calls) == 3


async def test_client_errors_are_not_retried():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(410)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(DeliveryError, match="HTTP 410"):
            await deliver(client, webhook_channel(), NOTICE, retry_delay=0)
    assert len(calls) == 1


def test_signature_covers_timestamp_and_body():
    expected = hmac.new(b"key", b"1700000000.{}", hashlib.sha256).hexdigest()
    assert sign("key", b"{}", 1700000000) == f"t=1700000000,v1={expected}"
    assert sign("key", b"{}", 1) != sign("key", b"{} ", 1)
    assert sign("key", b"{}", 1) != sign("key", b"{}", 2)  # replaying an old body with a new time fails


def test_messages():
    start = datetime(2026, 10, 17, 9, 0, tzinfo=UTC)
    resolved = Notice(
        event="incident.resolved",
        monitor_id=1,
        monitor_name="<API>",
        monitor_url="https://api.example.com/",
        incident_id=7,
        started_at=start,
        resolved_at=start + timedelta(minutes=12, seconds=5),
    )
    assert resolved.text() == "🟢 <b>&lt;API&gt;</b> is back up after 12m 5s"
    assert resolved.payload()["incident"]["duration_seconds"] == 725
    assert "is down" in NOTICE.text()
    assert NOTICE.payload()["incident"] is None
    assert (format_duration(42), format_duration(3720)) == ("42s", "1h 2m")
