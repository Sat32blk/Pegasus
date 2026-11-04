"""Pegasus sensors: the hub, each linked remote (link, battery, saving, load) and each integration."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity, SensorEntityDescription, SensorStateClass
from homeassistant.const import PERCENTAGE, EntityCategory, UnitOfDataRate, UnitOfInformation, UnitOfTime
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import PegasusConfigEntry
from .coordinator import PegasusData
from .entity import IntegrationEntity, PegasusEntity, RemoteEntity, add_new


@dataclass(frozen=True, kw_only=True)
class HubSensor(SensorEntityDescription):
    value: Callable[[PegasusData], Any]


@dataclass(frozen=True, kw_only=True)
class RemoteSensor(SensorEntityDescription):
    value: Callable[[PegasusData, str], Any]


@dataclass(frozen=True, kw_only=True)
class IntgSensor(SensorEntityDescription):
    value: Callable[[dict[str, Any], dict[str, Any]], Any]  # (integration, its traffic figures)


def _sum(d: PegasusData, k: str) -> float:
    return round(sum((i.get("usage") or {}).get(k) or 0 for i in d.integrations.values()), 1)


def _artwork_saved(d: PegasusData) -> float | None:
    s = (d.artwork or {}).get("stats") or {}
    o = s.get("originalBytes") or 0
    return round((1 - (s.get("sentBytes") or 0) / o) * 100) if o else None


HUB: tuple[HubSensor, ...] = (
    HubSensor(key="running", translation_key="running", state_class=SensorStateClass.MEASUREMENT,
              value=lambda d: sum(1 for i in d.integrations.values() if i["status"]["state"] == "running")),
    HubSensor(key="cpu", translation_key="cpu", native_unit_of_measurement=PERCENTAGE, state_class=SensorStateClass.MEASUREMENT,
              suggested_display_precision=1, value=lambda d: _sum(d, "cpu")),
    HubSensor(key="memory", translation_key="memory", device_class=SensorDeviceClass.DATA_SIZE, native_unit_of_measurement=UnitOfInformation.MEGABYTES,
              state_class=SensorStateClass.MEASUREMENT, value=lambda d: round(_sum(d, "memMB") + (d.status.get("hubMemMB") or 0))),
    HubSensor(key="artwork_saved", translation_key="artwork_saved", native_unit_of_measurement=PERCENTAGE, entity_category=EntityCategory.DIAGNOSTIC,
              value=_artwork_saved),
    HubSensor(key="version", translation_key="version", entity_category=EntityCategory.DIAGNOSTIC, value=lambda d: d.status.get("version")),
)


def _net(d: PegasusData, r: str) -> dict[str, Any]:
    return d.network.get(r) or {}


def _batt(d: PegasusData, r: str) -> dict[str, Any]:
    return d.battery.get(r) or {}


def _last_level(d: PegasusData, r: str) -> Any:
    b = _batt(d, r)
    last = ((b.get("after") or {}).get("last")) or ((b.get("before") or {}).get("last"))
    return last.get("level") if last else None


def _res(d: PegasusData, r: str) -> dict[str, Any]:
    return (d.remote_resources.get(r) or {}).get("last") or {}


REMOTE: tuple[RemoteSensor, ...] = (
    RemoteSensor(key="round_trip", translation_key="round_trip", native_unit_of_measurement=UnitOfTime.MILLISECONDS, device_class=SensorDeviceClass.DURATION,
                 state_class=SensorStateClass.MEASUREMENT, suggested_display_precision=1,
                 value=lambda d, r: (d.remotes.get(r) or {}).get("rttMs")),
    RemoteSensor(key="traffic", translation_key="traffic", native_unit_of_measurement=UnitOfDataRate.BYTES_PER_SECOND, device_class=SensorDeviceClass.DATA_RATE,
                 state_class=SensorStateClass.MEASUREMENT, suggested_display_precision=0,
                 value=lambda d, r: round(((_net(d, r).get("rate") or {}).get("inBps") or 0) + ((_net(d, r).get("rate") or {}).get("outBps") or 0))),
    RemoteSensor(key="messages", translation_key="messages", native_unit_of_measurement="msg/min", state_class=SensorStateClass.MEASUREMENT,
                 suggested_display_precision=0, value=lambda d, r: (_net(d, r).get("rate") or {}).get("msgsPerMin")),
    RemoteSensor(key="reconnects", translation_key="reconnects", entity_category=EntityCategory.DIAGNOSTIC, state_class=SensorStateClass.MEASUREMENT,
                 value=lambda d, r: _net(d, r).get("reconnects")),
    RemoteSensor(key="battery", translation_key="battery", device_class=SensorDeviceClass.BATTERY, native_unit_of_measurement=PERCENTAGE,
                 state_class=SensorStateClass.MEASUREMENT, value=_last_level),
    RemoteSensor(key="battery_saved", translation_key="battery_saved", native_unit_of_measurement="%/d", state_class=SensorStateClass.MEASUREMENT,
                 suggested_display_precision=1, value=lambda d, r: (_batt(d, r).get("saving") or {}).get("percentPerDay")),
    RemoteSensor(key="days_per_charge", translation_key="days_per_charge", native_unit_of_measurement=UnitOfTime.DAYS, device_class=SensorDeviceClass.DURATION,
                 suggested_display_precision=1,
                 value=lambda d, r: (_batt(d, r).get("saving") or {}).get("daysPerChargeAfter") or ((_batt(d, r).get("after") or _batt(d, r).get("before") or {}).get("hoursPerCharge") or 0) / 24 or None),
    RemoteSensor(key="drain_awake", translation_key="drain_awake", native_unit_of_measurement="%/h", state_class=SensorStateClass.MEASUREMENT,
                 suggested_display_precision=2, value=lambda d, r: ((_batt(d, r).get("after") or _batt(d, r).get("before") or {}).get("drainPerHour") or {}).get("awake")),
    RemoteSensor(key="drain_asleep", translation_key="drain_asleep", native_unit_of_measurement="%/h", state_class=SensorStateClass.MEASUREMENT,
                 suggested_display_precision=2, value=lambda d, r: ((_batt(d, r).get("after") or _batt(d, r).get("before") or {}).get("drainPerHour") or {}).get("asleep")),
    RemoteSensor(key="load", translation_key="load", state_class=SensorStateClass.MEASUREMENT, suggested_display_precision=2,
                 value=lambda d, r: _res(d, r).get("load1")),
    RemoteSensor(key="memory_used", translation_key="memory_used", device_class=SensorDeviceClass.DATA_SIZE, native_unit_of_measurement=UnitOfInformation.MEGABYTES,
                 state_class=SensorStateClass.MEASUREMENT, value=lambda d, r: _res(d, r).get("memUsedMB")),
)

STATES = ["running", "starting", "stopped", "crashed", "error"]

INTG: tuple[IntgSensor, ...] = (
    IntgSensor(key="state", translation_key="state", device_class=SensorDeviceClass.ENUM, options=STATES,
               value=lambda m, n: m["status"]["state"] if m["status"]["state"] in STATES else None),
    IntgSensor(key="cpu", translation_key="cpu", native_unit_of_measurement=PERCENTAGE, state_class=SensorStateClass.MEASUREMENT,
               suggested_display_precision=1, value=lambda m, n: (m.get("usage") or {}).get("cpu")),
    IntgSensor(key="memory", translation_key="memory", device_class=SensorDeviceClass.DATA_SIZE, native_unit_of_measurement=UnitOfInformation.MEGABYTES,
               state_class=SensorStateClass.MEASUREMENT, value=lambda m, n: (m.get("usage") or {}).get("memMB")),
    IntgSensor(key="answers_in", translation_key="answers_in", native_unit_of_measurement=UnitOfTime.MILLISECONDS, device_class=SensorDeviceClass.DURATION,
               suggested_display_precision=1, entity_category=EntityCategory.DIAGNOSTIC,
               value=lambda m, n: ((n or {}).get("response") or {}).get("median")),
    IntgSensor(key="not_sent", translation_key="not_sent", state_class=SensorStateClass.TOTAL_INCREASING, entity_category=EntityCategory.DIAGNOSTIC,
               value=lambda m, n: (lambda s: (s.get("unsubscribed", 0) + s.get("repeat", 0) + s.get("merged", 0)) if s else None)((n or {}).get("shaped"))),
)


async def async_setup_entry(hass: HomeAssistant, entry: PegasusConfigEntry, async_add_entities: AddEntitiesCallback) -> None:
    c = entry.runtime_data
    entry.async_on_unload(add_new(
        c, async_add_entities,
        hub=lambda: [HubSensorEntity(c, d) for d in HUB],
        per_remote=lambda r: [RemoteSensorEntity(c, r, d) for d in REMOTE],
        per_intg=lambda i: [IntgSensorEntity(c, i, d) for d in INTG],
    ))


class HubSensorEntity(PegasusEntity, SensorEntity):
    entity_description: HubSensor

    def __init__(self, c, d: HubSensor) -> None:
        super().__init__(c, d.key)
        self.entity_description = d

    @property
    def native_value(self) -> Any:
        return self.entity_description.value(self.coordinator.data)


class RemoteSensorEntity(RemoteEntity, SensorEntity):
    entity_description: RemoteSensor

    def __init__(self, c, remote: str, d: RemoteSensor) -> None:
        super().__init__(c, remote, d.key)
        self.entity_description = d

    @property
    def native_value(self) -> Any:
        return self.entity_description.value(self.coordinator.data, self.remote)

    @property
    def extra_state_attributes(self) -> dict[str, Any] | None:
        if self.entity_description.key != "battery_saved":
            return None
        s = (self.coordinator.data.battery.get(self.remote) or {}).get("saving") or {}
        split = (self.coordinator.data.battery.get(self.remote) or {}).get("split")
        return {"confidence": s.get("confidence"), "hours_before": s.get("hoursBefore"), "hours_after": s.get("hoursAfter"),
                "days_per_charge_before": s.get("daysPerChargeBefore"), "first_move": split} if s else None


class IntgSensorEntity(IntegrationEntity, SensorEntity):
    entity_description: IntgSensor

    def __init__(self, c, intg_id: str, d: IntgSensor) -> None:
        super().__init__(c, intg_id, d.key)
        self.entity_description = d

    @property
    def native_value(self) -> Any:
        return self.entity_description.value(self.intg, self.coordinator.data.net_integrations.get(self.intg_id))
