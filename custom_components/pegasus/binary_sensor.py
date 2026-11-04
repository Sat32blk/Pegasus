"""Pegasus binary sensors: is each remote linked / asleep; does each integration need attention."""

from __future__ import annotations

from homeassistant.components.binary_sensor import BinarySensorDeviceClass, BinarySensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PegasusConfigEntry
from .entity import IntegrationEntity, RemoteEntity, add_new


async def async_setup_entry(hass: HomeAssistant, entry: PegasusConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    c = entry.runtime_data
    entry.async_on_unload(add_new(
        c, async_add_entities,
        per_remote=lambda r: [Linked(c, r), Asleep(c, r)],
        per_intg=lambda i: [Problem(c, i)],
    ))


class Linked(RemoteEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.CONNECTIVITY
    _attr_translation_key = "linked"

    def __init__(self, c, remote: str) -> None:
        super().__init__(c, remote, "linked")

    @property
    def available(self) -> bool:  # stays available to show "disconnected"
        return self.coordinator.last_update_success

    @property
    def is_on(self) -> bool:
        return self.remote in self.coordinator.data.remotes


class Asleep(RemoteEntity, BinarySensorEntity):
    _attr_translation_key = "asleep"

    def __init__(self, c, remote: str) -> None:
        super().__init__(c, remote, "asleep")

    @property
    def is_on(self) -> bool | None:
        r = self.coordinator.data.remotes.get(self.remote)
        return bool(r.get("standby")) if r else None


class Problem(IntegrationEntity, BinarySensorEntity):
    _attr_device_class = BinarySensorDeviceClass.PROBLEM
    _attr_translation_key = "problem"

    def __init__(self, c, intg_id: str) -> None:
        super().__init__(c, intg_id, "problem")

    @property
    def is_on(self) -> bool:
        m = self.intg
        return m.get("status", {}).get("state") in ("crashed", "error") or any(not r.get("id") for r in m.get("shownAs") or [])

    @property
    def extra_state_attributes(self):
        m = self.intg
        probs = [f"{r['remote']}: {r.get('problem')}" for r in m.get("shownAs") or [] if not r.get("id")]
        return {"restarts": m.get("status", {}).get("restarts"), "not_on_remote": probs or None}
