# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_event_log.py. No network, no server needed.

Covers: site-scoped token request, manual 307 redirect handling (bearer
preserved), v4 query params (startTimeMs/durationMs, array filters), and
normalizing the v4 record shape ({timestampMs, eventData{}, actionData{}}).

Run from this folder:  pytest -v
"""

import argparse

import pytest

import rest_event_log as sample


SYS = "11111111-2222-3333-4444-555555555555"


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
    """Serves queued GET responses in order; records each GET (url, headers, params)."""

    def __init__(self, post=None, gets=None):
        self.verify = None
        self._post = post
        self._gets = list(gets or [])
        self.post_url = self.post_json = None
        self.get_calls = []  # (url, headers, params, allow_redirects)

    def post(self, url, json=None, timeout=None):
        self.post_url, self.post_json = url, json
        return self._post

    def get(self, url, headers=None, params=None, timeout=None, allow_redirects=None):
        self.get_calls.append((url, headers, params, allow_redirects))
        return self._gets.pop(0)


# A v4 record: details live inside eventData / actionData; timestamp in ms.
RAW_RECORD = {
    "timestampMs": 1781247975053,
    "eventData": {"eventType": "cameraDisconnectEvent", "caption": "Lobby Cam"},
    "actionData": {"actionType": "sendMailAction"},
    "ruleId": "rule-1",
    "flags": "noFlags",
}


def make_client(post=None, gets=None):
    session = FakeSession(post=post, gets=gets)
    client = sample.NxCloudEventLogClient("https://nxvms.com", SYS, session=session)
    return client, session


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def test_normalize_v4_record():
    out = sample.normalize_event(RAW_RECORD)
    assert out["event_type"] == "cameraDisconnectEvent"
    assert out["action_type"] == "sendMailAction"
    assert out["resource"] == "Lobby Cam"
    assert out["time"].startswith("2026-06-")   # ms -> readable UTC


def test_normalize_handles_missing_data():
    out = sample.normalize_event({"timestampMs": None})
    assert out["event_type"] == ""
    assert out["action_type"] == ""


def test_build_event_params_uses_start_and_duration():
    params = sample.build_event_params(1000, 2000)
    assert params["startTimeMs"] == "1000"
    assert params["durationMs"] == "2000"
    assert params["order"] == "desc"
    assert "eventType" not in params


def test_build_event_params_arrays():
    params = sample.build_event_params(0, 1, event_type="motionEvent",
                                       action_type=["a", "b"])
    assert params["eventType"] == ["motionEvent"]   # wrapped into a list
    assert params["actionType"] == ["a", "b"]


def test_format_table():
    assert "No events" in sample.format_events_table([])
    out = sample.format_events_table([sample.normalize_event(RAW_RECORD)])
    assert "EVENT" in out and "cameraDisconnectEvent" in out


# A v4 event-type manifest: an OBJECT MAP keyed by event-type id.
RAW_MANIFEST = {
    "cameraMotionEvent": {"id": "cameraMotionEvent", "displayName": "Motion Detected"},
    "cameraDisconnectEvent": {"id": "cameraDisconnectEvent",
                              "displayName": "Camera Disconnected"},
}


def test_parse_event_manifest_maps_id_to_display_name():
    out = sample.parse_event_manifest(RAW_MANIFEST)
    assert out["cameraMotionEvent"] == "Motion Detected"
    assert out["cameraDisconnectEvent"] == "Camera Disconnected"


def test_parse_event_manifest_falls_back_to_map_key():
    # A value with no `id` should be keyed by the map key instead.
    out = sample.parse_event_manifest({"softwareTriggerEvent": {"displayName": "Trigger"}})
    assert out["softwareTriggerEvent"] == "Trigger"


def test_parse_event_manifest_handles_non_dict():
    assert sample.parse_event_manifest([]) == {}


def test_format_manifest_table():
    assert "No event types" in sample.format_manifest_table({})
    out = sample.format_manifest_table(sample.parse_event_manifest(RAW_MANIFEST))
    assert "DISPLAY NAME" in out and "cameraMotionEvent" in out
    # Sorted by id: cameraDisconnectEvent comes before cameraMotionEvent.
    assert out.index("cameraDisconnectEvent") < out.index("cameraMotionEvent")


# ---------------------------------------------------------------------------
# login(): scoped token
# ---------------------------------------------------------------------------

def test_login_requests_system_scoped_token():
    client, session = make_client(post=FakeResponse(200, {"access_token": "nxcdb-t"}))
    client.login("me@x.com", "pw")
    assert session.post_url == "https://nxvms.com/cdb/oauth2/token"
    assert session.post_json["scope"] == f"cloudSystemId={SYS}"
    assert client.token == "nxcdb-t"


def test_login_rejected_raises():
    client, _ = make_client(post=FakeResponse(403, text="no"))
    with pytest.raises(sample.AuthError):
        client.login("me@x.com", "pw")


# ---------------------------------------------------------------------------
# relay URL + the event log call
# ---------------------------------------------------------------------------

def test_relay_url():
    client, _ = make_client()
    assert client.relay_url == f"https://{SYS}.relay.vmsproxy.com"


def test_get_event_log_hits_relay_v4_path_with_bearer():
    client, session = make_client(gets=[FakeResponse(200, [RAW_RECORD])])
    client.use_token("nxcdb-t")

    events = client.get_event_log(1000, 2000)

    url, headers, params, allow_redirects = session.get_calls[0]
    assert url == f"https://{SYS}.relay.vmsproxy.com/rest/v4/events/log"
    assert headers["Authorization"] == "Bearer nxcdb-t"
    assert params["startTimeMs"] == "1000"
    assert allow_redirects is False        # we follow redirects ourselves
    assert events[0]["event_type"] == "cameraDisconnectEvent"


def test_307_redirect_is_followed_with_bearer_preserved():
    # First GET -> 307 to the serving node; second GET -> the data.
    node = "https://node7.relay.vmsproxy.com/rest/v4/events/log"
    client, session = make_client(gets=[
        FakeResponse(307, headers={"Location": node}),
        FakeResponse(200, [RAW_RECORD]),
    ])
    client.use_token("nxcdb-t")

    events = client.get_event_log(1000, 2000)

    assert len(session.get_calls) == 2
    # Crucially, the bearer header is re-attached on the redirected request.
    assert session.get_calls[1][0] == node
    assert session.get_calls[1][1]["Authorization"] == "Bearer nxcdb-t"
    assert events[0]["resource"] == "Lobby Cam"


def test_redirect_without_location_raises():
    client, session = make_client(gets=[FakeResponse(307, headers={})])
    client.use_token("t")
    with pytest.raises(sample.ApiError):
        client.get_event_log(1, 2)


def test_token_rejected_on_event_log_raises():
    client, _ = make_client(gets=[FakeResponse(403, text="no")])
    client.use_token("t")
    with pytest.raises(sample.AuthError):
        client.get_event_log(1, 2)


def test_get_event_log_without_token_raises():
    client, _ = make_client(gets=[FakeResponse(200, [])])
    with pytest.raises(sample.ApiError):
        client.get_event_log(1, 2)


# ---------------------------------------------------------------------------
# the event-type manifest call
# ---------------------------------------------------------------------------

def test_get_event_manifest_hits_relay_v4_path_with_bearer():
    client, session = make_client(gets=[FakeResponse(200, RAW_MANIFEST)])
    client.use_token("nxcdb-t")

    manifest = client.get_event_manifest()

    url, headers, params, allow_redirects = session.get_calls[0]
    assert url == f"https://{SYS}.relay.vmsproxy.com/rest/v4/events/manifest/events"
    assert headers["Authorization"] == "Bearer nxcdb-t"
    assert allow_redirects is False        # we follow redirects ourselves
    assert manifest["cameraMotionEvent"] == "Motion Detected"


def test_get_event_manifest_follows_307_with_bearer_preserved():
    node = "https://node7.relay.vmsproxy.com/rest/v4/events/manifest/events"
    client, session = make_client(gets=[
        FakeResponse(307, headers={"Location": node}),
        FakeResponse(200, RAW_MANIFEST),
    ])
    client.use_token("nxcdb-t")

    manifest = client.get_event_manifest()

    assert len(session.get_calls) == 2
    assert session.get_calls[1][0] == node
    assert session.get_calls[1][1]["Authorization"] == "Bearer nxcdb-t"
    assert manifest["cameraDisconnectEvent"] == "Camera Disconnected"


def test_get_event_manifest_token_rejected_raises():
    client, _ = make_client(gets=[FakeResponse(403, text="no")])
    client.use_token("t")
    with pytest.raises(sample.AuthError):
        client.get_event_manifest()


# ---------------------------------------------------------------------------
# Time window (--since / --start / --end), converted to startTimeMs/durationMs
# ---------------------------------------------------------------------------

def test_parse_duration_units():
    assert sample.parse_duration("30m") == 30 * 60_000
    assert sample.parse_duration("24h") == 24 * 3_600_000
    assert sample.parse_duration("7d") == 7 * 86_400_000
    assert sample.parse_duration("2w") == 2 * 604_800_000
    assert sample.parse_duration("1.5h") == int(1.5 * 3_600_000)


def test_parse_duration_requires_unit():
    with pytest.raises(ValueError):
        sample.parse_duration("24")        # no unit -> rejected (no ambiguity)
    with pytest.raises(ValueError):
        sample.parse_duration("soon")


def test_parse_time_epoch_and_iso():
    assert sample.parse_time("1781247975053") == 1781247975053      # ms
    assert sample.parse_time("1781247975") == 1781247975 * 1000     # seconds
    assert sample.parse_time("2026-06-12T00:00:00Z") == 1781222400000  # ISO -> UTC


def test_parse_time_invalid_raises():
    with pytest.raises(ValueError):
        sample.parse_time("not-a-date")


def test_resolve_window_since():
    now = 1_000_000_000_000
    start_ms, duration_ms = sample.resolve_window(now, since="24h")
    assert duration_ms == 24 * 3_600_000
    assert start_ms == now - duration_ms


def test_resolve_window_absolute_start_end():
    now = 5_000
    start_ms, duration_ms = sample.resolve_window(now, start="1000", end="4000")
    assert start_ms == 1_000_000          # epoch seconds -> ms
    assert duration_ms == 3_000_000


def test_resolve_window_start_defaults_end_to_now():
    now = 9_000_000
    start_ms, duration_ms = sample.resolve_window(now, start="1000")
    assert start_ms == 1_000_000
    assert duration_ms == now - 1_000_000


def test_resolve_window_end_before_start_raises():
    with pytest.raises(ValueError):
        sample.resolve_window(0, start="2000", end="1000")


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def test_config_reads_cloud_env(monkeypatch):
    monkeypatch.setenv("NX_CLOUD_SITE_ID", "env-sys")
    args = argparse.Namespace(cloud_host=None, user=None, password=None,
                              site_id=None, mfa_code=None, token=None)
    config = sample.resolve_config(args, {"NX_CLOUD_SITE_ID": "file-sys"})
    assert config["site_id"] == "env-sys"


# ---------------------------------------------------------------------------
# main(): --list-event-types path
# ---------------------------------------------------------------------------

def test_main_list_event_types_prints_manifest_table(monkeypatch, capsys):
    # --token skips login; the only GET returns the manifest object map.
    session = FakeSession(gets=[FakeResponse(200, RAW_MANIFEST)])
    monkeypatch.setattr(sample.requests, "Session", lambda: session)

    rc = sample.main([
        "--cloud-host", "https://nxvms.com", "--site-id", SYS,
        "--token", "nxcdb-t", "--list-event-types",
    ])

    assert rc == 0
    out = capsys.readouterr().out
    assert "DISPLAY NAME" in out
    assert "cameraMotionEvent" in out and "Motion Detected" in out
    # It must NOT read the event log: only the manifest GET happened.
    assert len(session.get_calls) == 1
    assert session.get_calls[0][0].endswith("/rest/v4/events/manifest/events")
