"""Diagnostics for Pegasus (the pairing code and password are left out)."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.const import CONF_PASSWORD
from homeassistant.core import HomeAssistant

from . import PegasusConfigEntry

REDACT = {CONF_PASSWORD, "token", "address", "pairing"}


async def async_get_config_entry_diagnostics(hass: HomeAssistant, entry: PegasusConfigEntry) -> dict[str, Any]:
    d = entry.runtime_data.data
    return {"entry": async_redact_data(dict(entry.data), REDACT), "data": async_redact_data(asdict(d), REDACT) if d else None}
