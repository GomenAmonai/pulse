"""SSRF guard: monitors must point at the public internet.

A monitor makes the server send requests to a user-supplied URL, so without a check
anyone could probe the internal network or cloud metadata (169.254.169.254). The host is
resolved and every address must be global. The check runs when a monitor is saved and
again before each request, because DNS can change after validation.
"""

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

from app.config import get_settings


class TargetError(ValueError):
    pass


async def resolve(host: str) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    try:
        return [ipaddress.ip_address(host)]
    except ValueError:
        pass
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise TargetError(f"Can't resolve {host}") from exc
    return [ipaddress.ip_address(info[4][0].split("%")[0]) for info in infos]


async def ensure_public(url: str) -> None:
    if get_settings().allow_private_targets:
        return
    host = urlsplit(url).hostname
    if not host:
        raise TargetError("URL has no host")
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise TargetError(f"{host} is not a public address")
    for address in await resolve(host):
        if not address.is_global:
            raise TargetError(f"{host} resolves to a non-public address ({address})")
