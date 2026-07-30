# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_list_cameras.py. No network, no server needed.

Run from this folder:  pytest -v
"""

import argparse

import pytest

import rest_list_cameras as sample


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
    """Serves queued responses per verb and records calls (incl. DELETE count)."""

    def __init__(self, post=None, get=None, delete=None):
        self.verify = None
        self._post, self._get, self._delete = post, get, delete
        self.post_url = self.post_json = None
        self.get_url = self.get_headers = None
        self.delete_url = None
        self.delete_calls = 0

    def post(self, url, json=None, timeout=None):
        self.post_url, self.post_json = url, json
        return self._post

    def get(self, url, headers=None, timeout=None):
        self.get_url, self.get_headers = url, headers
        return self._get

    def delete(self, url, headers=None, timeout=None):
        self.delete_url = url
        self.delete_calls += 1
        return self._delete


# ---------------------------------------------------------------------------
# login()
# ---------------------------------------------------------------------------

def test_login_posts_credentials_and_stores_token():
    session = FakeSession(post=FakeResponse(200, {"token": "abc123"}))
    client = sample.NxServerClient("https://srv:7001", "admin", "pw", session=session)

    token = client.login()

    assert token == "abc123"
    assert session.post_url == "https://srv:7001/rest/v4/login/sessions"
    assert session.post_json == {"username": "admin", "password": "pw",
                                 "setCookie": False}


def test_login_unauthorized_raises():
    session = FakeSession(post=FakeResponse(401, text="bad"))
    client = sample.NxServerClient("https://srv:7001", "admin", "pw", session=session)
    with pytest.raises(sample.AuthError):
        client.login()


def test_login_without_token_raises_apierror():
    session = FakeSession(post=FakeResponse(200, {"nope": 1}))
    client = sample.NxServerClient("https://srv:7001", "admin", "pw", session=session)
    with pytest.raises(sample.ApiError):
        client.login()


# ---------------------------------------------------------------------------
# list_cameras()
# ---------------------------------------------------------------------------

def test_list_cameras_plain_array():
    payload = [{"id": "c1", "name": "Lobby", "status": "Online", "model": "Axis"}]
    session = FakeSession(get=FakeResponse(200, payload))
    client = sample.NxServerClient("https://srv:7001", "admin", "pw", session=session)
    client.token = "abc123"

    cams = client.list_cameras()

    assert cams[0]["name"] == "Lobby"
    assert session.get_url == "https://srv:7001/rest/v4/devices"
    assert session.get_headers["Authorization"] == "Bearer abc123"


def test_list_cameras_unwraps_reply_envelope():
    # Some Nx versions return {"reply": [...]}; the client should unwrap it.
    payload = {"reply": [{"id": "c1", "name": "Lobby"}]}
    session = FakeSession(get=FakeResponse(200, payload))
    client = sample.NxServerClient("https://srv:7001", "admin", "pw", session=session)
    client.token = "abc123"

    cams = client.list_cameras()

    assert len(cams) == 1
    assert cams[0]["name"] == "Lobby"


def test_list_cameras_without_login_raises():
    client = sample.NxServerClient("https://srv:7001", "admin", "pw",
                                   session=FakeSession())
    with pytest.raises(sample.ApiError):
        client.list_cameras()


# ---------------------------------------------------------------------------
# logout()
# ---------------------------------------------------------------------------

def test_logout_deletes_session_and_clears_token():
    session = FakeSession(delete=FakeResponse(200, {}))
    client = sample.NxServerClient("https://srv:7001", "admin", "pw", session=session)
    client.token = "abc123"

    client.logout()

    assert session.delete_calls == 1
    assert session.delete_url == "https://srv:7001/rest/v4/login/sessions/abc123"
    assert client.token is None


def test_logout_without_token_is_noop():
    session = FakeSession()
    client = sample.NxServerClient("https://srv:7001", "admin", "pw", session=session)
    client.logout()  # should not raise or call delete
    assert session.delete_calls == 0


# ---------------------------------------------------------------------------
# config + table
# ---------------------------------------------------------------------------

def test_config_uses_server_env_vars(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://env:7001")
    args = argparse.Namespace(host=None, user=None, password=None)
    config = sample.resolve_config(args, {"NX_SERVER_HOST": "https://file:7001"})
    assert config["host"] == "https://env:7001"  # env beats file


def test_format_cameras_table():
    out = sample.format_cameras_table(
        [{"id": "c1", "name": "Lobby", "status": "Online", "model": "Axis"}])
    assert "NAME" in out and "Lobby" in out
    assert "No cameras" in sample.format_cameras_table([])
