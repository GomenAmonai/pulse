from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse


class DomainError(Exception):
    """An expected failure with a machine-readable code; mapped to an HTTP status in one place."""

    status_code = 400
    code = "bad_request"

    def __init__(self, detail: str, *, headers: dict[str, str] | None = None):
        super().__init__(detail)
        self.detail = detail
        self.headers = headers


class NotFound(DomainError):
    status_code = 404
    code = "not_found"


class Unauthorized(DomainError):
    status_code = 401
    code = "not_authenticated"


class Conflict(DomainError):
    status_code = 409
    code = "conflict"


class EmailTaken(Conflict):
    code = "email_taken"


class SlugTaken(Conflict):
    code = "slug_taken"


class MonitorLimit(Conflict):
    code = "monitor_limit"


class Invalid(DomainError):
    status_code = 422
    code = "invalid"


class BlockedTarget(DomainError):
    status_code = 422
    code = "blocked_target"


class RateLimited(DomainError):
    status_code = 429
    code = "rate_limited"


def install(app: FastAPI) -> None:
    @app.exception_handler(DomainError)
    async def handle_domain_error(_: Request, exc: DomainError) -> JSONResponse:
        return JSONResponse({"code": exc.code, "detail": exc.detail}, status_code=exc.status_code, headers=exc.headers)
