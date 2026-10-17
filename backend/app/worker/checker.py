"""One HTTP check: request, measure, classify."""

import asyncio
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urljoin

import httpx

from app.targets import TargetError, ensure_public

MAX_REDIRECTS = 5


@dataclass(frozen=True, slots=True)
class Target:
    monitor_id: int
    owner_id: int
    url: str
    method: str
    timeout_seconds: int
    expected_status: int


@dataclass(frozen=True, slots=True)
class Result:
    ok: bool
    checked_at: datetime
    status_code: int | None = None
    latency_ms: int | None = None
    error: str | None = None


async def _request(client: httpx.AsyncClient, target: Target) -> httpx.Response:
    # Redirects are followed by hand so every hop goes through the SSRF guard: otherwise a
    # public URL could 302 to http://169.254.169.254/.
    url = target.url
    for _ in range(MAX_REDIRECTS + 1):
        await ensure_public(url)
        # Streaming: only the status line and headers are read, never a multi-megabyte body.
        async with client.stream(
            target.method, url, follow_redirects=False, timeout=target.timeout_seconds
        ) as response:
            if not response.is_redirect:
                return response
            url = urljoin(url, response.headers["location"])
    raise httpx.TooManyRedirects(f"More than {MAX_REDIRECTS} redirects", request=response.request)


async def perform(client: httpx.AsyncClient, target: Target) -> Result:
    checked_at = datetime.now(UTC)
    started = time.perf_counter()
    try:
        # httpx timeouts apply per phase (connect, read, ...); this caps the whole check.
        async with asyncio.timeout(target.timeout_seconds):
            response = await _request(client, target)
    except TimeoutError:
        return Result(False, checked_at, error=f"Timed out after {target.timeout_seconds}s")
    except TargetError as exc:
        return Result(False, checked_at, error=str(exc))
    except httpx.TimeoutException:
        return Result(False, checked_at, error=f"Timed out after {target.timeout_seconds}s")
    except httpx.ConnectError as exc:
        return Result(False, checked_at, error=f"Connection failed: {exc}".rstrip(": ")[:300])
    except httpx.HTTPError as exc:
        return Result(False, checked_at, error=f"{type(exc).__name__}: {exc}"[:300])

    latency_ms = round((time.perf_counter() - started) * 1000)
    if response.status_code != target.expected_status:
        return Result(
            False,
            checked_at,
            response.status_code,
            latency_ms,
            f"Expected HTTP {target.expected_status}, got {response.status_code}",
        )
    return Result(True, checked_at, response.status_code, latency_ms)
