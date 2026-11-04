"""Talks to a Pegasus Hub over its page API (http://host:port/api/...)."""

from __future__ import annotations

import asyncio
from typing import Any

import aiohttp


class PegasusError(Exception):
    """The hub could not be reached or answered with an error."""


class PegasusAuthError(PegasusError):
    """The hub asked for its page password."""


class PegasusApi:
    """A small client for the hub's API."""

    def __init__(self, session: aiohttp.ClientSession, host: str, port: int, password: str | None = None) -> None:
        self._session = session
        self.base = f"http://{host}:{port}/api"
        self._auth = aiohttp.BasicAuth("homeassistant", password) if password else None

    async def _request(self, method: str, path: str, **kw: Any) -> Any:
        try:
            async with asyncio.timeout(15):
                async with self._session.request(method, self.base + path, auth=self._auth, **kw) as resp:
                    if resp.status == 401:
                        raise PegasusAuthError("the hub wants its page password")
                    data = await resp.json(content_type=None)
                    if resp.status >= 400:
                        raise PegasusError((data or {}).get("error") or f"HTTP {resp.status}")
                    return data
        except (aiohttp.ClientError, TimeoutError) as err:
            raise PegasusError(f"can't reach the hub: {err}") from err

    async def status(self) -> dict[str, Any]:
        return await self._request("GET", "/status")

    async def integrations(self) -> list[dict[str, Any]]:
        return await self._request("GET", "/integrations")

    async def network(self) -> dict[str, Any]:
        return await self._request("GET", "/network", params={"brief": "1"})

    async def resources(self) -> dict[str, Any]:
        return await self._request("GET", "/resources", params={"brief": "1"})

    async def battery(self, remote: str) -> dict[str, Any]:
        return await self._request("GET", f"/remotes/{remote}/battery/compare")

    async def artwork(self) -> dict[str, Any]:
        return await self._request("GET", "/artwork")

    async def action(self, integration_id: str, action: str) -> Any:
        """start, stop, restart or update one integration on the hub."""
        return await self._request("POST", f"/integrations/{integration_id}/{action}")

    async def check_updates(self) -> Any:
        return await self._request("POST", "/integrations/check-updates")
