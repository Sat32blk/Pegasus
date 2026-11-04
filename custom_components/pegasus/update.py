"""Pegasus updates: a new release of an integration on the hub (installed from GitHub)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.update import UpdateEntity, UpdateEntityFeature
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PegasusConfigEntry
from .api import PegasusError
from .entity import IntegrationEntity, add_new


async def async_setup_entry(hass: HomeAssistant, entry: PegasusConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    c = entry.runtime_data
    entry.async_on_unload(add_new(c, async_add_entities, per_intg=lambda i: [Release(c, i)]))


class Release(IntegrationEntity, UpdateEntity):
    _attr_name = None  # the integration's own name

    def __init__(self, c, intg_id: str) -> None:
        super().__init__(c, intg_id, "update")

    @property
    def supported_features(self) -> UpdateEntityFeature:
        return UpdateEntityFeature.INSTALL if (self.intg.get("source") or {}).get("type") == "git" else UpdateEntityFeature(0)

    @property
    def installed_version(self) -> str | None:
        return self.intg.get("version") or None

    @property
    def latest_version(self) -> str | None:
        latest = self.intg.get("latest")
        return str(latest).removeprefix("v") if latest else self.installed_version

    @property
    def release_url(self) -> str | None:
        src = self.intg.get("source") or {}
        return f"{src['url'].removesuffix('.git')}/releases" if src.get("url") else None

    async def async_install(self, version: str | None, backup: bool, **kwargs: Any) -> None:
        try:
            await self.coordinator.api.action(self.intg_id, "update")
        except PegasusError as err:
            raise HomeAssistantError(f"Pegasus: {err}") from err
        await self.coordinator.async_request_refresh()
