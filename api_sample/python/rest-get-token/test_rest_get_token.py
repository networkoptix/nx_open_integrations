# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_get_token.py. No network, no server needed.

Run from this folder:  pytest -v
"""

import argparse

import pytest
import requests

import rest_get_token as sample


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeSession:
    """Serves queued responses per verb and records every call it was given.

    `get` accepts either a single response or a list, because this sample calls
    GET twice: once to use the token, once after logout to prove it is dead.
    """

    def __init__(self, post=None, get=None, delete=None):
        self.verify = None
        self._post = post
        self._get = list(get) if isinstance(get, list) else ([get] if get else [])
        self._delete = delete
        self.post_url = self.post_json = None
        self.get_calls = []        # list of (url, headers)
        self.delete_url = self.delete_headers = None
        self.delete_calls = 0

    def post(self, url, json=None, timeout=None):
        self.post_url, self.post_json = url, json
        if isinstance(self._post, Exception):
            raise self._post
        return self._post

    def get(self, url, headers=None, timeout=None):
        self.get_calls.append((url, headers))
        nxt = self._get.pop(0) if self._get else FakeResponse(200, {})
        if isinstance(nxt, Exception):
            raise nxt
        return nxt

    def delete(self, url, headers=None, timeout=None):
        self.delete_url, self.delete_headers = url, headers
        self.delete_calls += 1
        if isinstance(self._delete, Exception):
            raise self._delete
        return self._delete


SESSION_PAYLOAD = {
    "id": "{aaaa-bbbb}",
    "username": "admin",
    "token": "abc123",
    "ageS": 0,
    "expiresInS": 600,
}


def make_client(session):
    return sample.NxLoginClient("https://srv:7001", "admin", "pw", session=session)


# ---------------------------------------------------------------------------
# Step 1 — login()
# ---------------------------------------------------------------------------

def test_login_posts_credentials_and_stores_token():
    session = FakeSession(post=FakeResponse(200, SESSION_PAYLOAD))
    client = make_client(session)

    result = client.login()

    assert client.token == "abc123"
    assert session.post_url == "https://srv:7001/rest/v4/login/sessions"
    assert session.post_json == {"username": "admin", "password": "pw",
                                 "setCookie": False}
    # The whole session object comes back, not just the token string.
    assert result["expiresInS"] == 600
    assert result["id"] == "{aaaa-bbbb}"


def test_login_unauthorized_raises_autherror():
    session = FakeSession(post=FakeResponse(401, text="bad creds"))
    with pytest.raises(sample.AuthError):
        make_client(session).login()


def test_login_forbidden_raises_autherror():
    session = FakeSession(post=FakeResponse(403, text="nope"))
    with pytest.raises(sample.AuthError):
        make_client(session).login()


def test_login_without_token_raises_apierror():
    session = FakeSession(post=FakeResponse(200, {"id": "x", "username": "admin"}))
    with pytest.raises(sample.ApiError):
        make_client(session).login()


def test_login_unreachable_server_raises_apierror():
    session = FakeSession(post=requests.exceptions.ConnectionError("boom"))
    with pytest.raises(sample.ApiError):
        make_client(session).login()


# ---------------------------------------------------------------------------
# Step 2 — get_current_session()
# ---------------------------------------------------------------------------

def test_current_session_uses_bearer_header_on_current_path():
    session = FakeSession(get=FakeResponse(200, SESSION_PAYLOAD))
    client = make_client(session)
    client.token = "abc123"

    data = client.get_current_session()

    url, headers = session.get_calls[0]
    assert url == "https://srv:7001/rest/v4/login/sessions/current"
    # The path uses the sentinel; the header carries the token.
    assert headers["Authorization"] == "Bearer abc123"
    assert "abc123" not in url
    assert data["username"] == "admin"


def test_current_session_without_login_raises():
    with pytest.raises(sample.ApiError):
        make_client(FakeSession()).get_current_session()


def test_current_session_rejected_raises_autherror():
    session = FakeSession(get=FakeResponse(401, text="expired"))
    client = make_client(session)
    client.token = "abc123"
    with pytest.raises(sample.AuthError):
        client.get_current_session()


# ---------------------------------------------------------------------------
# Step 4 — token_still_works() must NOT raise: a 401 here is the good outcome
# ---------------------------------------------------------------------------

def test_token_still_works_true_while_session_is_live():
    session = FakeSession(get=FakeResponse(200, SESSION_PAYLOAD))
    live, status = make_client(session).token_still_works("abc123")
    assert live is True
    assert status == 200


def test_token_still_works_false_after_logout_without_raising():
    session = FakeSession(get=FakeResponse(401, text="unauthorized"))
    live, status = make_client(session).token_still_works("abc123")
    assert live is False
    assert status == 401


def test_token_still_works_reports_unknown_when_unreachable():
    session = FakeSession(get=requests.exceptions.ConnectionError("boom"))
    live, status = make_client(session).token_still_works("abc123")
    assert live is False
    assert status is None


# ---------------------------------------------------------------------------
# Step 3 — logout()
# ---------------------------------------------------------------------------

def test_logout_deletes_session_and_clears_token():
    session = FakeSession(delete=FakeResponse(200, {}))
    client = make_client(session)
    client.token = "abc123"

    assert client.logout() is True
    assert session.delete_calls == 1
    assert session.delete_url == "https://srv:7001/rest/v4/login/sessions/current"
    # The path uses the sentinel; the header carries the token.
    assert "abc123" not in session.delete_url
    assert session.delete_headers["Authorization"] == "Bearer abc123"
    assert client.token is None


def test_logout_without_token_is_noop():
    session = FakeSession()
    assert make_client(session).logout() is False
    assert session.delete_calls == 0


def test_logout_swallows_network_error():
    session = FakeSession(delete=requests.exceptions.ConnectionError("boom"))
    client = make_client(session)
    client.token = "abc123"

    assert client.logout() is False   # reported, not raised
    assert client.token is None       # still forgotten locally


# ---------------------------------------------------------------------------
# Config precedence: CLI > env > .env file
# ---------------------------------------------------------------------------

def test_config_env_beats_env_file(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://env:7001")
    args = argparse.Namespace(host=None, user=None, password=None)
    config = sample.resolve_config(args, {"NX_SERVER_HOST": "https://file:7001"})
    assert config["host"] == "https://env:7001"


def test_config_cli_beats_env(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://env:7001")
    args = argparse.Namespace(host="https://cli:7001", user=None, password=None)
    config = sample.resolve_config(args, {})
    assert config["host"] == "https://cli:7001"


def test_config_falls_back_to_env_file(monkeypatch):
    monkeypatch.delenv("NX_SERVER_USER", raising=False)
    args = argparse.Namespace(host=None, user=None, password=None)
    config = sample.resolve_config(args, {"NX_SERVER_USER": "fileuser"})
    assert config["user"] == "fileuser"


# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------

def test_format_session_shows_lifetime_fields():
    out = sample.format_session(SESSION_PAYLOAD)
    assert "abc123" in out
    assert "{aaaa-bbbb}" in out
    assert "600 seconds" in out


def test_format_session_omits_absent_lifetime_fields():
    out = sample.format_session({"token": "t", "id": "i", "username": "u"})
    assert "expires in" not in out
    assert "age" not in out


# ---------------------------------------------------------------------------
# main() end to end (all HTTP mocked)
# ---------------------------------------------------------------------------

def test_main_missing_config_returns_2(monkeypatch, tmp_path, capsys):
    for var in ("NX_SERVER_HOST", "NX_SERVER_USER", "NX_SERVER_PASSWORD"):
        monkeypatch.delenv(var, raising=False)
    code = sample.main(["--env-file", str(tmp_path / "nope.env")])
    assert code == 2
    assert "Missing config" in capsys.readouterr().err


def test_main_walks_the_whole_session_lifecycle(monkeypatch, tmp_path, capsys):
    # Login OK -> GET current OK -> DELETE OK -> GET current now 401.
    fake = FakeSession(
        post=FakeResponse(200, SESSION_PAYLOAD),
        get=[FakeResponse(200, SESSION_PAYLOAD), FakeResponse(401, text="gone")],
        delete=FakeResponse(200, {}),
    )
    monkeypatch.setattr(sample.requests, "Session", lambda: fake)

    code = sample.main([
        "--host", "https://srv:7001", "--user", "admin", "--password", "pw",
        "--env-file", str(tmp_path / "nope.env"),
    ])
    out = capsys.readouterr().out

    assert code == 0
    # All four steps happened, in order, exactly once each.
    assert fake.post_url.endswith("/rest/v4/login/sessions")
    assert len(fake.get_calls) == 2
    assert fake.delete_calls == 1
    # The post-logout rejection is presented as success, not as an error.
    assert "the token is rejected" in out
    assert "logout worked" in out


def test_main_insecure_disables_tls_verification(monkeypatch, tmp_path):
    fake = FakeSession(
        post=FakeResponse(200, SESSION_PAYLOAD),
        get=[FakeResponse(200, SESSION_PAYLOAD), FakeResponse(401)],
        delete=FakeResponse(200, {}),
    )
    monkeypatch.setattr(sample.requests, "Session", lambda: fake)

    sample.main([
        "--host", "https://srv:7001", "--user", "admin", "--password", "pw",
        "--insecure", "--env-file", str(tmp_path / "nope.env"),
    ])

    assert fake.verify is False


def test_main_bad_credentials_returns_1(monkeypatch, tmp_path, capsys):
    fake = FakeSession(post=FakeResponse(401, text="bad creds"))
    monkeypatch.setattr(sample.requests, "Session", lambda: fake)

    code = sample.main([
        "--host", "https://srv:7001", "--user", "admin", "--password", "wrong",
        "--env-file", str(tmp_path / "nope.env"),
    ])

    assert code == 1
    assert "Login failed" in capsys.readouterr().err
    # Nothing to release, so no stray DELETE on the failure path.
    assert fake.delete_calls == 0
