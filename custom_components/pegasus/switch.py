"""Pegasus switches: run or stop each integration on the hub."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PegasusConfigEntry
from .api import PegasusError
from .entity import IntegrationEntity, add_new


async def async_setup_entry(hass: HomeAssistant, entry: PegasusConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    c = entry.runtime_data
    entry.async_on_unload(add_new(c, async_add_entities, per_intg=lambda i: [Running(c, i)]))


class Running(IntegrationEntity, SwitchEntity):
    _attr_translation_key = "running"

    def __init__(self, c, intg_id: str) -> None:
        super().__init__(c, intg_id, "running")

    @property
    def is_on(self) -> bool:
        return self.intg.get("status", {}).get("state") in ("running", "starting")

    async def _do(self, action: str) -> None:
        try:
            await self.coordinator.api.action(self.intg_id, action)
        except PegasusError as err:
            raise HomeAssistantError(f"Pegasus: {err}") from err
        await self.coordinator.async_request_refresh()

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._do("start")

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._do("stop")
