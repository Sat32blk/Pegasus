"""The Pegasus integration against running demo hubs (one plain, one with a page password)."""

import aiohttp
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant import config_entries
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_PORT
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers import device_registry as dr, entity_registry as er

from custom_components.pegasus.const import DOMAIN

from .conftest import HUB_PORT, PW_PORT




async def hub_state(intg_id: str) -> str:
    async with aiohttp.ClientSession() as s, s.get(f"http://127.0.0.1:{HUB_PORT}/api/integrations") as r:
        return next(i for i in await r.json() if i["id"] == intg_id)["status"]["state"]


async def test_config_flow(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    # nothing there
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_HOST: "127.0.0.1", CONF_PORT: 1, CONF_PASSWORD: ""})
    assert result["errors"] == {"base": "cannot_connect"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_HOST: "http://127.0.0.1/", CONF_PORT: HUB_PORT, CONF_PASSWORD: ""})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"][CONF_HOST] == "127.0.0.1"
    await hass.async_block_till_done()
    # the same hub again
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_HOST: "127.0.0.1", CONF_PORT: HUB_PORT, CONF_PASSWORD: ""})
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "already_configured"


async def test_password(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_HOST: "127.0.0.1", CONF_PORT: PW_PORT, CONF_PASSWORD: ""})
    assert result["errors"] == {"base": "invalid_auth"}
    result = await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_HOST: "127.0.0.1", CONF_PORT: PW_PORT, CONF_PASSWORD: "s3cret"})
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()
    entry = hass.config_entries.async_entries(DOMAIN)[0]
    assert entry.state is config_entries.ConfigEntryState.LOADED
    # the password changes on the hub side: Home Assistant asks again
    hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_PASSWORD: "old"})
    await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    flows = hass.config_entries.flow.async_progress()
    assert any(f["context"]["source"] == "reauth" for f in flows)
    flow = next(f for f in flows if f["context"]["source"] == "reauth")
    result = await hass.config_entries.flow.async_configure(flow["flow_id"], {CONF_PASSWORD: "s3cret"})
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "reauth_successful"


async def test_entities(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN, title="Pegasus Hub", data={CONF_HOST: "127.0.0.1", CONF_PORT: HUB_PORT, CONF_PASSWORD: ""}, unique_id=f"127.0.0.1:{HUB_PORT}")
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    devices = {d.name: d for d in dr.async_get(hass).devices.get_devices_for_config_entry_id(entry.entry_id)}
    assert {"Pegasus Hub", "Remote3-demo", "Simulated Node driver", "Simulated Python driver"} <= set(devices)
    ents = {e.unique_id.replace(entry.entry_id + "_", ""): e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)}

    # hub
    assert hass.states.get(ents["running"]).state == "2"
    assert float(hass.states.get(ents["memory"]).state) > 0
    # the remote: link, battery and the saving since the first move (the demo hub has 6 days of readings)
    r = "remote_Remote3-demo.local_"
    assert hass.states.get(ents[r + "linked"]).state == "on"
    assert hass.states.get(ents[r + "asleep"]).state == "off"
    assert float(hass.states.get(ents[r + "round_trip"]).state) >= 0
    assert 0 < float(hass.states.get(ents[r + "battery"]).state) <= 100
    saved = hass.states.get(ents[r + "battery_saved"])
    assert float(saved.state) > 0 and saved.attributes["confidence"] in ("low", "fair", "good")
    assert float(hass.states.get(ents[r + "days_per_charge"]).state) > 0
    assert float(hass.states.get(ents[r + "load"]).state) >= 0
    # an integration: state, switch, update, restart
    i = "intg_sim_python_"
    assert hass.states.get(ents[i + "state"]).state == "running"
    assert hass.states.get(ents[i + "running"]).state == "on"
    assert hass.states.get(ents[i + "update"]).state == "off"  # no newer release
    await hass.services.async_call("switch", "turn_off", {"entity_id": ents[i + "running"]}, blocking=True)
    await hass.async_block_till_done()
    assert await hub_state("sim_python") == "stopped"
    assert hass.states.get(ents[i + "running"]).state == "off"
    assert hass.states.get(ents[i + "state"]).state == "stopped"
    await hass.services.async_call("switch", "turn_on", {"entity_id": ents[i + "running"]}, blocking=True)
    assert await hub_state("sim_python") in ("starting", "running")
    await hass.services.async_call("button", "press", {"entity_id": ents[i + "restart"]}, blocking=True)
    assert await hub_state("sim_python") in ("starting", "running")
    # an integration installed on the hub later shows up by itself
    assert await hass.config_entries.async_unload(entry.entry_id)
