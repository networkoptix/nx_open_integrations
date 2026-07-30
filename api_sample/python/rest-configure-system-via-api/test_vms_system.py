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

    def get(self, url, headers=None, timeout=None, verify=None, allow_redirects=None):
        self.calls.append(("get", url, None, headers))
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
        # setdefault so overrides can introduce whole new sections, e.g. [hive].
        values.setdefault(section, {}).update(keys)

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
# [hive] parsing -- which servers, if any, this one absorbs
# ---------------------------------------------------------------------------

def test_init_without_hive_section_has_no_merge_targets(make_vms):
    # A follower or a plain standalone server: configures itself, absorbs nothing.
    assert make_vms().merge_targets == []


def test_init_parses_hive_merge_list(make_vms):
    vms = make_vms(hive={"merge": "10.0.0.2:7001, 10.0.0.3:7001"})
    assert vms.merge_targets == ["10.0.0.2:7001", "10.0.0.3:7001"]


def test_init_hive_merge_list_ignores_blank_entries(make_vms):
    # Trailing commas are easy to leave behind when editing the list by hand.
    vms = make_vms(hive={"merge": "10.0.0.2:7001,,  ,10.0.0.3:7001,"})
    assert vms.merge_targets == ["10.0.0.2:7001", "10.0.0.3:7001"]


def test_init_empty_hive_merge_value_has_no_merge_targets(make_vms):
    assert make_vms(hive={"merge": ""}).merge_targets == []


# ---------------------------------------------------------------------------
# login() / token helpers
# ---------------------------------------------------------------------------

def test_login_local_success(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(200, {"token": "localtok"})])

    header = vms.login("admin", "adminpw")

    assert header == {"Authorization": "Bearer localtok"}
    assert vms.session.calls[-1][1] == "https://127.0.0.1:7001/rest/v4/login/sessions"


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


def test_get_remote_access_token_targets_the_other_server(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(200, {"token": "remotetok"})])

    token = vms._get_remote_access_token_via_ms("admin", "adminpw", "10.0.0.2", 7001)

    assert token == "remotetok"
    assert vms.session.calls[-1][1] == "https://10.0.0.2:7001/rest/v4/login/sessions"


def test_get_remote_access_token_does_not_repoint_this_system(make_vms):
    # This object describes the local server. Logging in to a follower must not
    # leave it believing it *is* that follower.
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(200, {"token": "remotetok"})])

    vms._get_remote_access_token_via_ms("admin", "adminpw", "10.0.0.2", 7001)

    assert vms.ip_address == "127.0.0.1"
    assert vms.port == "7001"
    assert vms.local_url == "https://127.0.0.1:7001"


def test_get_remote_access_token_failure_returns_none(make_vms):
    # Expected while a follower is still setting itself up, so this must be a
    # quiet None rather than an exception.
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(401, text="not ready")])

    assert vms._get_remote_access_token_via_ms("admin", "adminpw", "10.0.0.2", 7001) is None


# ---------------------------------------------------------------------------
# get_current_system_settings()
# ---------------------------------------------------------------------------

def test_get_current_system_settings_merges_api_response(make_vms):
    vms = make_vms()
    vms.session = FakeSession(get=[FakeResponse(200, {
        "siteName": "RenamedSystem",
        "cloudId": "sys-123",
        "autoDiscoveryEnabled": False,
    })])

    settings = vms.get_current_system_settings()

    assert settings["siteName"] == "RenamedSystem"
    assert settings["cloudId"] == "sys-123"
    assert settings["autoDiscoveryEnabled"] is False
    # Untouched keys keep the constructor's defaults.
    assert settings["cameraSettingsOptimization"] is True


def test_get_current_system_settings_failure_reports_unknown(make_vms, capsys):
    vms = make_vms()
    vms.session = FakeSession(get=[FakeResponse(500, text="boom")])

    settings = vms.get_current_system_settings()

    assert settings["cloudId"] == sample.STATE_UNKNOWN
    assert settings["autoDiscoveryEnabled"] == sample.STATE_UNKNOWN
    assert "[ERROR]" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# merge_sites() / get_merge_status()
# ---------------------------------------------------------------------------

def test_merge_sites_posts_remote_endpoint_and_token(make_vms):
    vms = make_vms()
    vms.session = FakeSession(post=[
        FakeResponse(200, {"token": "remotetok"}),  # login to the follower
        FakeResponse(200, {"token": "localtok"}),   # login to ourselves
        FakeResponse(200, {}),                      # the merge itself
    ])

    assert vms.merge_sites("10.0.0.2", 7001) is True

    merge_call = vms.session.calls[-1]
    assert merge_call[1] == "https://127.0.0.1:7001/rest/v4/site/merge"
    assert merge_call[2] == {
        "remoteEndpoint": "10.0.0.2:7001",
        "remoteSessionToken": "remotetok",
    }
    # The merge is authorized as the local admin, not with the follower's token.
    assert merge_call[3] == {"Authorization": "Bearer localtok"}


