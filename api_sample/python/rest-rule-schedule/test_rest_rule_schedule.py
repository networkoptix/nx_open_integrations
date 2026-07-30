# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_rule_schedule.py. No network, no account, no real site.

Covers: schedule building per preset (+ bad-hours rejection), normalize_preset,
summarize_schedule,
the rules table, arg parsing, mode-aware config, both login flows (+401),
list_rules (envelope + 403), patch_schedule (PATCH body, empty-200 success,
no-id error), the relay 307 preserving method + body + bearer, too-many-redirects,
and logout in both modes.

Run from this folder:  pytest -q
"""

import argparse

import pytest

import rest_rule_schedule as sample


SITE = "11111111-2222-3333-4444-555555555555"
SERVER = "https://192.168.1.10:7001"


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text="", headers=None):
        self.status_code = status_code
        self._json = json_data
        self.text = text
        self.headers = headers or {}

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeSession:
    """Serves queued responses in order; records every request it sees."""

    def __init__(self, responses=None):
        self.verify = None
        self._responses = list(responses or [])
        # (method, url, headers, json, allow_redirects)
        self.calls = []

    def _serve(self, method, url, headers=None, json=None, allow_redirects=None):
        self.calls.append((method, url, headers, json, allow_redirects))
        return self._responses.pop(0) if self._responses else FakeResponse(200)

    def request(self, method, url, headers=None, json=None, timeout=None,
                allow_redirects=None):
        return self._serve(method.upper(), url, headers, json, allow_redirects)

    def post(self, url, json=None, timeout=None):
        return self._serve("POST", url, None, json, None)

    def delete(self, url, headers=None, timeout=None):
        return self._serve("DELETE", url, headers, None, None)


def direct_client(responses=None):
    session = FakeSession(responses=responses)
    client = sample.NxRuleClient(sample.MODE_DIRECT, "admin", "pw",
                                 server_host=SERVER, session=session)
    return client, session


def cloud_client(responses=None, mfa_code=None):
    session = FakeSession(responses=responses)
    client = sample.NxRuleClient(sample.MODE_CLOUD, "me@x.com", "pw",
                                 cloud_host="https://nxvms.com", site_id=SITE,
                                 mfa_code=mfa_code, session=session)
    return client, session


# ---------------------------------------------------------------------------
# Schedule helpers (the core logic)
# ---------------------------------------------------------------------------

def test_build_schedule_always_is_empty():
    assert sample.build_schedule("always") == []


def test_build_schedule_24x7_all_full_days():
    s = sample.build_schedule("24x7")
    assert len(s) == 7
    assert [t["dayOfWeek"] for t in s] == [1, 2, 3, 4, 5, 6, 7]
    assert all(t["startTime"] == 0 and t["endTime"] == sample.SECONDS_PER_DAY
               for t in s)


def test_build_schedule_weekdays_with_window():
    s = sample.build_schedule("weekdays", 9, 18)
    assert [t["dayOfWeek"] for t in s] == sample.WEEKDAYS
    assert s[0]["startTime"] == 9 * 3600
    assert s[0]["endTime"] == 18 * 3600


def test_build_schedule_weekend():
    s = sample.build_schedule("weekend", 0, 12)
    assert [t["dayOfWeek"] for t in s] == sample.WEEKEND
    assert s[0]["endTime"] == 12 * 3600


def test_build_schedule_rejects_bad_window():
    with pytest.raises(sample.ApiError):
        sample.build_schedule("weekdays", 18, 9)
    with pytest.raises(sample.ApiError):
        sample.build_schedule("weekdays", -1, 9)
    with pytest.raises(sample.ApiError):
        sample.build_schedule("weekdays", 0, 25)


def test_normalize_preset_accepts_enum_rejects_others():
    for p in sample.PRESETS:
        assert sample.normalize_preset(p) == p
    assert sample.normalize_preset("WEEKDAYS") == "weekdays"
    with pytest.raises(sample.ApiError):
        sample.normalize_preset("sometimes")


def test_summarize_schedule():
    assert sample.summarize_schedule([]) == "always"
    assert sample.summarize_schedule(None) == "always"
    assert sample.summarize_schedule(
        [{"dayOfWeek": 1, "startTime": 9 * 3600, "endTime": 18 * 3600}]
    ) == "Mon 09:00-18:00"


def test_format_rules_table_rows_and_empty():
    out = sample.format_rules_table(
        [{"id": "r1", "enabled": True, "comment": "Weekdays", "schedule": []}])
    assert "Weekdays" in out
    assert "No event rules" in sample.format_rules_table([])


def test_format_rules_table_enabled_flag():
    out = sample.format_rules_table(
        [{"id": "r1", "enabled": False, "comment": "x", "schedule": []}])
    # The disabled rule's row renders "no".
    assert "no" in out.split("\n")[1]


# ---------------------------------------------------------------------------
# CLI parsing + config
# ---------------------------------------------------------------------------

def test_parse_args_reads_actions_flags_booleans():
    a = sample.build_arg_parser().parse_args(
        ["--mode", "cloud", "--rule-id", "r9", "--preset", "weekdays",
         "--start", "8", "--end", "20", "--insecure"])
    assert a.mode == "cloud"
    assert a.rule_id == "r9"
    assert a.preset == "weekdays"
    assert a.start == "8"
    assert a.end == "20"
    assert a.insecure is True
    assert sample.build_arg_parser().parse_args(["--list"]).list is True


def test_parse_args_env_file_and_rejects_unknown_flag():
    a = sample.build_arg_parser().parse_args(["--env-file", "x.env", "--list"])
    assert a.env_file == "x.env"
    with pytest.raises(SystemExit):
        sample.build_arg_parser().parse_args(["--bogus"])


def test_resolve_config_picks_server_and_cloud_vars(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", SERVER)
    monkeypatch.setenv("NX_SERVER_USER", "admin")
    monkeypatch.setenv("NX_SERVER_PASSWORD", "pw")
    direct = sample.resolve_config(_args(mode="direct"), {})
    assert direct["server_host"] == SERVER
    assert sample.missing_fields(direct) == []

    monkeypatch.delenv("NX_SERVER_HOST", raising=False)
    monkeypatch.setenv("NX_CLOUD_USER", "me@x.com")
    monkeypatch.setenv("NX_CLOUD_PASSWORD", "pw")
    cloud = sample.resolve_config(_args(mode="cloud", site_id=SITE), {})
    assert cloud["cloud_host"] == "https://nxvms.com"
    assert sample.missing_fields(cloud) == []


def test_missing_fields_per_mode(monkeypatch):
    for var in ("NX_SERVER_HOST", "NX_SERVER_USER", "NX_SERVER_PASSWORD",
                "NX_CLOUD_USER", "NX_CLOUD_PASSWORD", "NX_CLOUD_SITE_ID"):
        monkeypatch.delenv(var, raising=False)
    assert sorted(sample.missing_fields(
        sample.resolve_config(_args(mode="direct"), {}))) == [
        "password", "server_host", "user"]
    # cloud_host defaults to https://nxvms.com, so it is never "missing".
    assert sorted(sample.missing_fields(
        sample.resolve_config(_args(mode="cloud"), {}))) == [
        "password", "site_id", "user"]


def test_config_precedence_env_over_file(monkeypatch):
    monkeypatch.setenv("NX_CLOUD_SITE_ID", "env-site")
    config = sample.resolve_config(_args(mode="cloud"),
                                   {"NX_CLOUD_SITE_ID": "file-site"})
    assert config["site_id"] == "env-site"


def _args(**overrides):
    base = dict(mode=None, server_host=None, cloud_host=None, user=None,
                password=None, site_id=None, mfa_code=None)
    base.update(overrides)
    return argparse.Namespace(**base)


# ---------------------------------------------------------------------------
# login
# ---------------------------------------------------------------------------

def test_direct_login_stores_server_token():
    client, session = direct_client([FakeResponse(200, {"token": "srv"})])
    assert client.login() == "srv"
    assert session.calls[0][1] == f"{SERVER}/rest/v4/login/sessions"
    assert client.token == "srv"


def test_cloud_login_sends_scope_and_mfa():
    client, session = cloud_client(
        [FakeResponse(200, {"access_token": "nxcdb-t"})], mfa_code="111222")
    assert client.login() == "nxcdb-t"
    body = session.calls[0][3]
    assert body["scope"] == f"cloudSystemId={SITE}"
    assert body["mfaCode"] == "111222"


def test_login_401_raises_auth_error():
    client, _ = direct_client([FakeResponse(401, text="no")])
    with pytest.raises(sample.AuthError):
        client.login()


# ---------------------------------------------------------------------------
# list_rules
# ---------------------------------------------------------------------------

RULES = [
    {"id": "r1", "enabled": True, "comment": "Weekdays",
     "schedule": [{"dayOfWeek": 6, "startTime": 0, "endTime": 3600}]},
    {"id": "r2", "enabled": True, "comment": "Weekend",
     "schedule": [{"dayOfWeek": 1, "startTime": 0, "endTime": 3600}]},
    {"id": "r3", "enabled": False, "comment": "Other", "schedule": []},
]


def test_list_rules_gets_v4_path_with_bearer():
    client, session = direct_client([FakeResponse(200, RULES)])
    client.token = "srv"
    rules = client.list_rules()
    assert len(rules) == 3
    method, url, headers, _, allow_redirects = session.calls[0]
    assert method == "GET"
    assert url == f"{SERVER}/rest/v4/events/rules"
    assert headers["Authorization"] == "Bearer srv"
    assert allow_redirects is False


def test_list_rules_unwraps_reply_envelope():
    client, _ = direct_client([FakeResponse(200, {"reply": RULES})])
    client.token = "t"
    assert len(client.list_rules()) == 3


def test_list_rules_403_raises_auth_error():
    client, _ = direct_client([FakeResponse(403, text="no")])
    client.token = "t"
    with pytest.raises(sample.AuthError):
        client.list_rules()


# ---------------------------------------------------------------------------
# patch_schedule
# ---------------------------------------------------------------------------

def test_patch_schedule_patches_rule_with_schedule_body():
    sched = sample.build_schedule("weekdays", 9, 18)
    client, session = direct_client(
        [FakeResponse(200, {"id": "r1", "schedule": sched})])
    client.token = "srv"
    updated = client.patch_schedule("r1", sched)
    method, url, headers, body, _ = session.calls[0]
    assert method == "PATCH"
    assert url == f"{SERVER}/rest/v4/events/rules/r1"
    assert body["schedule"] == sched
    assert headers["Content-Type"] == "application/json"
    assert updated["id"] == "r1"


def test_patch_schedule_empty_200_body_is_success():
    client, _ = direct_client([FakeResponse(200)])  # no json
    client.token = "t"
    updated = client.patch_schedule("r5", [])
    assert updated["id"] == "r5"
    assert updated["schedule"] == []


def test_patch_schedule_without_rule_id_raises():
    client, _ = direct_client()
    client.token = "t"
    with pytest.raises(sample.ApiError):
        client.patch_schedule("", [])


def test_patch_schedule_follows_307_preserving_method_body_bearer():
    base = f"https://{SITE}.relay.vmsproxy.com/rest/v4/events/rules/r1"
    redirected = "https://node-7.relay.vmsproxy.com/rest/v4/events/rules/r1"
    client, session = cloud_client([
        FakeResponse(307, headers={"Location": redirected}),
        FakeResponse(200, {"id": "r1"}),
    ])
    client.token = "nxcdb-t"
    client.patch_schedule("r1", sample.build_schedule("always"))
    assert session.calls[0][1] == base
    assert session.calls[1][1] == redirected
    # Method + body + bearer preserved across the hop.
    assert session.calls[1][0] == "PATCH"
    assert session.calls[1][3]["schedule"] == []
    assert session.calls[1][2]["Authorization"] == "Bearer nxcdb-t"


def test_too_many_redirects_raises():
    # Every response is a 307 pointing somewhere else -> never resolves.
    responses = [FakeResponse(307, headers={"Location": f"https://h{i}.x/p"})
                 for i in range(sample.MAX_REDIRECTS + 2)]
    client, _ = cloud_client(responses)
    client.token = "t"
    with pytest.raises(sample.ApiError, match="Too many redirects"):
        client.patch_schedule("r1", [])


# ---------------------------------------------------------------------------
# logout
# ---------------------------------------------------------------------------

def test_direct_logout_deletes_server_session():
    client, session = direct_client([FakeResponse(204)])
    client.token = "srv"
    client.logout()
    method, url, _, _, _ = session.calls[0]
    assert method == "DELETE"
    assert url == f"{SERVER}/rest/v4/login/sessions/srv"
    assert client.token is None


def test_cloud_logout_deletes_cloud_token():
    client, session = cloud_client([FakeResponse(204)])
    client.token = "nxcdb-t"
    client.logout()
    assert session.calls[0][1] == "https://nxvms.com/cdb/oauth2/token/nxcdb-t"


# ---------------------------------------------------------------------------
# main(): action selection + end-to-end --list
# ---------------------------------------------------------------------------

def test_main_no_action_returns_2(capsys):
    rc = sample.main(["--mode", "direct", "--server-host", SERVER,
                      "--user", "admin", "--password", "pw"])
    assert rc == 2
    assert "Choose exactly one action" in capsys.readouterr().err


def test_main_two_actions_returns_2(capsys):
    rc = sample.main(["--list", "--rule-id", "r1"])
    assert rc == 2
    assert "Choose exactly one action" in capsys.readouterr().err


def test_main_bad_preset_returns_2(capsys):
    rc = sample.main(["--mode", "direct", "--server-host", SERVER,
                      "--user", "admin", "--password", "pw",
                      "--rule-id", "r1", "--preset", "hourly"])
    assert rc == 2
    assert "Unknown --preset" in capsys.readouterr().err


def test_main_bad_hours_returns_2(capsys):
    rc = sample.main(["--mode", "direct", "--server-host", SERVER,
                      "--user", "admin", "--password", "pw",
                      "--rule-id", "r1", "--preset", "weekdays",
                      "--start", "20", "--end", "8"])
    assert rc == 2
    assert "Invalid hours" in capsys.readouterr().err


def test_main_missing_config_returns_2(capsys, monkeypatch):
    for var in ("NX_SERVER_HOST", "NX_SERVER_USER", "NX_SERVER_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    rc = sample.main(["--mode", "direct", "--list", "--env-file", "/nope"])
    assert rc == 2
    assert "Missing config" in capsys.readouterr().err


def test_main_list_prints_table(monkeypatch, capsys):
    session = FakeSession(responses=[
        FakeResponse(200, {"token": "srv"}),   # login
        FakeResponse(200, RULES),              # list_rules
        FakeResponse(204),                     # logout
    ])
    monkeypatch.setattr(sample.requests, "Session", lambda: session)
    rc = sample.main(["--mode", "direct", "--server-host", SERVER,
                      "--user", "admin", "--password", "pw", "--list"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "SCHEDULE" in out and "Weekdays" in out
