"""Pegasus: entities for a Pegasus Hub (Unfolded Circle integrations run off the remote)."""

from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PegasusApi
from .coordinator import PegasusCoordinator

PLATFORMS = [Platform.BINARY_SENSOR, Platform.BUTTON, Platform.SENSOR, Platform.SWITCH, Platform.UPDATE]

type PegasusConfigEntry = ConfigEntry[PegasusCoordinator]


async def async_setup_entry(hass: HomeAssistant, entry: PegasusConfigEntry) -> bool:
    api = PegasusApi(async_get_clientsession(hass), entry.data[CONF_HOST], entry.data[CONF_PORT], entry.data.get(CONF_PASSWORD) or None)
    coordinator = PegasusCoordinator(hass, entry, api)
    await coordinator.async_config_entry_first_refresh()
    entry.runtime_data = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: PegasusConfigEntry) -> bool:
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
