"""Home Assistant tests for the Pegasus integration, against a real (demo) Pegasus Hub."""

import os

import pytest

HUB_PORT = int(os.environ.get("PEGASUS_TEST_PORT", "9611"))
PW_PORT = int(os.environ.get("PEGASUS_TEST_PW_PORT", "9612"))


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    yield


@pytest.fixture(autouse=True)
def allow_local_hubs():
    """The tests talk to real demo hubs on 127.0.0.1 (and nowhere else)."""
    import pytest_socket

    pytest_socket.enable_socket()
    pytest_socket.socket_allow_hosts(["127.0.0.1"], allow_unix_socket=True)
    yield