def test_merge_sites_mints_the_remote_token_before_merging(make_vms):
    # v4 requires a token minted immediately beforehand, so the follower login
    # must be the first call, not a token cached from earlier.
    vms = make_vms()
    vms.session = FakeSession(post=[
        FakeResponse(200, {"token": "remotetok"}),
        FakeResponse(200, {"token": "localtok"}),
        FakeResponse(200, {}),
    ])

    vms.merge_sites("10.0.0.2", 7001)

    urls = [call[1] for call in vms.session.calls]
    assert urls == [
        "https://10.0.0.2:7001/rest/v4/login/sessions",
        "https://127.0.0.1:7001/rest/v4/login/sessions",
        "https://127.0.0.1:7001/rest/v4/site/merge",
    ]


def test_merge_sites_without_remote_token_does_not_merge(make_vms, capsys):
    vms = make_vms()
    vms.session = FakeSession(post=[FakeResponse(401, text="not ready")])

    assert vms.merge_sites("10.0.0.2", 7001) is False
    assert len(vms.session.calls) == 1  # never attempted the merge
    assert "[ERROR]" in capsys.readouterr().out


def test_merge_sites_without_local_login_does_not_merge(make_vms, capsys):
    vms = make_vms()
    vms.session = FakeSession(post=[
        FakeResponse(200, {"token": "remotetok"}),  # follower login works
        FakeResponse(401, text="bad password"),     # our own login does not
    ])

    assert vms.merge_sites("10.0.0.2", 7001) is False
    assert len(vms.session.calls) == 2  # never attempted the merge
    assert "[ERROR]" in capsys.readouterr().out


def test_merge_sites_reports_failure_without_leaking_the_token(make_vms, capsys):
    vms = make_vms()
    vms.session = FakeSession(post=[
        FakeResponse(200, {"token": "remotetok"}),
        FakeResponse(200, {"token": "localtok"}),
        FakeResponse(500, text="merge refused"),
    ])

    assert vms.merge_sites("10.0.0.2", 7001) is False

    output = capsys.readouterr().out
    assert "10.0.0.2:7001" in output      # the endpoint is useful for diagnosis
    assert "remotetok" not in output      # a live session token is not


def test_get_merge_status_reports_in_progress(make_vms):
    vms = make_vms()
    vms.session = FakeSession(
        post=[FakeResponse(200, {"token": "localtok"})],
        get=[FakeResponse(200, {"mergeInProgress": True})],
    )

    assert vms.get_merge_status() is True
    assert vms.session.calls[-1][1] == "https://127.0.0.1:7001/rest/v4/site/merge"


def test_get_merge_status_reports_finished(make_vms):
    vms = make_vms()
    vms.session = FakeSession(
        post=[FakeResponse(200, {"token": "localtok"})],
        get=[FakeResponse(200, {"mergeInProgress": False})],
    )

    assert vms.get_merge_status() is False


def test_get_merge_status_absent_key_reads_as_finished(make_vms):
    vms = make_vms()
    vms.session = FakeSession(
        post=[FakeResponse(200, {"token": "localtok"})],
        get=[FakeResponse(200, {})],
    )

    assert vms.get_merge_status() is False


