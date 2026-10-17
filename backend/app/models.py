from __future__ import annotations

import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Enum,
    ForeignKey,
    Index,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


def _enum(cls: type[enum.Enum]) -> Enum:
    # Store the lowercase value, not the member name, and keep it a plain VARCHAR + CHECK:
    # adding a state later is a one-line migration instead of ALTER TYPE.
    return Enum(
        cls,
        name=cls.__name__.lower(),
        native_enum=False,
        create_constraint=True,
        length=16,
        values_callable=lambda e: [m.value for m in e],
    )


class MonitorStatus(enum.StrEnum):
    PENDING = "pending"  # created, no verdict yet
    UP = "up"
    DOWN = "down"  # an incident is open
    PAUSED = "paused"


class HttpMethod(enum.StrEnum):
    GET = "GET"
    HEAD = "HEAD"


class ChannelKind(enum.StrEnum):
    TELEGRAM = "telegram"
    WEBHOOK = "webhook"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class StatusPage(Base):
    """A public page at /status/{slug} listing the monitors attached to it."""

    __tablename__ = "status_pages"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    slug: Mapped[str] = mapped_column(String(50), unique=True)
    title: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    monitors: Mapped[list[Monitor]] = relationship(back_populates="status_page", order_by="Monitor.position")


class Monitor(Base):
    __tablename__ = "monitors"
    __table_args__ = (
        CheckConstraint("interval_seconds BETWEEN 30 AND 3600", name="interval_range"),
        CheckConstraint("timeout_seconds BETWEEN 1 AND 30", name="timeout_range"),
        CheckConstraint("timeout_seconds < interval_seconds", name="timeout_below_interval"),
        CheckConstraint("expected_status BETWEEN 100 AND 599", name="expected_status_range"),
        CheckConstraint("failure_threshold BETWEEN 1 AND 10", name="failure_threshold_range"),
        CheckConstraint("recovery_threshold BETWEEN 1 AND 10", name="recovery_threshold_range"),
        # The scheduler's hot query: due, active monitors in next_check_at order.
        Index("ix_monitors_due", "next_check_at", postgresql_where=text("is_active")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status_page_id: Mapped[int | None] = mapped_column(ForeignKey("status_pages.id", ondelete="SET NULL"), index=True)
    position: Mapped[int] = mapped_column(default=0)

    name: Mapped[str] = mapped_column(String(100))
    url: Mapped[str] = mapped_column(String(2048))
    method: Mapped[HttpMethod] = mapped_column(_enum(HttpMethod), default=HttpMethod.GET)
    interval_seconds: Mapped[int] = mapped_column(default=60)
    timeout_seconds: Mapped[int] = mapped_column(default=10)
    expected_status: Mapped[int] = mapped_column(default=200)
    # Flap protection: an incident opens after N consecutive failures and closes after M
    # consecutive successes, so a single dropped packet doesn't page anyone.
    failure_threshold: Mapped[int] = mapped_column(default=3)
    recovery_threshold: Mapped[int] = mapped_column(default=2)

    is_active: Mapped[bool] = mapped_column(default=True)
    status: Mapped[MonitorStatus] = mapped_column(_enum(MonitorStatus), default=MonitorStatus.PENDING)
    consecutive_failures: Mapped[int] = mapped_column(default=0)
    consecutive_successes: Mapped[int] = mapped_column(default=0)
    # Time of the first failure in the current failing streak: the incident starts here,
    # not at the moment the threshold was crossed.
    failing_since: Mapped[datetime | None]
    next_check_at: Mapped[datetime] = mapped_column(server_default=func.now())
    last_checked_at: Mapped[datetime | None]
    last_latency_ms: Mapped[int | None]

    created_at: Mapped[datetime] = mapped_column(server_default=func.now())

    status_page: Mapped[StatusPage | None] = relationship(back_populates="monitors")


class Check(Base):
    __tablename__ = "checks"
    __table_args__ = (Index("ix_checks_monitor_time", "monitor_id", "checked_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    monitor_id: Mapped[int] = mapped_column(ForeignKey("monitors.id", ondelete="CASCADE"))
    checked_at: Mapped[datetime] = mapped_column(server_default=func.now())
    ok: Mapped[bool]
    status_code: Mapped[int | None]
    latency_ms: Mapped[int | None]
    error: Mapped[str | None] = mapped_column(String(300))


class Incident(Base):
    __tablename__ = "incidents"
    __table_args__ = (
        # At most one open incident per monitor, enforced by the database rather than by
        # hoping two workers never race.
        Index(
            "uq_incidents_one_open_per_monitor",
            "monitor_id",
            unique=True,
            postgresql_where=text("resolved_at IS NULL"),
        ),
        Index("ix_incidents_monitor_started", "monitor_id", "started_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    monitor_id: Mapped[int] = mapped_column(ForeignKey("monitors.id", ondelete="CASCADE"))
    started_at: Mapped[datetime]
    resolved_at: Mapped[datetime | None]
    cause: Mapped[str] = mapped_column(Text)


class Channel(Base):
    """Where incident notifications go: a Telegram chat or a signed webhook."""

    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[ChannelKind] = mapped_column(_enum(ChannelKind))
    name: Mapped[str] = mapped_column(String(100))
    # Telegram chat id or webhook URL.
    target: Mapped[str] = mapped_column(String(2048))
    # HMAC key for webhook signatures; shown once on creation.
    secret: Mapped[str | None] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(default=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
