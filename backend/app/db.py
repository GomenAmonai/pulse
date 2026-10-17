from collections.abc import AsyncIterator
from datetime import datetime

from sqlalchemy import MetaData
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import DateTime

from app.config import get_settings

# Stable constraint names, so Alembic autogenerate produces deterministic migrations.
NAMING = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)
    type_annotation_map = {datetime: DateTime(timezone=True)}


def make_engine(url: str | None = None, **kwargs) -> AsyncEngine:
    # date_trunc and generate_series over timestamptz follow the session time zone, so pin it:
    # every bucket boundary in the stats queries is a UTC boundary regardless of server config.
    return create_async_engine(
        url or str(get_settings().database_url),
        pool_pre_ping=True,
        connect_args={"server_settings": {"timezone": "UTC"}},
        **kwargs,
    )


engine = make_engine()
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session
