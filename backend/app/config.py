from functools import lru_cache

from pydantic import Field, PostgresDsn, RedisDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: PostgresDsn = Field(default="postgresql+asyncpg://pulse:pulse@localhost:5432/pulse")
    # Without Redis the API falls back to in-process rate limiting and an in-process event
    # broker. That is enough for tests and a single dev process, but the worker's live
    # updates only reach the dashboard through Redis.
    redis_url: RedisDsn | None = None

    secret_key: str = "dev-secret-key-change-me-in-production-0000"
    access_token_minutes: int = 30
    refresh_token_days: int = 14

    cors_origins: list[str] = ["http://localhost:5173"]

    # Worker
    worker_concurrency: int = 50
    worker_tick_seconds: float = 1.0
    worker_batch_size: int = 200
    check_retention_days: int = 90
    user_agent: str = "PulseBot/1.0 (+https://github.com/GomenAmonai/pulse)"
    # Monitors may not point at loopback, private or link-local addresses (SSRF).
    # Local development and tests turn this on to check services on localhost.
    allow_private_targets: bool = False

    # Limits
    max_monitors_per_user: int = 25
    login_rate_limit: int = 10  # attempts per minute per IP
    public_rate_limit: int = 120  # status page requests per minute per IP

    telegram_bot_token: str | None = None
    telegram_api_url: str = "https://api.telegram.org"


@lru_cache
def get_settings() -> Settings:
    return Settings()
