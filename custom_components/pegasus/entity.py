"""Base entities: one device for the hub, one per linked remote, one per integration on the hub."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import PegasusCoordinator


def short(remote: str) -> str:
    return remote[:-6] if remote.endswith(".local") else remote


class PegasusEntity(CoordinatorEntity[PegasusCoordinator]):
    """An entity of the hub itself."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: PegasusCoordinator, key: str) -> None:
        super().__init__(coordinator)
        entry = coordinator.config_entry
        self._attr_unique_id = f"{entry.entry_id}_{key}"
        st = coordinator.data.status if coordinator.data else {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="Pegasus",
            model="Pegasus Hub",
            sw_version=st.get("version"),
            configuration_url=coordinator.api.base.removesuffix("/api"),
        )


class RemoteEntity(CoordinatorEntity[PegasusCoordinator]):
    """An entity of one linked remote."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: PegasusCoordinator, remote: str, key: str) -> None:
        super().__init__(coordinator)
        self.remote = remote
        entry = coordinator.config_entry
        self._attr_unique_id = f"{entry.entry_id}_remote_{remote}_{key}"
        r = coordinator.data.remotes.get(remote, {}) if coordinator.data else {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{entry.entry_id}_remote_{remote}")},
            name=short(remote),
            manufacturer="Unfolded Circle",
            model="Remote (Pegasus Bridge)",
            sw_version=r.get("bridge"),
            via_device=(DOMAIN, entry.entry_id),
        )

    @property
    def available(self) -> bool:
        d = self.coordinator.data
        return super().available and d is not None and (self.remote in d.remotes or self.remote in d.network)


class IntegrationEntity(CoordinatorEntity[PegasusCoordinator]):
    """An entity of one integration running on the hub."""

    _attr_has_entity_name = True

    def __init__(self, coordinator: PegasusCoordinator, intg_id: str, key: str) -> None:
        super().__init__(coordinator)
        self.intg_id = intg_id
        entry = coordinator.config_entry
        self._attr_unique_id = f"{entry.entry_id}_intg_{intg_id}_{key}"
        m = coordinator.data.integrations.get(intg_id, {}) if coordinator.data else {}
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{entry.entry_id}_intg_{intg_id}")},
            name=m.get("name") or intg_id,
            manufacturer=m.get("developer") or None,
            model=f"{m.get('driverId', intg_id)} on Pegasus Hub",
            sw_version=m.get("version"),
            via_device=(DOMAIN, entry.entry_id),
        )

    @property
    def intg(self) -> dict[str, Any]:
        return self.coordinator.data.integrations.get(self.intg_id, {}) if self.coordinator.data else {}

    @property
    def available(self) -> bool:
        return super().available and self.coordinator.data is not None and self.intg_id in self.coordinator.data.integrations


def add_new(coordinator: PegasusCoordinator, async_add_entities, hub: Callable[[], list] | None = None,
            per_remote: Callable[[str], list] | None = None, per_intg: Callable[[str], list] | None = None) -> Callable[[], None]:
    """Adds the hub's entities now, and those of remotes and integrations as they appear."""
    seen_r: set[str] = set()
    seen_i: set[str] = set()
    if hub:
        async_add_entities(hub())

    def check() -> None:
        d = coordinator.data
        if d is None:
            return
        new: list = []
        if per_remote:
            for r in set(d.remotes) | set(d.network):
                if r not in seen_r:
                    seen_r.add(r)
                    new += per_remote(r)
        if per_intg:
            for i in d.integrations:
                if i not in seen_i:
                    seen_i.add(i)
                    new += per_intg(i)
        if new:
            async_add_entities(new)

    check()
    return coordinator.async_add_listener(check)
