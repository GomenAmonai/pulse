from datetime import date, datetime
from typing import Annotated, Literal, Self

from pydantic import (
    AnyHttpUrl,
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    UrlConstraints,
    model_validator,
)

from app.models import ChannelKind, HttpMethod, MonitorStatus

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
HttpUrl = Annotated[AnyHttpUrl, UrlConstraints(max_length=2048, allowed_schemes=["http", "https"])]
Slug = Annotated[str, StringConstraints(pattern=r"^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$")]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- auth ------------------------------------------------------------------------------------


class Credentials(BaseModel):
    email: EmailStr
    password: Annotated[str, StringConstraints(min_length=8, max_length=128)]


class TokenPair(BaseModel):
    access: str
    refresh: str
    token_type: Literal["bearer"] = "bearer"


class RefreshIn(BaseModel):
    refresh: str


class AccessToken(BaseModel):
    access: str


class UserOut(ORM):
    id: int
    email: str
    created_at: datetime


# --- monitors --------------------------------------------------------------------------------


class MonitorBase(BaseModel):
    @model_validator(mode="after")
    def timeout_below_interval(self) -> Self:
        interval, timeout = getattr(self, "interval_seconds", None), getattr(self, "timeout_seconds", None)
        if interval is not None and timeout is not None and timeout >= interval:
            raise ValueError("timeout_seconds must be lower than interval_seconds")
        return self


class MonitorIn(MonitorBase):
    name: Name
    url: HttpUrl
    method: HttpMethod = HttpMethod.GET
    interval_seconds: int = Field(60, ge=30, le=3600)
    timeout_seconds: int = Field(10, ge=1, le=30)
    expected_status: int = Field(200, ge=100, le=599)
    failure_threshold: int = Field(3, ge=1, le=10)
    recovery_threshold: int = Field(2, ge=1, le=10)
    status_page_id: int | None = None


class MonitorPatch(MonitorBase):
    name: Name | None = None
    url: HttpUrl | None = None
    method: HttpMethod | None = None
    interval_seconds: int | None = Field(None, ge=30, le=3600)
    timeout_seconds: int | None = Field(None, ge=1, le=30)
    expected_status: int | None = Field(None, ge=100, le=599)
    failure_threshold: int | None = Field(None, ge=1, le=10)
    recovery_threshold: int | None = Field(None, ge=1, le=10)
    status_page_id: int | None = None


class WindowOut(BaseModel):
    checks: int
    uptime: float | None
    avg_ms: int | None
    p95_ms: int | None


# Keyed by window: "24h", "7d", "30d".
Stats = dict[Literal["24h", "7d", "30d"], WindowOut]


class MonitorOut(ORM):
    id: int
    name: str
    url: str
    method: HttpMethod
    interval_seconds: int
    timeout_seconds: int
    expected_status: int
    failure_threshold: int
    recovery_threshold: int
    status_page_id: int | None
    is_active: bool
    status: MonitorStatus
    consecutive_failures: int
    consecutive_successes: int
    last_checked_at: datetime | None
    last_latency_ms: int | None
    created_at: datetime


class MonitorSummary(MonitorOut):
    stats: Stats
    # Average latency per hour for the last 24 hours, oldest first; null = no successful checks.
    sparkline: list[int | None]


class LatencyPoint(BaseModel):
    t: datetime
    checks: int
    failures: int
    avg_ms: int | None
    p50_ms: int | None
    p95_ms: int | None


class DayOut(BaseModel):
    date: date
    checks: int
    failures: int
    uptime: float | None
    downtime_seconds: int
    incidents: int


class CheckOut(ORM):
    id: int
    checked_at: datetime
    ok: bool
    status_code: int | None
    latency_ms: int | None
    error: str | None


class IncidentOut(ORM):
    id: int
    monitor_id: int
    monitor_name: str
    started_at: datetime
    resolved_at: datetime | None
    cause: str
    duration_seconds: int


# --- status pages ----------------------------------------------------------------------------


class StatusPageIn(BaseModel):
    slug: Slug
    title: Name
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] = ""


class StatusPagePatch(BaseModel):
    title: Name | None = None
    description: Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)] | None = None


class StatusPageOut(ORM):
    id: int
    slug: str
    title: str
    description: str
    monitor_ids: list[int]


OverallStatus = Literal["operational", "degraded", "partial_outage", "major_outage", "unknown"]


class PublicMonitor(BaseModel):
    """What the world sees: no URL, no thresholds."""

    id: int
    name: str
    status: MonitorStatus
    uptime_90d: float | None
    days: list[DayOut]


class PublicIncident(BaseModel):
    id: int
    monitor_name: str
    started_at: datetime
    resolved_at: datetime | None
    duration_seconds: int


class PublicStatus(BaseModel):
    slug: str
    title: str
    description: str
    status: OverallStatus
    updated_at: datetime
    monitors: list[PublicMonitor]
    incidents: list[PublicIncident]


# --- channels --------------------------------------------------------------------------------


class ChannelIn(BaseModel):
    kind: ChannelKind
    name: Name
    target: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=2048)]

    @model_validator(mode="after")
    def target_matches_kind(self) -> Self:
        if self.kind is ChannelKind.WEBHOOK:
            HttpUrlCheck.model_validate({"url": self.target})
        elif not self.target.lstrip("-").isdigit() and not self.target.startswith("@"):
            raise ValueError("Telegram target must be a numeric chat id or @channel")
        return self


class HttpUrlCheck(BaseModel):
    url: HttpUrl


class ChannelOut(ORM):
    id: int
    kind: ChannelKind
    name: str
    target: str
    is_active: bool
    created_at: datetime


class ChannelCreated(ChannelOut):
    # Shown once, so the receiver can verify X-Pulse-Signature.
    secret: str | None


class DeliveryResult(BaseModel):
    ok: bool
    detail: str
