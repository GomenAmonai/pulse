from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.db import SessionLocal
from app.deps import Bearer, authenticate
from app.events import sse_stream

router = APIRouter(prefix="/api", tags=["live"])


@router.get("/stream", response_class=StreamingResponse)
async def stream(credentials: Bearer) -> StreamingResponse:
    """Server-sent events: `check` for every check, `incident.opened` / `incident.resolved`.

    Authenticated with the usual Bearer header, so the dashboard reads it with fetch()
    instead of EventSource and the token never ends up in a URL or an access log.
    """
    # A short-lived session just for auth: a request-scoped one would hold a pooled
    # connection for as long as the dashboard stays open.
    async with SessionLocal() as session:
        user = await authenticate(session, credentials)
    return StreamingResponse(
        sse_stream(user.id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
