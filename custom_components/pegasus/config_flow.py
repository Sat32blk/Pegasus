"""Set up Pegasus: the hub's address, port and (if it has one) its page password."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_PORT
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .api import PegasusApi, PegasusAuthError, PegasusError
from .const import DEFAULT_HOST, DEFAULT_PORT, DOMAIN


def _schema(d: Mapping[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(CONF_HOST, default=d.get(CONF_HOST, DEFAULT_HOST)): str,
            vol.Required(CONF_PORT, default=d.get(CONF_PORT, DEFAULT_PORT)): vol.All(int, vol.Range(min=1, max=65535)),
            vol.Optional(CONF_PASSWORD, default=d.get(CONF_PASSWORD, "")): str,
        }
    )


class PegasusConfigFlow(ConfigFlow, domain=DOMAIN):
    """Asks for the hub and checks it answers."""

    VERSION = 1

    async def _check(self, data: dict[str, Any]) -> tuple[dict[str, str], dict[str, Any] | None]:
        api = PegasusApi(async_get_clientsession(self.hass), data[CONF_HOST], data[CONF_PORT], data.get(CONF_PASSWORD) or None)
        try:
            return {}, await api.status()
        except PegasusAuthError:
            return {"base": "invalid_auth"}, None
        except PegasusError:
            return {"base": "cannot_connect"}, None

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            user_input[CONF_HOST] = user_input[CONF_HOST].strip().removeprefix("http://").rstrip("/")
            await self.async_set_unique_id(f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}")
            self._abort_if_unique_id_configured()
            errors, status = await self._check(user_input)
            if not errors:
                return self.async_create_entry(title="Pegasus Hub", data=user_input, description_placeholders={"version": status.get("version", "")})
        return self.async_show_form(step_id="user", data_schema=_schema(user_input or {}), errors=errors)

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            data = {**entry.data, CONF_PASSWORD: user_input[CONF_PASSWORD]}
            errors, _ = await self._check(data)
            if not errors:
                return self.async_update_reload_and_abort(entry, data=data)
        return self.async_show_form(step_id="reauth_confirm", data_schema=vol.Schema({vol.Required(CONF_PASSWORD): str}), errors=errors)

    async def async_step_reconfigure(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        entry = self._get_reconfigure_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            user_input[CONF_HOST] = user_input[CONF_HOST].strip().removeprefix("http://").rstrip("/")
            errors, _ = await self._check(user_input)
            if not errors:
                return self.async_update_reload_and_abort(entry, data=user_input, unique_id=f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}")
        return self.async_show_form(step_id="reconfigure", data_schema=_schema(user_input or entry.data), errors=errors)
