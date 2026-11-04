"""Pegasus buttons: restart an integration; check for updates."""

from __future__ import annotations

from homeassistant.components.button import ButtonDeviceClass, ButtonEntity
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PegasusConfigEntry
from .api import PegasusError
from .entity import IntegrationEntity, PegasusEntity, add_new


async def async_setup_entry(hass: HomeAssistant, entry: PegasusConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    c = entry.runtime_data
    entry.async_on_unload(add_new(c, async_add_entities, hub=lambda: [CheckUpdates(c)], per_intg=lambda i: [Restart(c, i)]))


class CheckUpdates(PegasusEntity, ButtonEntity):
    _attr_translation_key = "check_updates"
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, c) -> None:
        super().__init__(c, "check_updates")

    async def async_press(self) -> None:
        try:
            await self.coordinator.api.check_updates()
        except PegasusError as err:
            raise HomeAssistantError(f"Pegasus: {err}") from err
        await self.coordinator.async_request_refresh()


class Restart(IntegrationEntity, ButtonEntity):
    _attr_device_class = ButtonDeviceClass.RESTART
    _attr_entity_category = EntityCategory.CONFIG

    def __init__(self, c, intg_id: str) -> None:
        super().__init__(c, intg_id, "restart")

    async def async_press(self) -> None:
        try:
            await self.coordinator.api.action(self.intg_id, "restart")
        except PegasusError as err:
            raise HomeAssistantError(f"Pegasus: {err}") from err
        await self.coordinator.async_request_refresh()
