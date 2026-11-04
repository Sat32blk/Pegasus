"""Fetches the hub's state for all Pegasus entities in one go."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import timedelta
import logging
from typing import Any
from urllib.parse import quote

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import PegasusApi, PegasusAuthError, PegasusError
from .const import DOMAIN, SCAN_SECONDS

_LOGGER = logging.getLogger(__name__)


@dataclass
class PegasusData:
    """Everything the entities show."""

    status: dict[str, Any]
    integrations: dict[str, dict[str, Any]]  # hub id -> integration
    network: dict[str, dict[str, Any]]  # remote name -> network figures
    net_integrations: dict[str, dict[str, Any]]  # hub id -> traffic figures
    resources: dict[str, Any]
    remote_resources: dict[str, dict[str, Any]]  # remote name -> its load and memory
    battery: dict[str, dict[str, Any]] = field(default_factory=dict)  # remote name -> battery comparison
    artwork: dict[str, Any] | None = None

    @property
    def remotes(self) -> dict[str, dict[str, Any]]:
        return {r["remote"]: r for r in self.status.get("remotes", [])}


class PegasusCoordinator(DataUpdateCoordinator[PegasusData]):
    """Polls the hub. Only the hub's own data is read: this never makes the hub ask the remote."""

    config_entry: ConfigEntry

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry, api: PegasusApi) -> None:
        super().__init__(hass, _LOGGER, config_entry=entry, name=DOMAIN, update_interval=timedelta(seconds=SCAN_SECONDS))
        self.api = api
        self.known_remotes: set[str] = set()
        self.known_integrations: set[str] = set()

    async def _async_update_data(self) -> PegasusData:
        try:
            status, integrations, network, resources = await asyncio.gather(
                self.api.status(), self.api.integrations(), self.api.network(), self.api.resources()
            )
            battery: dict[str, dict[str, Any]] = {}
            for r in status.get("remotes", []):
                try:
                    battery[r["remote"]] = await self.api.battery(quote(r["remote"], safe=""))
                except PegasusError as err:
                    _LOGGER.debug("battery for %s: %s", r["remote"], err)
            try:
                artwork = await self.api.artwork()
            except PegasusError:
                artwork = None
        except PegasusAuthError as err:
            raise ConfigEntryAuthFailed(str(err)) from err
        except PegasusError as err:
            raise UpdateFailed(str(err)) from err
        return PegasusData(
            status=status,
            integrations={i["id"]: i for i in integrations},
            network={r["remote"]: r for r in network.get("remotes", [])},
            net_integrations={i["id"]: i for i in network.get("integrations", [])},
            resources=resources,
            remote_resources={r["remote"]: r for r in resources.get("remotes", [])},
            battery=battery,
            artwork=artwork,
        )
