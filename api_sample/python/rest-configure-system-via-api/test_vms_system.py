# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for vms_system.py. No network, no server needed.

VmsSystem always builds its own `requests.Session()` and reads
"cloud_hosts.json" from the current directory, so every test:
  1. `monkeypatch.chdir(tmp_path)` and writes a `cloud_hosts.json` there.
  2. Writes a config `.ini` file there too, then constructs `VmsSystem(...)`.
  3. Swaps `vms.session` for a `FakeSession` that serves queued responses.

Run from this folder:  pytest -v
"""

import configparser
import json

import pytest
import requests

import vms_system as sample


CLOUD_HOSTS = {
    "version": "1.0",
    "data": [
        {"Nx Witness": {"customization": "default", "cloud_host": "nxvms.com"}},
        {"Nx EVOS": {"customization": "metavms", "cloud_host": "meta.nxvms.com"}},
    ],
}


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class FakeResponse:
    """Mimics enough of requests.Response for vms_system.py's raise_for_status() style."""

    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            error = requests.exceptions.HTTPError(f"{self.status_code} Error")
            error.response = self
            raise error

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeSession:
    """Serves queued responses per verb, in order, and records every call."""

    def __init__(self, post=None, get=None, patch=None, delete=None):
        self.calls = []
        self._queues = {
            "post": list(post or []),
            "get": list(get or []),
            "patch": list(patch or []),
            "delete": list(delete or []),
        }

    def _pop(self, verb):
        queue = self._queues[verb]
        if not queue:
            raise AssertionError(f"No queued {verb} response left")
        return queue.pop(0)

    def post(self, url, json=None, headers=None, timeout=None, verify=None, allow_redirects=None):
        self.calls.append(("post", url, json, headers))
        return self._pop("post")

    def get(self, url, timeout=None, verify=None, allow_redirects=None):
        self.calls.append(("get", url, None, None))
        return self._pop("get")

    def patch(self, url, json=None, timeout=None, verify=None, allow_redirects=None):
        self.calls.append(("patch", url, json, None))
        return self._pop("patch")

    def delete(self, url, timeout=None, verify=None):
        self.calls.append(("delete", url, None, None))
        return self._pop("delete")


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

def _write_config(tmp_path, **overrides):
    """Write a system_setting.conf-style file into tmp_path and return its path."""
    values = {
        "server": {
            "ip_address": "127.0.0.1",
            "port": "7001",
            "system_name": "TestSystem",
            "local_admin_password": "adminpw",
        },
        "cloud": {
            "cloud_account": "user@example.com",
            "cloud_password": "cloudpw",
            "connect_to_organization": "False",
        },
        "system_settings": {
            "product": "Nx EVOS",
            "organization_id": "",
            "connect_to_cloud": "True",
            "enable_auto_discovery": "True",
            "allow_anonymous_statistics_report": "True",
            "enable_camera_optimization": "True",
        },
    }
    for section, keys in overrides.items():
        values[section].update(keys)

    parser = configparser.ConfigParser()
    for section, keys in values.items():
        parser[section] = keys

    config_path = tmp_path / "system_setting.conf"
    with open(config_path, "w") as handle:
        parser.write(handle)
    return config_path


