from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app import errors
from app.api import auth, channels, monitors, pages, stream
from app.config import get_settings
from app.db import engine
from app.deps import Session
from app.redis import close_redis


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    yield
    await close_redis()
    await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Pulse API",
        version="1.0.0",
        description="Uptime monitoring with public status pages.",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=get_settings().cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    errors.install(app)
    for module in (auth, monitors, pages, channels, stream):
        app.include_router(module.router)

    @app.get("/api/health", tags=["meta"])
    async def health(session: Session) -> dict[str, str]:
        await session.execute(text("SELECT 1"))
        return {"status": "ok"}

    return app


app = create_app()