def test_get_merge_status_failure_reads_as_finished(make_vms, capsys):
    # Reporting "finished" on error is what stops the poll loop in setup_system()
    # from spinning until its timeout against an unreachable server.
    vms = make_vms()
    vms.session = FakeSession(
        post=[FakeResponse(200, {"token": "localtok"})],
        get=[FakeResponse(500, text="boom")],
    )

    assert vms.get_merge_status() is False
    assert "Failed to get merge status" in capsys.readouterr().out


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
    assert local_bind_call[1] == "https://127.0.0.1:7001/rest/v4/cloud/bind"
    assert local_bind_call[2] == {
        "siteId": "sys-1", "authKey": "key-1", "owner": "user@example.com",
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
    assert bind_call[1] == "https://meta.nxvms.com/partners/api/v4/cloud_systems/"
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
    assert call[1] == "https://127.0.0.1:7001/rest/v4/cloud/unbind"
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
    assert call[1] == "https://127.0.0.1:7001/rest/v4/site/settings"
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
        "siteName": "TestSystem",
        "cloudId": "",
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


# ---------------------------------------------------------------------------
# setup_system() -- the hive layer on top of _configure_self()
# ---------------------------------------------------------------------------

@pytest.fixture
def hive(monkeypatch):
    """Stub out _configure_self, the clock, and record merge/readiness activity.

    Returns a factory: hive(vms) -> a record of what setup_system() drove.
    """
    monkeypatch.setattr(sample.time, "sleep", lambda seconds: None)

    def install(vms, *, ready=True, merge_ok=True, in_progress=0):
        record = {"configured": 0, "merged": [], "token_requests": [], "status_polls": 0}

        def fake_configure_self():
            record["configured"] += 1
            return {"system_name": vms.system_name}

        def fake_remote_token(username, password, ip, port):
            record["token_requests"].append(f"{ip}:{port}")
            return "remotetok" if ready else None

        def fake_merge_sites(ip, port):
            record["merged"].append(f"{ip}:{port}")
            return merge_ok

        def fake_merge_status():
            record["status_polls"] += 1
            return record["status_polls"] <= in_progress

        monkeypatch.setattr(vms, "_configure_self", fake_configure_self)
        monkeypatch.setattr(vms, "_get_remote_access_token_via_ms", fake_remote_token)
        monkeypatch.setattr(vms, "merge_sites", fake_merge_sites)
        monkeypatch.setattr(vms, "get_merge_status", fake_merge_status)
        return record

    return install


def test_setup_system_without_hive_configures_only_itself(make_vms, hive):
    vms = make_vms()
    record = hive(vms)

    result = vms.setup_system()

    assert record["configured"] == 1
    assert record["merged"] == []          # nothing to absorb
    assert result["system_name"] == "TestSystem"


def test_setup_system_seed_merges_every_follower_in_order(make_vms, hive):
    vms = make_vms(hive={"merge": "10.0.0.2:7001, 10.0.0.3:7001"})
    record = hive(vms)

    vms.setup_system()

    assert record["configured"] == 1
    assert record["merged"] == ["10.0.0.2:7001", "10.0.0.3:7001"]


def test_setup_system_returns_its_own_configuration_result(make_vms, hive):
    # The return value describes this server, not the merges.
    vms = make_vms(hive={"merge": "10.0.0.2:7001"})
    hive(vms)

    assert vms.setup_system() == {"system_name": "TestSystem"}


def test_setup_system_waits_for_a_follower_before_merging(make_vms, hive):
    vms = make_vms(hive={"merge": "10.0.0.2:7001"})
    record = hive(vms)

    vms.setup_system()

    # A token request doubles as the readiness probe, so one must precede the merge.
    assert record["token_requests"][0] == "10.0.0.2:7001"
    assert record["merged"] == ["10.0.0.2:7001"]


def test_setup_system_skips_a_follower_that_never_becomes_reachable(make_vms, hive):
    vms = make_vms(hive={"merge": "10.0.0.2:7001"})
    record = hive(vms, ready=False)

    vms.setup_system()

    assert record["merged"] == []          # gave up rather than merging blind
    assert record["configured"] == 1       # our own setup still counted


def test_setup_system_unreachable_follower_does_not_block_the_others(make_vms, hive,
                                                                    monkeypatch):
    vms = make_vms(hive={"merge": "10.0.0.2:7001, 10.0.0.3:7001"})
    record = hive(vms)

    # Only the first follower is unreachable.
    def selective_token(username, password, ip, port):
        record["token_requests"].append(f"{ip}:{port}")
        return None if ip == "10.0.0.2" else "remotetok"

    monkeypatch.setattr(vms, "_get_remote_access_token_via_ms", selective_token)

    vms.setup_system()

    assert record["merged"] == ["10.0.0.3:7001"]


def test_setup_system_failed_merge_does_not_block_the_others(make_vms, hive, monkeypatch):
    vms = make_vms(hive={"merge": "10.0.0.2:7001, 10.0.0.3:7001"})
    record = hive(vms)

    def selective_merge(ip, port):
        record["merged"].append(f"{ip}:{port}")
        return ip != "10.0.0.2"

    monkeypatch.setattr(vms, "merge_sites", selective_merge)

    vms.setup_system()

    # Both were attempted, and the failure was not polled for completion.
    assert record["merged"] == ["10.0.0.2:7001", "10.0.0.3:7001"]
    assert record["status_polls"] == 1


def test_setup_system_polls_until_the_merge_finishes(make_vms, hive):
    vms = make_vms(hive={"merge": "10.0.0.2:7001"})
    record = hive(vms, in_progress=3)

    vms.setup_system()

    assert record["status_polls"] == 4  # three "in progress", then done


def test_setup_system_raises_the_timeout_for_merge_work(make_vms, hive):
    # The 5s default is too tight for merge/login round trips.
    vms = make_vms(hive={"merge": "10.0.0.2:7001"})
    hive(vms)

    vms.setup_system()

    assert vms.http_timeout == 30