@pytest.fixture
def make_vms(tmp_path, monkeypatch):
    """Factory fixture: make_vms(**overrides) -> a ready-to-use VmsSystem with a FakeSession."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "cloud_hosts.json").write_text(json.dumps(CLOUD_HOSTS))

    def build(**overrides):
        config_path = _write_config(tmp_path, **overrides)
        return sample.VmsSystem(str(config_path), session=FakeSession())

    return build


# ---------------------------------------------------------------------------
# __init__
# ---------------------------------------------------------------------------

def test_init_loads_server_and_product_settings(make_vms):
    vms = make_vms()

    assert vms.local_url == "https://127.0.0.1:7001"
    assert vms.system_name == "TestSystem"
    assert vms.local_admin_password == "adminpw"
    assert vms.customization == "metavms"       # from the "Nx EVOS" entry
    assert vms.cloud_host == "meta.nxvms.com"
    assert vms.cloud_url == "https://meta.nxvms.com"
    assert vms.connect_to_cloud is True
    assert vms.enable_auto_discovery is True


def test_init_unknown_product_leaves_cloud_fields_empty(make_vms, caplog):
    vms = make_vms(system_settings={"product": "Unknown Product"})
    assert vms.customization == ""
    assert vms.cloud_host == ""


def test_init_missing_config_file_raises(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "cloud_hosts.json").write_text(json.dumps(CLOUD_HOSTS))

    with pytest.raises(configparser.Error):
        sample.VmsSystem(str(tmp_path / "does_not_exist.conf"))


def test_init_missing_cloud_hosts_json_raises(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    config_path = _write_config(tmp_path)  # no cloud_hosts.json written

    with pytest.raises(FileNotFoundError):
        sample.VmsSystem(str(config_path))


def test_init_missing_config_key_raises_keyerror(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "cloud_hosts.json").write_text(json.dumps(CLOUD_HOSTS))

    parser = configparser.ConfigParser()
    parser["server"] = {"ip_address": "127.0.0.1"}  # missing port/system_name/password
    parser["cloud"] = {"cloud_account": "a", "cloud_password": "b",
                        "connect_to_organization": "False"}
    parser["system_settings"] = {"product": "Nx EVOS", "organization_id": "",
                                  "connect_to_cloud": "True",
                                  "enable_auto_discovery": "True",
                                  "allow_anonymous_statistics_report": "True",
                                  "enable_camera_optimization": "True"}
    config_path = tmp_path / "bad.conf"
    with open(config_path, "w") as handle:
        parser.write(handle)

    with pytest.raises(KeyError):
        sample.VmsSystem(str(config_path))


def test_init_uses_the_injected_session(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "cloud_hosts.json").write_text(json.dumps(CLOUD_HOSTS))
    config_path = _write_config(tmp_path)
    fake = FakeSession()

    vms = sample.VmsSystem(str(config_path), session=fake)

    assert vms.session is fake


def test_init_defaults_to_its_own_isolated_session(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "cloud_hosts.json").write_text(json.dumps(CLOUD_HOSTS))
    config_path = _write_config(tmp_path)

    vms_a = sample.VmsSystem(str(config_path))
    vms_b = sample.VmsSystem(str(config_path))

    assert isinstance(vms_a.session, requests.Session)
    assert vms_a.session is not vms_b.session  # each system gets its own


# ---------------------------------------------------------------------------
# login() / token helpers
# ---------------------------------------------------------------------------

def test_login_local_success(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(200, {"token": "localtok"})])

    header = vms.login("admin", "adminpw")

    assert header == {"Authorization": "Bearer localtok"}
    assert vms.session.calls[-1][1] == "https://127.0.0.1:7001/rest/v3/login/sessions"


def test_login_local_failure_returns_empty_header(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(401, text="bad")])

    assert vms.login("admin", "wrong") == {}


def test_login_cloud_success(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(200, {"access_token": "cdbtok"})])

    header = vms.login("user@example.com", "cloudpw", "cloud")

    assert header == {"Authorization": "Bearer cdbtok"}
    assert vms.session.calls[-1][1] == "https://meta.nxvms.com/cdb/oauth2/token"


def test_login_cloud_failure_returns_empty_header(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(401, text="bad")])

    assert vms.login("user@example.com", "wrong", "cloud") == {}


# ---------------------------------------------------------------------------
# get_current_system_settings()
# ---------------------------------------------------------------------------

def test_get_current_system_settings_merges_api_response(make_vms):
    vms = make_vms()
    vms.session = FakeSession(get=[FakeResponse(200, {
        "systemName": "RenamedSystem",
        "cloudSystemID": "sys-123",
        "autoDiscoveryEnabled": False,
    })])

    settings = vms.get_current_system_settings()

    assert settings["systemName"] == "RenamedSystem"
    assert settings["cloudSystemID"] == "sys-123"
    assert settings["autoDiscoveryEnabled"] is False
    # Untouched keys keep the constructor's defaults.
    assert settings["cameraSettingsOptimization"] is True


def test_get_current_system_settings_failure_reports_unknown(make_vms, capsys):
    vms = make_vms()
    vms.session = FakeSession(get=[FakeResponse(500, text="boom")])

    settings = vms.get_current_system_settings()

    assert settings["cloudSystemID"] == sample.STATE_UNKNOWN
    assert settings["autoDiscoveryEnabled"] == sample.STATE_UNKNOWN
    assert "[ERROR]" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# _connect_system_to_cloud() / _detach_system_from_cloud()
# ---------------------------------------------------------------------------

def test_connect_system_to_cloud_personal_account(make_vms):
    vms = make_vms(cloud={"connect_to_organization": "False"})
    vms.session = FakeSession(post=[
        FakeResponse(200, {"access_token": "cdbtok"}),          # cloud login
        FakeResponse(200, {"id": "sys-1", "authKey": "key-1"}),  # cdb/systems/bind
        FakeResponse(200, {"token": "localtok"}),                # local login
        FakeResponse(200, {}),                                   # local cloud/bind
    ])

    assert vms._connect_system_to_cloud() is True

    bind_call = vms.session.calls[1]
    assert bind_call[1] == "https://meta.nxvms.com/cdb/systems/bind"
    assert "organization" not in bind_call[2]

    local_bind_call = vms.session.calls[3]
    assert local_bind_call[1] == "https://127.0.0.1:7001/rest/v3/system/cloud/bind"
    assert local_bind_call[2] == {
        "systemId": "sys-1", "authKey": "key-1", "owner": "user@example.com",
    }


def test_connect_system_to_cloud_organization(make_vms):
    vms = make_vms(
        cloud={"connect_to_organization": "True"},
        system_settings={"organization_id": "org-42"},
    )
    vms.session = FakeSession(post=[
        FakeResponse(200, {"access_token": "cdbtok"}),
        FakeResponse(200, {"id": "sys-1", "authKey": "key-1"}),
        FakeResponse(200, {"token": "localtok"}),
        FakeResponse(200, {}),
    ])

    assert vms._connect_system_to_cloud() is True

    bind_call = vms.session.calls[1]
    assert bind_call[1] == "https://meta.nxvms.com/partners/api/v3/cloud_systems/"
    assert bind_call[2]["organization"] == "org-42"

    local_bind_call = vms.session.calls[3]
    assert local_bind_call[2]["organizationId"] == "org-42"


def test_connect_system_to_cloud_cloud_login_failure_stops_early(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(401, text="bad")])

    assert vms._connect_system_to_cloud() is False
    assert len(vms.session.calls) == 1  # never got to the bind calls


def test_detach_system_from_cloud_success(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(200, {})])

    assert vms._detach_system_from_cloud() is True
    call = vms.session.calls[-1]
    assert call[1] == "https://127.0.0.1:7001/rest/v3/system/cloud/unbind"
    assert call[2] == {"password": "adminpw", "userAgent": "3rd_party_tool"}


def test_detach_system_from_cloud_failure(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(500, text="boom")])

    assert vms._detach_system_from_cloud() is False


# ---------------------------------------------------------------------------
# _setup_connect_to_cloud()
# ---------------------------------------------------------------------------

def test_setup_connect_to_cloud_already_connected(make_vms, monkeypatch):
    vms = make_vms(system_settings={"connect_to_cloud": "True"})
    connect_spy = []
    monkeypatch.setattr(vms, "_connect_system_to_cloud", lambda: connect_spy.append(1) or True)

    status = vms._setup_connect_to_cloud("existing-cloud-id")

    assert status == sample.STATE_CONNECTED
    assert connect_spy == []  # never called; already bound


def test_setup_connect_to_cloud_connects_when_not_bound(make_vms, monkeypatch):
    vms = make_vms(system_settings={"connect_to_cloud": "True"})
    monkeypatch.setattr(vms, "_connect_system_to_cloud", lambda: True)

    assert vms._setup_connect_to_cloud("") == sample.STATE_CONNECTED


def test_setup_connect_to_cloud_connect_failure_from_unknown_stays_unknown(make_vms, monkeypatch):
    vms = make_vms(system_settings={"connect_to_cloud": "True"})
    monkeypatch.setattr(vms, "_connect_system_to_cloud", lambda: False)

    status = vms._setup_connect_to_cloud(sample.STATE_UNKNOWN)

    assert status == sample.STATE_UNKNOWN


def test_setup_connect_to_cloud_connect_failure_when_not_bound_reports_disconnected(
    make_vms, monkeypatch
):
    # Regression test: current_cloud_id is "" (not bound, and not UNKNOWN), the
    # connect attempt fails -- desired_cloud_state must land on
    # STATE_DISCONNECTED_LOCAL, not silently stay at the function's STATE_UNKNOWN
    # default.
    vms = make_vms(system_settings={"connect_to_cloud": "True"})
    monkeypatch.setattr(vms, "_connect_system_to_cloud", lambda: False)

    status = vms._setup_connect_to_cloud("")

    assert status == sample.STATE_DISCONNECTED_LOCAL


def test_setup_connect_to_cloud_disconnects_when_bound(make_vms, monkeypatch):
    vms = make_vms(system_settings={"connect_to_cloud": "False"})
    monkeypatch.setattr(vms, "_detach_system_from_cloud", lambda: True)

    assert vms._setup_connect_to_cloud("existing-cloud-id") == sample.STATE_DISCONNECTED_LOCAL


def test_setup_connect_to_cloud_already_disconnected(make_vms, monkeypatch):
    vms = make_vms(system_settings={"connect_to_cloud": "False"})
    detach_spy = []
    monkeypatch.setattr(vms, "_detach_system_from_cloud", lambda: detach_spy.append(1) or True)

    status = vms._setup_connect_to_cloud("")

    assert status == sample.STATE_DISCONNECTED_LOCAL
    assert detach_spy == []  # never called; already not bound


def test_setup_connect_to_cloud_detach_failure_keeps_connected(make_vms, monkeypatch):
    vms = make_vms(system_settings={"connect_to_cloud": "False"})
    monkeypatch.setattr(vms, "_detach_system_from_cloud", lambda: False)

    assert vms._setup_connect_to_cloud("existing-cloud-id") == sample.STATE_CONNECTED


# ---------------------------------------------------------------------------
# _update_system_settings() and the small wrappers around it
# ---------------------------------------------------------------------------

def test_update_system_settings_success(make_vms):
    vms = make_vms()
    vms.session = FakeSession(patch=[FakeResponse(200, {})])

    assert vms._update_system_settings({"autoDiscoveryEnabled": True}) is True
    call = vms.session.calls[-1]
    assert call[1] == "https://127.0.0.1:7001/rest/v3/system/settings"
    assert call[2] == {"autoDiscoveryEnabled": True}


def test_update_system_settings_failure(make_vms):
    vms = make_vms()
    vms.session = FakeSession(patch=[FakeResponse(500, text="boom")])

    assert vms._update_system_settings({"autoDiscoveryEnabled": True}) is False


def test_configure_auto_discovery_sets_both_keys(make_vms):
    vms = make_vms()
    vms.session = FakeSession(patch=[FakeResponse(200, {})])

    assert vms._configure_auto_discovery(True) is True
    assert vms.session.calls[-1][2] == {
        "autoDiscoveryEnabled": True, "autoDiscoveryResponseEnabled": True,
    }


def test_configure_camera_optimization(make_vms):
    vms = make_vms()
    vms.session = FakeSession(patch=[FakeResponse(200, {})])

    assert vms._configure_camera_optimization(False) is True
    assert vms.session.calls[-1][2] == {"cameraSettingsOptimization": False}


def test_configure_anonymous_statistics_report(make_vms):
    vms = make_vms()
    vms.session = FakeSession(patch=[FakeResponse(200, {})])

    assert vms._configure_anonymous_statistics_report(True) is True
    assert vms.session.calls[-1][2] == {"statisticsAllowed": True}


# ---------------------------------------------------------------------------
# _set_system_name()
# ---------------------------------------------------------------------------

def test_set_system_name_succeeds_on_first_try(make_vms):
    vms = make_vms()
    vms.session = FakeSession(patch=[FakeResponse(200, {})])

    assert vms._set_system_name() is True
    assert len(vms.session.calls) == 1


def test_set_system_name_falls_back_and_succeeds(make_vms):
    vms = make_vms()
    vms.session = FakeSession(patch=[FakeResponse(500, text="boom"), FakeResponse(200, {})])

    assert vms._set_system_name() is True
    assert len(vms.session.calls) == 2


def test_set_system_name_falls_back_and_fails(make_vms):
    vms = make_vms()
    vms.session = FakeSession(patch=[FakeResponse(500, text="boom"), FakeResponse(500, text="boom")])

    assert vms._set_system_name() is False


# ---------------------------------------------------------------------------
# _setup_boolean_feature()
# ---------------------------------------------------------------------------

def test_setup_boolean_feature_already_desired_state_is_noop(make_vms):
    vms = make_vms()
    calls = []
    status = vms._setup_boolean_feature(
        "Auto Discovery", current_feature_state=True, desired_enabled_state=True,
        configure_func=lambda state: calls.append(state) or True)

    assert status == sample.STATE_ENABLED
    assert calls == []  # nothing needed to change


def test_setup_boolean_feature_changes_state_successfully(make_vms):
    vms = make_vms()
    calls = []
    status = vms._setup_boolean_feature(
        "Auto Discovery", current_feature_state=False, desired_enabled_state=True,
        configure_func=lambda state: calls.append(state) or True)

    assert status == sample.STATE_ENABLED
    assert calls == [True]


def test_setup_boolean_feature_change_fails_reports_previous_state(make_vms):
    vms = make_vms()
    status = vms._setup_boolean_feature(
        "Auto Discovery", current_feature_state=False, desired_enabled_state=True,
        configure_func=lambda state: False)

    assert status == sample.STATE_DISABLED  # stayed at its previous (False) state


def test_setup_boolean_feature_from_unknown_success(make_vms):
    vms = make_vms()
    status = vms._setup_boolean_feature(
        "Auto Discovery", current_feature_state=sample.STATE_UNKNOWN,
        desired_enabled_state=True, configure_func=lambda state: True)

    assert status == sample.STATE_ENABLED


def test_setup_boolean_feature_from_unknown_failure(make_vms):
    vms = make_vms()
    status = vms._setup_boolean_feature(
        "Auto Discovery", current_feature_state=sample.STATE_UNKNOWN,
        desired_enabled_state=True, configure_func=lambda state: False)

    assert status == sample.STATE_UNKNOWN


# ---------------------------------------------------------------------------
# setup_system() -- the full orchestration, with everything mocked at the
# session level so it never touches the network.
# ---------------------------------------------------------------------------

def test_setup_system_login_failure_short_circuits(make_vms, monkeypatch):
    vms = make_vms()
    # Initial "admin"/"admin" login attempt, then the real one -- both fail.
    monkeypatch.setattr(vms, "login", lambda *a, **k: {})
    monkeypatch.setattr(vms, "_initialize_system", lambda: None)
    monkeypatch.setattr(vms, "_logout_current_session", lambda: None)

    result = vms.setup_system()

    assert result["error"] == "Login with configured local admin password failed."
    assert result["connect_to_cloud"] == sample.STATE_UNKNOWN


def test_setup_system_full_flow(make_vms, monkeypatch):
    vms = make_vms(system_settings={"connect_to_cloud": "False"})

    monkeypatch.setattr(vms, "login", lambda *a, **k: {"Authorization": "Bearer tok"})
    monkeypatch.setattr(vms, "_initialize_system", lambda: True)
    monkeypatch.setattr(vms, "_logout_current_session", lambda: None)
    monkeypatch.setattr(vms, "get_current_system_settings", lambda: {
        "systemName": "TestSystem",
        "cloudSystemID": "",
        "autoDiscoveryEnabled": False,
        "cameraSettingsOptimization": False,
        "statisticsAllowed": False,
    })
    monkeypatch.setattr(vms, "_configure_auto_discovery", lambda state: True)
    monkeypatch.setattr(vms, "_configure_camera_optimization", lambda state: True)
    monkeypatch.setattr(vms, "_configure_anonymous_statistics_report", lambda state: True)

    result = vms.setup_system()

    assert result["system_name"] == "TestSystem"
    assert result["connect_to_cloud"] == sample.STATE_DISCONNECTED_LOCAL
    assert result["auto_discovery"] == sample.STATE_ENABLED
    assert result["camera_optimization"] == sample.STATE_ENABLED
    assert result["anonymous_statistics_report"] == sample.STATE_ENABLED
