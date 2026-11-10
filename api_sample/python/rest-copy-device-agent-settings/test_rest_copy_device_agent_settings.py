#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_copy_device_agent_settings.py.

These run with no VMS server and no network: every HTTP call is served by the
fakes below. That is a hard requirement, a test that needs a live server cannot
run in CI, so it does not get written.

What is worth testing in a sample:
  - the auth flow sends what the API expects, and stores the token
  - each documented failure mode raises the right error
  - response shapes the server really returns are all handled (v4 envelopes!)
  - config precedence: CLI > env > .env
  - the PUT body keeps only the fields that are really configuration
  - every failure path logs out, and a download never leaves a side file
"""

import argparse
import datetime
import json
import os
import warnings

import pytest
import requests
from urllib3.exceptions import MaxRetryError, NewConnectionError, ProtocolError

import rest_copy_device_agent_settings as sample


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeResponse:
    """A response with a JSON `payload`, or with the exact bytes in `raw`."""

    def __init__(self, status_code=200, payload=None, raw=None):
        self.status_code = status_code
        if raw is not None:
            self.content = raw
        else:
            self.content = json.dumps(payload if payload is not None else {}).encode()

    def json(self):
        # Like requests: an empty or non-JSON body raises a ValueError.
        return json.loads(self.content)


class FakeSession:
    """Stands in for requests.Session, recording every call it receives.

    A response may also be an exception, which is raised, or a callable, whose
    result is used (a hook for "something happens during the request").
    """

    def __init__(self, responses=None):
        self.headers = {}
        self.verify = True
        self.calls = []                      # (method, url, json_body)
        self.redirect_flags = []             # allow_redirects, per call
        self.responses = responses or {}     # (method, url_suffix) -> FakeResponse

    def _respond(self, method, url, json_body=None, allow_redirects=True, **_):
        self.calls.append((method, url, json_body))
        self.redirect_flags.append(allow_redirects)
        for (want_method, suffix), response in self.responses.items():
            if method == want_method and url.endswith(suffix):
                if isinstance(response, BaseException):
                    raise response
                if callable(response):
                    return response()
                return response
        return FakeResponse(200, {})

    def post(self, url, json=None, **kwargs):
        return self._respond("POST", url, json, **kwargs)

    def get(self, url, **kwargs):
        return self._respond("GET", url, **kwargs)

    def put(self, url, json=None, **kwargs):
        return self._respond("PUT", url, json, **kwargs)

    def delete(self, url, **kwargs):
        return self._respond("DELETE", url, **kwargs)


def make_client(responses=None):
    client = sample.NxServerClient("https://server:7001")
    client.session = FakeSession(responses)
    return client


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def test_login_posts_credentials_and_stores_token():
    client = make_client({("POST", "/login/sessions"): FakeResponse(200, {"token": "tok-1"})})

    token = client.login("admin", "secret")

    assert token == "tok-1"
    assert client.token == "tok-1"
    assert client.session.headers["Authorization"] == "Bearer tok-1"

    method, url, body = client.session.calls[0]
    assert (method, body) == ("POST", {"username": "admin", "password": "secret"})
    assert url.endswith("/rest/v4/login/sessions")


@pytest.mark.parametrize("status", [401, 403])
def test_login_unauthorized_raises_autherror(status):
    client = make_client({("POST", "/login/sessions"): FakeResponse(status)})
    with pytest.raises(sample.AuthError):
        client.login("admin", "wrong")


def test_login_without_token_in_response_raises_apierror():
    client = make_client({("POST", "/login/sessions"): FakeResponse(200, {})})
    with pytest.raises(sample.ApiError, match="did not contain a token"):
        client.login("admin", "secret")


@pytest.mark.parametrize("response, wording", [
    (FakeResponse(500), "Login failed: HTTP 500"),
    (FakeResponse(302), "Login failed: HTTP 302 \\(redirect not followed\\)"),
    (FakeResponse(200, raw=b"<html>proxy</html>"),
     "Login failed: the response was not valid JSON"),
    (FakeResponse(200, ["tok-1"]), "Login failed: the response did not contain a token"),
    (FakeResponse(200, {"token": 42}), "Login failed: the response did not contain a token"),
])
def test_login_failures_say_what_the_server_answered(response, wording):
    """The server answered, so none of these is "could not reach the server"."""
    client = make_client({("POST", "/login/sessions"): response})
    with pytest.raises(sample.ApiError, match=wording):
        client.login("admin", "secret")


# ---------------------------------------------------------------------------
# download_settings(): GET .../settings
# ---------------------------------------------------------------------------

SETTINGS_URL = "/analytics/engines/engine-1/deviceAgents/device-1/settings"

BARE_SETTINGS = {
    "deviceId": "device-1",
    "engineId": "engine-1",
    "values": {"sensitivity": 50},
    "model": {"sensitivity": {"type": "SpinBox"}},
    "_error": {},
    "analyzedStream": "primary",
    "disableStreamSelection": False,
}


def test_download_settings_sends_get_to_the_engine_and_device_path():
    client = make_client({("GET", SETTINGS_URL): FakeResponse(200, BARE_SETTINGS)})
    client.token = "tok-1"

    result = client.download_settings("engine-1", "device-1")

    assert result == BARE_SETTINGS
    method, url, _ = client.session.calls[0]
    assert method == "GET"
    assert url.endswith(SETTINGS_URL)


def test_download_settings_unwraps_the_v4_reply_envelope():
    """v4 can wrap a single object in {"reply": {...}} as it does for arrays."""
    client = make_client({("GET", SETTINGS_URL): FakeResponse(200, {"reply": BARE_SETTINGS})})
    client.token = "tok-1"

    assert client.download_settings("engine-1", "device-1") == BARE_SETTINGS


def test_download_settings_without_login_raises():
    with pytest.raises(sample.ApiError):
        make_client().download_settings("engine-1", "device-1")


@pytest.mark.parametrize("response, wording", [
    (FakeResponse(302), "HTTP 302 \\(redirect not followed\\)"),
    (FakeResponse(500), "HTTP 500"),
    (FakeResponse(200, [BARE_SETTINGS]), "did not return a JSON object"),
    (FakeResponse(200, raw=b"<html></html>"), "did not return a JSON object"),
])
def test_download_settings_failures(response, wording):
    client = make_client({("GET", SETTINGS_URL): response})
    client.token = "tok-1"
    with pytest.raises(sample.ApiError, match=wording):
        client.download_settings("engine-1", "device-1")


# ---------------------------------------------------------------------------
# build_apply_body(): the PUT request body the spec defines
# ---------------------------------------------------------------------------

def test_build_apply_body_drops_the_ids_and_the_source_error_map():
    """deviceId/engineId are not even in the spec's PUT request body: the URL
    already identifies the device and engine. _error is the source Engine's
    report, which must not be echoed back. Everything else (values, model,
    analyzedStream, disableStreamSelection) is forwarded unchanged."""
    settings = dict(BARE_SETTINGS, _error={"sensitivity": "out of range"})

    body = sample.build_apply_body(settings)

    assert body == {
        "values": {"sensitivity": 50},
        "model": {"sensitivity": {"type": "SpinBox"}},
        "analyzedStream": "primary",
        "disableStreamSelection": False,
    }


def test_build_apply_body_omits_a_field_absent_from_the_input():
    """A partial settings file must not send a field back as null."""
    body = sample.build_apply_body({"values": {"sensitivity": 50}})

    assert body == {"values": {"sensitivity": 50}}
    assert "analyzedStream" not in body
    assert "disableStreamSelection" not in body
    assert "model" not in body
    assert "_error" not in body


# ---------------------------------------------------------------------------
# apply_settings(): PUT .../settings
# ---------------------------------------------------------------------------

def test_apply_settings_sends_put_with_the_body_to_the_engine_and_device_path():
    client = make_client({("PUT", SETTINGS_URL): FakeResponse(200, BARE_SETTINGS)})
    client.token = "tok-1"
    body = {"values": {"sensitivity": 50}}

    client.apply_settings("engine-1", "device-1", body)

    method, url, sent_body = client.session.calls[0]
    assert method == "PUT"
    assert url.endswith(SETTINGS_URL)
    assert sent_body == body


def test_apply_settings_without_login_raises():
    with pytest.raises(sample.ApiError):
        make_client().apply_settings("engine-1", "device-1", {})


def _applying(response):
    client = make_client({("PUT", SETTINGS_URL): response})
    client.token = "tok-1"
    return lambda: client.apply_settings("engine-1", "device-1", {"values": {}})


@pytest.mark.parametrize("response", [
    FakeResponse(200, raw=b""),
    FakeResponse(204, raw=b""),
    FakeResponse(200, raw=b"OK"),
    FakeResponse(200, {"_error": {}}),
    FakeResponse(200, {"reply": {"values": {}}}),
])
def test_apply_settings_counts_these_2xx_answers_as_applied(response):
    _applying(response)()


def test_apply_settings_reports_the_engines_errors():
    apply = _applying(FakeResponse(200, {"_error": {"sensitivity": "out of range",
                                                    "zone": "unknown"}}))
    with pytest.raises(sample.ApiError) as raised:
        apply()
    message = str(raised.value)
    assert message.startswith("The server took the settings but the Engine reported errors:")
    assert "sensitivity: out of range" in message
    assert "zone: unknown" in message


def test_apply_settings_prints_non_string_engine_errors_as_json():
    apply = _applying(FakeResponse(200, {"_error": {"zone": {"code": 3},
                                                    "x": {"x": 1},
                                                    "list": [1, "a"],
                                                    "level": 7,
                                                    "name": "bad"}}))
    with pytest.raises(sample.ApiError) as raised:
        apply()
    lines = str(raised.value).splitlines()[1:]
    # Compact JSON, the same text the other ports print.
    assert lines == ['  zone: {"code":3}', '  x: {"x":1}', '  list: [1,"a"]',
                     "  level: 7", "  name: bad"]


def test_apply_settings_treats_a_redirect_as_a_failure():
    with pytest.raises(sample.ApiError, match="HTTP 302 \\(redirect not followed\\)"):
        _applying(FakeResponse(302))()


@pytest.mark.parametrize("status, message", [
    (302, "Applying settings failed: HTTP 302 (redirect not followed). "
          "The settings were not applied."),
    (404, "Applying settings failed: HTTP 404. The settings were not applied. "
          "The target device may not be running this Engine."),
    (500, "Applying settings failed: HTTP 500. The server may have applied some "
          "of them; download the device's settings to check."),
])
def test_apply_settings_failure_wording_depends_on_the_status_class(status, message):
    with pytest.raises(sample.ApiError) as raised:
        _applying(FakeResponse(status))()
    assert str(raised.value) == message


@pytest.mark.parametrize("error", [
    requests.exceptions.ReadTimeout("read timed out"),
    requests.exceptions.ConnectionError(ProtocolError("Connection aborted.",
                                                      ConnectionResetError())),
    requests.exceptions.ChunkedEncodingError("cut short"),
])
def test_apply_settings_outcome_is_unknown_when_the_connection_drops_after_sending(error):
    with pytest.raises(sample.ApiError, match="^Outcome unknown"):
        _applying(error)()


@pytest.mark.parametrize("error", [
    requests.exceptions.ConnectionError(MaxRetryError(
        None, "/", NewConnectionError(None, "Connection refused"))),
    requests.exceptions.ConnectTimeout("connect timed out"),
    requests.exceptions.SSLError("handshake failed"),
])
def test_apply_settings_lets_a_never_connected_error_through(error):
    with pytest.raises(type(error)):
        _applying(error)()


# ---------------------------------------------------------------------------
# default_output_name(): the auto-named download destination
# ---------------------------------------------------------------------------

def test_default_output_name_includes_device_id_and_a_utc_timestamp():
    moment = datetime.datetime(2026, 9, 16, 3, 12, 0)

    name = sample.default_output_name("device-1", now=moment)

    assert name == "nx-device-agent-settings-device-1-20260916T031200Z.json"


def test_default_output_name_uses_no_deprecated_clock():
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        name = sample.default_output_name("device-1")
    assert name.startswith("nx-device-agent-settings-device-1-") and name.endswith("Z.json")


# ---------------------------------------------------------------------------
# Logout
# ---------------------------------------------------------------------------

def test_logout_deletes_the_session_and_clears_the_token():
    client = make_client()
    client.token = "tok-1"
    client.session.headers["Authorization"] = "Bearer tok-1"

    client.logout()

    method, url, _ = client.session.calls[-1]
    assert method == "DELETE"
    assert url.endswith("/rest/v4/login/sessions/tok-1")
    assert client.token is None
    assert "Authorization" not in client.session.headers


def test_logout_without_a_token_is_a_noop():
    client = make_client()
    client.logout()
    assert client.session.calls == []


def test_logout_failure_raises_but_still_forgets_the_token():
    client = make_client({("DELETE", "/login/sessions/tok-1"): FakeResponse(500)})
    client.token = "tok-1"
    with pytest.raises(sample.ApiError, match="Logout failed: HTTP 500"):
        client.logout()
    assert client.token is None


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _args(**overrides):
    defaults = {"host": None, "user": None, "password": None,
                "device_id": None, "engine_id": None}
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def test_config_reads_server_and_sample_env_vars(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://from-env:7001")
    monkeypatch.setenv("NX_SERVER_USER", "envuser")
    monkeypatch.setenv("NX_SERVER_PASSWORD", "envpass")
    monkeypatch.setenv("NX_DEVICE_ID", "device-env")
    monkeypatch.setenv("NX_ANALYTICS_ENGINE_ID", "engine-env")

    config = sample.resolve_config(_args(), {})

    assert config == {
        "host": "https://from-env:7001", "user": "envuser", "password": "envpass",
        "device_id": "device-env", "engine_id": "engine-env",
    }


def test_cli_flag_beats_env_which_beats_dotenv(monkeypatch):
    monkeypatch.setenv("NX_ANALYTICS_ENGINE_ID", "engine-env")

    config = sample.resolve_config(
        _args(engine_id="engine-cli"), {"NX_ANALYTICS_ENGINE_ID": "engine-dotenv"})
    assert config["engine_id"] == "engine-cli"

    config = sample.resolve_config(
        _args(), {"NX_ANALYTICS_ENGINE_ID": "engine-dotenv"})
    assert config["engine_id"] == "engine-env"

    monkeypatch.delenv("NX_ANALYTICS_ENGINE_ID")
    config = sample.resolve_config(
        _args(), {"NX_ANALYTICS_ENGINE_ID": "engine-dotenv"})
    assert config["engine_id"] == "engine-dotenv"


def test_trailing_slash_is_stripped_from_host():
    config = sample.resolve_config(_args(host="https://server:7001/"), {})
    assert config["host"] == "https://server:7001"


# ---------------------------------------------------------------------------
# main(): shared CLI behaviour
# ---------------------------------------------------------------------------

def _install_fake_session(monkeypatch, responses=None):
    """Follow the house pattern: hand main() a fake requests.Session."""
    session = FakeSession(responses)
    monkeypatch.setattr(sample.requests, "Session", lambda: session)
    return session


LOGIN_OK = {("POST", "/login/sessions"): FakeResponse(200, {"token": "tok-1"})}


def _creds(*extra):
    return ["--host", "https://server:7001", "--user", "admin", "--password", "secret",
            "--device-id", "device-1", "--engine-id", "engine-1",
            "--env-file", "/nonexistent"] + list(extra)


def test_no_subcommand_prints_help_and_exits_2(capsys):
    rc = sample.main([])
    assert rc == 2
    assert "download" in capsys.readouterr().err


@pytest.mark.parametrize("argv", [
    ["apply", "settings.json", "--yes=no"],
    ["download", "--force=yes"],
    ["download", "--insecure=false"],
    ["download", "--out"],
    ["download", "--host", "--user", "admin"],
])
def test_bad_flags_are_argument_errors(argv, monkeypatch):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))
    with pytest.raises(SystemExit) as raised:
        sample.main(argv + ["--env-file", "/nonexistent"])
    assert raised.value.code == 2
    assert session.calls == []


@pytest.mark.parametrize("argv, flag", [
    (["download", "--out="], "--out"),
    (["download", "--host="], "--host"),
    (["apply", "settings.json", "--yes", "--host="], "--host"),
    (["apply", "settings.json", "--yes", "--engine-id", ""], "--engine-id"),
])
def test_empty_flag_values_are_argument_errors(argv, flag, monkeypatch, capsys):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))
    with pytest.raises(SystemExit) as raised:
        sample.main(argv + ["--env-file", "/nonexistent"])
    assert raised.value.code == 2
    assert "Missing value for {}".format(flag) in capsys.readouterr().err
    assert session.calls == []


def test_login_http_error_is_not_could_not_reach(tmp_path, monkeypatch, capsys):
    _install_fake_session(monkeypatch, {("POST", "/login/sessions"): FakeResponse(503)})

    rc = sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds())

    err = capsys.readouterr().err
    assert rc == 1
    assert "ERROR: Login failed: HTTP 503" in err
    assert "could not reach" not in err


# ---------------------------------------------------------------------------
# main(): the download subcommand
# ---------------------------------------------------------------------------

def test_download_refuses_to_overwrite_without_force(tmp_path, monkeypatch):
    target = tmp_path / "already.json"
    target.write_text('{"previous": true}')
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))

    rc = sample.main(["download", "--out", str(target)] + _creds())

    assert rc == 1
    # The guard runs before anything is sent, including the login.
    assert session.calls == []
    assert json.loads(target.read_text()) == {"previous": True}


def test_download_writes_the_settings_file_and_succeeds(tmp_path, monkeypatch, capsys):
    target = tmp_path / "settings.json"
    responses = dict(LOGIN_OK)
    responses[("GET", SETTINGS_URL)] = FakeResponse(200, BARE_SETTINGS)
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["download", "--out", str(target)] + _creds())

    assert rc == 0
    assert json.loads(target.read_text()) == BARE_SETTINGS
    assert "device-1" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# main(): the apply subcommand
# ---------------------------------------------------------------------------

def test_apply_refuses_without_yes(tmp_path, monkeypatch):
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps(BARE_SETTINGS))
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))

    rc = sample.main(["apply", str(settings_file)] + _creds())

    assert rc == 1
    assert session.calls == []


def test_apply_succeeds_and_sends_the_put_body_the_spec_defines(tmp_path, monkeypatch, capsys):
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps(BARE_SETTINGS))
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(200, BARE_SETTINGS)
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(settings_file), "--yes"] + _creds())

    assert rc == 0
    put_calls = [c for c in session.calls if c[0] == "PUT"]
    assert put_calls[0][2] == {
        "values": {"sensitivity": 50},
        "model": {"sensitivity": {"type": "SpinBox"}},
        "analyzedStream": "primary",
        "disableStreamSelection": False,
    }
    assert "device-1" in capsys.readouterr().out


def test_apply_reports_failure_when_the_put_is_rejected(tmp_path, monkeypatch, capsys):
    settings_file = tmp_path / "settings.json"
    settings_file.write_text(json.dumps(BARE_SETTINGS))
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(403, {})
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(settings_file), "--yes"] + _creds())

    assert rc == 1
    assert "ERROR" in capsys.readouterr().err


def test_apply_refuses_a_missing_file(tmp_path, monkeypatch):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))
    missing = tmp_path / "nope.json"

    rc = sample.main(["apply", str(missing), "--yes"] + _creds())

    assert rc == 1
    assert session.calls == []


def _settings_file(tmp_path, content=None):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(BARE_SETTINGS) if content is None else content)
    return path


def _logged_out(session):
    return any(method == "DELETE" for method, _, _ in session.calls)


def test_no_request_follows_a_redirect(tmp_path, monkeypatch):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(200, raw=b"")
    session = _install_fake_session(monkeypatch, responses)

    assert sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds()) == 0
    responses[("GET", SETTINGS_URL)] = FakeResponse(200, BARE_SETTINGS)
    assert sample.main(["download", "--out", str(tmp_path / "out.json")] + _creds()) == 0

    assert [m for m, _, _ in session.calls] == ["POST", "PUT", "DELETE",
                                               "POST", "GET", "DELETE"]
    assert session.redirect_flags == [False] * 6


@pytest.mark.parametrize("content, wording", [
    ("{not json", "is not valid JSON"),
    ("[1, 2]", "does not hold a JSON object"),
    ('"text"', "does not hold a JSON object"),
])
def test_apply_refuses_a_bad_settings_file_before_login(tmp_path, monkeypatch, capsys,
                                                        content, wording):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))

    rc = sample.main(["apply", str(_settings_file(tmp_path, content)), "--yes"] + _creds())

    assert rc == 1
    assert wording in capsys.readouterr().err
    assert session.calls == []


def test_bad_settings_file_message_keeps_the_reason_and_ends_with_one_period(tmp_path):
    path = _settings_file(tmp_path, "{not json")
    with pytest.raises(sample.ApiError) as raised:
        sample.load_settings_file(str(path))
    message = str(raised.value)
    assert message.startswith("{} is not valid JSON: Expecting".format(path))
    assert message.endswith(").") and not message.endswith("..")


def test_apply_refuses_a_directory_before_login(tmp_path, monkeypatch, capsys):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))

    rc = sample.main(["apply", str(tmp_path), "--yes"] + _creds())

    assert rc == 1
    assert "is a directory" in capsys.readouterr().err
    assert session.calls == []


def test_apply_empty_2xx_body_is_applied(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(200, raw=b"")
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    assert rc == 0
    assert "Applied" in capsys.readouterr().out


def test_apply_reports_engine_errors_and_logs_out(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(
        200, {"_error": {"sensitivity": "out of range"}})
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    captured = capsys.readouterr()
    assert rc == 1
    assert "The server took the settings but the Engine reported errors:" in captured.err
    assert "sensitivity: out of range" in captured.err
    assert "Applied" not in captured.out
    assert _logged_out(session)


def test_apply_redirect_is_a_failure_and_logs_out(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(302)
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    assert rc == 1
    assert "HTTP 302 (redirect not followed)" in capsys.readouterr().err
    assert _logged_out(session)


def test_apply_rejected_put_logs_out(tmp_path, monkeypatch):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(404)
    session = _install_fake_session(monkeypatch, responses)

    assert sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds()) == 1
    assert _logged_out(session)


def test_apply_connection_lost_after_sending_is_outcome_unknown(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = requests.exceptions.ReadTimeout("read timed out")
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    err = capsys.readouterr().err
    assert rc == 1
    assert ("ERROR: Outcome unknown: the connection was lost after the settings were "
            "sent. Download the device's settings to check.") in err
    assert "not applied" not in err
    assert _logged_out(session)


def test_apply_connection_refused_is_not_applied(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = requests.exceptions.ConnectionError(
        MaxRetryError(None, "/", NewConnectionError(None, "Connection refused")))
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    err = capsys.readouterr().err
    assert rc == 1
    assert "ERROR: could not reach the server" in err
    assert "The settings were not applied." in err


@pytest.mark.parametrize("logout", [
    FakeResponse(500),
    requests.exceptions.ConnectionError("gone"),
])
def test_apply_logout_failure_after_success_is_only_a_warning(tmp_path, monkeypatch,
                                                              capsys, logout):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(200, BARE_SETTINGS)
    responses[("DELETE", "/login/sessions/tok-1")] = logout
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    captured = capsys.readouterr()
    assert rc == 0
    assert "Applied Device Agent settings" in captured.out
    assert captured.err == "WARNING: could not log out: {}\n".format(
        "Logout failed: HTTP 500." if isinstance(logout, FakeResponse) else "gone.")


def test_apply_ctrl_c_during_the_cleanup_logout_keeps_the_engine_errors(tmp_path,
                                                                       monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(
        200, {"_error": {"sensitivity": "out of range"}})
    responses[("DELETE", "/login/sessions/tok-1")] = KeyboardInterrupt()
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err == (
        "ERROR: The server took the settings but the Engine reported errors:\n"
        "  sensitivity: out of range\n"
        "WARNING: could not log out: interrupted.\n")
    assert "Interrupted." not in captured.err


def test_apply_ctrl_c_logs_out_and_exits_130(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = KeyboardInterrupt()
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    assert rc == 130
    # The PUT was in flight: the user is told the target may have changed.
    assert "Outcome unknown" in capsys.readouterr().err
    assert _logged_out(session)


@pytest.mark.parametrize("command", ["download", "apply"])
def test_ctrl_c_during_the_final_logout_is_only_a_warning(tmp_path, monkeypatch, capsys,
                                                          command):
    responses = _download_responses()
    responses[("PUT", SETTINGS_URL)] = FakeResponse(200, BARE_SETTINGS)
    responses[("DELETE", "/login/sessions/tok-1")] = KeyboardInterrupt()
    _install_fake_session(monkeypatch, responses)
    if command == "download":
        argv = ["download", "--out", str(tmp_path / "s.json")]
        result = "Downloaded Device Agent settings"
    else:
        argv = ["apply", str(_settings_file(tmp_path)), "--yes"]
        result = "Applied Device Agent settings"

    rc = sample.main(argv + _creds())

    captured = capsys.readouterr()
    assert rc == 0
    assert result in captured.out
    assert captured.err == "WARNING: could not log out: interrupted.\n"


# ---------------------------------------------------------------------------
# main(): download side file, no-clobber, cleanup
# ---------------------------------------------------------------------------

def _partials(folder):
    return [name for name in os.listdir(folder) if name.endswith(".partial")]


def _download_responses(on_get=None):
    responses = dict(LOGIN_OK)

    def get():
        if on_get:
            on_get()
        return FakeResponse(200, BARE_SETTINGS)

    responses[("GET", SETTINGS_URL)] = get
    return responses


def test_download_refuses_a_directory_before_login(tmp_path, monkeypatch, capsys):
    session = _install_fake_session(monkeypatch, _download_responses())

    rc = sample.main(["download", "--out", str(tmp_path)] + _creds())

    assert rc == 1
    assert "is a directory" in capsys.readouterr().err
    assert session.calls == []


def test_download_does_not_clobber_a_file_that_appeared_meanwhile(tmp_path, monkeypatch,
                                                                  capsys):
    target = tmp_path / "settings.json"
    session = _install_fake_session(
        monkeypatch, _download_responses(lambda: target.write_text('{"theirs": 1}')))

    rc = sample.main(["download", "--out", str(target)] + _creds())

    assert rc == 1
    assert "{} already exists; use --force".format(target) in capsys.readouterr().err
    assert json.loads(target.read_text()) == {"theirs": 1}
    assert _partials(tmp_path) == []
    assert _logged_out(session)


def test_download_auto_name_is_not_clobbered_either(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(sample, "default_output_name", lambda device_id: "auto.json")
    auto = tmp_path / "auto.json"
    _install_fake_session(
        monkeypatch, _download_responses(lambda: auto.write_text('{"theirs": 1}')))

    rc = sample.main(["download"] + _creds())

    assert rc == 1
    assert "auto.json already exists; use --force" in capsys.readouterr().err
    assert json.loads(auto.read_text()) == {"theirs": 1}
    assert _partials(tmp_path) == []


def test_download_existing_out_message_has_no_trailing_period(tmp_path, monkeypatch,
                                                              capsys):
    target = tmp_path / "settings.json"
    target.write_text("{}")
    _install_fake_session(monkeypatch, _download_responses())

    assert sample.main(["download", "--out", str(target)] + _creds()) == 1
    assert capsys.readouterr().err == "ERROR: {} already exists; use --force\n".format(target)


def _no_hard_links(monkeypatch):
    def link(source, destination):
        raise OSError(45, "Operation not supported", source, None, destination)
    monkeypatch.setattr(sample.os, "link", link)


def test_save_without_hard_links_falls_back_to_rename(tmp_path, monkeypatch):
    _no_hard_links(monkeypatch)
    target = tmp_path / "s.json"

    sample.save_settings_file(str(target), BARE_SETTINGS)

    assert json.loads(target.read_text()) == BARE_SETTINGS
    assert _partials(tmp_path) == []


def test_save_without_hard_links_still_does_not_clobber(tmp_path, monkeypatch):
    _no_hard_links(monkeypatch)
    target = tmp_path / "s.json"
    target.write_text('{"theirs": 1}')

    with pytest.raises(sample.ApiError) as raised:
        sample.save_settings_file(str(target), BARE_SETTINGS)

    assert str(raised.value) == "{} already exists; use --force".format(target)
    assert json.loads(target.read_text()) == {"theirs": 1}
    assert _partials(tmp_path) == []


def test_save_without_hard_links_refuses_when_the_rename_finds_a_file(tmp_path,
                                                                      monkeypatch):
    # Windows: the file appeared after the check, and os.rename refuses it.
    _no_hard_links(monkeypatch)
    target = tmp_path / "s.json"

    def rename(source, destination):
        target.write_text('{"theirs": 1}')
        raise FileExistsError(17, "File exists", source, None, destination)

    monkeypatch.setattr(sample.os, "rename", rename)

    with pytest.raises(sample.ApiError) as raised:
        sample.save_settings_file(str(target), BARE_SETTINGS)

    assert str(raised.value) == "{} already exists; use --force".format(target)
    assert json.loads(target.read_text()) == {"theirs": 1}
    assert _partials(tmp_path) == []


def test_save_without_hard_links_removes_the_side_file_when_rename_fails(tmp_path,
                                                                        monkeypatch):
    _no_hard_links(monkeypatch)

    def rename(source, destination):
        raise PermissionError(13, "Permission denied", destination)

    monkeypatch.setattr(sample.os, "rename", rename)

    out = str(tmp_path / "s.json")
    with pytest.raises(sample.LocalFileError) as raised:
        sample.save_settings_file(out, BARE_SETTINGS)
    assert str(raised.value) == "could not use {}: Permission denied.".format(out)
    assert _partials(tmp_path) == []


def test_download_force_replaces_and_leaves_no_side_file(tmp_path, monkeypatch):
    target = tmp_path / "settings.json"
    target.write_text('{"old": 1}')
    _install_fake_session(monkeypatch, _download_responses())

    rc = sample.main(["download", "--out", str(target), "--force"] + _creds())

    assert rc == 0
    assert json.loads(target.read_text()) == BARE_SETTINGS
    assert _partials(tmp_path) == []


@pytest.mark.skipif(os.name != "posix", reason="file modes are POSIX")
def test_download_side_file_is_private(tmp_path, monkeypatch):
    modes = []
    real_link = os.link

    def link(source, destination):
        modes.append(os.stat(source).st_mode & 0o777)
        real_link(source, destination)

    monkeypatch.setattr(sample.os, "link", link)
    _install_fake_session(monkeypatch, _download_responses())

    assert sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds()) == 0
    assert modes == [0o600]


def test_download_failed_move_removes_the_side_file(tmp_path, monkeypatch, capsys):
    def replace(source, destination):
        raise PermissionError(13, "Permission denied", destination)

    monkeypatch.setattr(sample.os, "replace", replace)
    session = _install_fake_session(monkeypatch, _download_responses())

    out = str(tmp_path / "s.json")
    rc = sample.main(["download", "--out", out, "--force"] + _creds())

    assert rc == 1
    assert capsys.readouterr().err == "ERROR: could not use {}: Permission denied.\n".format(out)
    assert _partials(tmp_path) == []
    assert _logged_out(session)


def test_download_ctrl_c_removes_the_side_file_and_logs_out(tmp_path, monkeypatch, capsys):
    def interrupted(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(sample.json, "dump", interrupted)
    session = _install_fake_session(monkeypatch, _download_responses())

    rc = sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds())

    assert rc == 130
    assert "Interrupted." in capsys.readouterr().err
    assert _partials(tmp_path) == []
    assert not (tmp_path / "s.json").exists()
    assert _logged_out(session)


def test_download_into_a_missing_folder_is_an_error_not_a_traceback(tmp_path, monkeypatch,
                                                                     capsys):
    _install_fake_session(monkeypatch, _download_responses())

    out = str(tmp_path / "nope" / "s.json")
    rc = sample.main(["download", "--out", out] + _creds())

    assert rc == 1
    err = capsys.readouterr().err
    # The --out path, not the side file, and the OS reason without a path.
    assert err == "ERROR: could not use {}: No such file or directory.\n".format(out)
    assert ".partial" not in err


def test_download_failure_logs_out(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("GET", SETTINGS_URL)] = FakeResponse(200, [1, 2])
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds())

    assert rc == 1
    assert "did not return a JSON object" in capsys.readouterr().err
    assert _logged_out(session)
    assert not (tmp_path / "s.json").exists()


def test_download_logout_failure_after_success_is_only_a_warning(tmp_path, monkeypatch,
                                                                 capsys):
    responses = _download_responses()
    responses[("DELETE", "/login/sessions/tok-1")] = FakeResponse(500)
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds())

    captured = capsys.readouterr()
    assert rc == 0
    assert "Downloaded" in captured.out
    assert captured.err == "WARNING: could not log out: Logout failed: HTTP 500.\n"


# ---------------------------------------------------------------------------
# main(): one rule for the final logout, one wording for reasons
# ---------------------------------------------------------------------------

def test_apply_logout_failure_after_engine_errors_is_a_warning(tmp_path, monkeypatch,
                                                                capsys):
    responses = dict(LOGIN_OK)
    responses[("PUT", SETTINGS_URL)] = FakeResponse(
        200, {"_error": {"sensitivity": "out of range"}})
    responses[("DELETE", "/login/sessions/tok-1")] = FakeResponse(500)
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    captured = capsys.readouterr()
    assert rc == 1
    assert captured.err == (
        "ERROR: The server took the settings but the Engine reported errors:\n"
        "  sensitivity: out of range\n"
        "WARNING: could not log out: Logout failed: HTTP 500.\n")


def test_logout_failure_after_a_failed_call_is_silent(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("GET", SETTINGS_URL)] = FakeResponse(404)
    responses[("DELETE", "/login/sessions/tok-1")] = FakeResponse(500)
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds())

    assert rc == 1
    assert capsys.readouterr().err == "ERROR: Reading settings failed: HTTP 404.\n"


def test_get_timeout_says_how_long_it_waited(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("GET", SETTINGS_URL)] = requests.exceptions.ReadTimeout(
        "HTTPSConnectionPool(host='server', port=7001): Read timed out. (read timeout=30)")
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds())

    assert rc == 1
    assert capsys.readouterr().err == (
        "ERROR: could not reach the server: no answer within 30 s.\n")


def test_login_connect_timeout_says_how_long_it_waited(tmp_path, monkeypatch, capsys):
    _install_fake_session(monkeypatch, {
        ("POST", "/login/sessions"): requests.exceptions.ConnectTimeout("connect timed out")})

    rc = sample.main(["apply", str(_settings_file(tmp_path)), "--yes"] + _creds())

    assert rc == 1
    assert capsys.readouterr().err == (
        "ERROR: could not reach the server: no connection within 30 s. "
        "The settings were not applied.\n")


def test_could_not_reach_reason_ends_with_one_period(tmp_path, monkeypatch, capsys):
    _install_fake_session(monkeypatch, {
        ("POST", "/login/sessions"): requests.exceptions.ConnectionError("refused.")})

    rc = sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds())

    assert rc == 1
    assert capsys.readouterr().err == "ERROR: could not reach the server: refused.\n"


def test_logout_timeout_after_success_says_how_long_it_waited(tmp_path, monkeypatch,
                                                              capsys):
    responses = _download_responses()
    responses[("DELETE", "/login/sessions/tok-1")] = requests.exceptions.ReadTimeout(
        "HTTPSConnectionPool(host='server', port=7001): Read timed out. (read timeout=30)")
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["download", "--out", str(tmp_path / "s.json")] + _creds())

    captured = capsys.readouterr()
    assert rc == 0
    assert captured.err == "WARNING: could not log out: no answer within 30 s.\n"


@pytest.mark.skipif(not hasattr(os, "symlink"), reason="no symlinks here")
def test_download_refuses_a_dangling_symlink_at_out_before_login(tmp_path, monkeypatch,
                                                                 capsys):
    link = tmp_path / "s.json"
    try:
        os.symlink(str(tmp_path / "missing.json"), str(link))
    except OSError:
        pytest.skip("cannot create symlinks here")
    session = _install_fake_session(monkeypatch, _download_responses())

    rc = sample.main(["download", "--out", str(link)] + _creds())

    assert rc == 1
    assert capsys.readouterr().err == "ERROR: {} already exists; use --force\n".format(link)
    assert session.calls == []
    assert not (tmp_path / "missing.json").exists()
