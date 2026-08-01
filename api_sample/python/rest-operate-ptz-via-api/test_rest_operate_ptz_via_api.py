# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_operate_ptz_via_api.py. No network, no server needed.

Run from this folder:  pytest -v
"""

import argparse

import pytest

import rest_operate_ptz_via_api as sample


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text="", content=b"{}",
                headers=None):
        self.status_code = status_code
        self._json = json_data
        self.text = text
        self.content = content if json_data is None else b"1"
        self.headers = headers or {}

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class FakeSession:
    """Serves queued responses per verb and records calls.

    `request` serves a single response to every call (the common case);
    `requests_queue` serves a different response per call, in order (needed
    to simulate a redirect followed by the real response).
    """

    def __init__(self, post=None, request=None, requests_queue=None, delete=None):
        self.verify = None
        self._post, self._request, self._delete = post, request, delete
        self._requests_queue = list(requests_queue or [])
        self.post_url = self.post_json = None
        self.request_calls = []  # (method, url, headers, json, allow_redirects)
        self.delete_calls = 0
        self.delete_url = None

    def post(self, url, json=None, timeout=None):
        self.post_url, self.post_json = url, json
        return self._post

    def request(self, method, url, headers=None, json=None, timeout=None,
               allow_redirects=None):
        self.request_calls.append((method, url, headers, json, allow_redirects))
        if self._requests_queue:
            return self._requests_queue.pop(0)
        return self._request

    def delete(self, url, headers=None, timeout=None):
        self.delete_url = url
        self.delete_calls += 1
        return self._delete


# ---------------------------------------------------------------------------
# parse_ptz_capabilities()
# ---------------------------------------------------------------------------

def test_parse_ptz_capabilities_v4_string():
    info = {"ptz": {"capabilities": "ContinuousPanCapability|AbsoluteTiltCapability"}}
    caps = sample.parse_ptz_capabilities(info)
    assert caps == {"ContinuousPanCapability", "AbsoluteTiltCapability"}


def test_parse_ptz_capabilities_v3_bitmask():
    info = {"parameters": {"ptzCapabilities": 1 | 16}}
    caps = sample.parse_ptz_capabilities(info)
    assert caps == {"ContinuousPanCapability", "AbsolutePanCapability"}


def test_parse_ptz_capabilities_none_reported():
    assert sample.parse_ptz_capabilities({}) == set()
    assert sample.parse_ptz_capabilities(None) == set()


# ---------------------------------------------------------------------------
# build_ptz_request_body()
# ---------------------------------------------------------------------------

def test_build_body_move():
    body = sample.build_ptz_request_body("move", pan=0.5, tilt=0.2, zoom=0.1, speed=0.8)
    assert body == {"api": "operational", "pan": 0.5, "tilt": 0.2, "zoom": 0.1,
                    "speed": 0.8}


def test_build_body_abs_move():
    body = sample.build_ptz_request_body("abs_move", pan=1.0, tilt=0.0, zoom=0.0)
    assert body["type"] == "absolute"
    assert body["api"] == "operational"


def test_build_body_set_preset_default_name():
    body = sample.build_ptz_request_body("set_preset", pan=0.1, tilt=0.2, zoom=0.3)
    assert body["name"] == "Preset_0.1_0.2_0.3"
    assert "id" in body


def test_build_body_set_preset_custom_name():
    body = sample.build_ptz_request_body("set_preset", preset_name="my_preset")
    assert body["name"] == "my_preset"


def test_build_body_go_preset():
    assert sample.build_ptz_request_body("go_preset", speed=0.3) == {"speed": 0.3}


def test_build_body_unknown_operation():
    assert sample.build_ptz_request_body("stop") == {}


# ---------------------------------------------------------------------------
# NxPtzClient.login_local() / login_cloud()
# ---------------------------------------------------------------------------

def test_login_local_posts_credentials_and_stores_token():
    session = FakeSession(post=FakeResponse(200, {"token": "abc123"}))
    client = sample.NxPtzClient("https://srv:7001", session=session)

    token = client.login_local("admin", "pw")

    assert token == "abc123"
    assert session.post_url == "https://srv:7001/rest/v4/login/sessions"
    assert session.post_json == {"username": "admin", "password": "pw",
                                 "setCookie": False}


def test_login_local_unauthorized_raises():
    session = FakeSession(post=FakeResponse(401, text="bad"))
    client = sample.NxPtzClient("https://srv:7001", session=session)
    with pytest.raises(sample.AuthError):
        client.login_local("admin", "pw")


def test_login_cloud_scopes_token_to_site():
    session = FakeSession(post=FakeResponse(200, {"access_token": "cloudtoken"}))
    client = sample.NxPtzClient("https://sys.relay.vmsproxy.com", session=session)

    token = client.login_cloud("https://nxvms.com", "user@example.com", "pw", "sys")

    assert token == "cloudtoken"
    assert session.post_url == "https://nxvms.com/cdb/oauth2/token"
    assert session.post_json["scope"] == "cloudSystemId=sys"


# ---------------------------------------------------------------------------
# PTZ operations
# ---------------------------------------------------------------------------

def test_get_camera_returns_json():
    session = FakeSession(request=FakeResponse(200, {"name": "Cam 1"}))
    client = sample.NxPtzClient("https://srv:7001", session=session)
    client.token = "tok"

    info = client.get_camera("cam-1")

    assert info == {"name": "Cam 1"}
    method, url, headers, _, allow_redirects = session.request_calls[0]
    assert method == "GET"
    assert url == "https://srv:7001/rest/v4/devices/cam-1"
    assert headers["Authorization"] == "Bearer tok"
    assert allow_redirects is False  # redirects are followed manually


def test_ptz_move_start_posts_body():
    session = FakeSession(request=FakeResponse(200, content=b""))
    client = sample.NxPtzClient("https://srv:7001", session=session)
    client.token = "tok"

    client.ptz_move_start("cam-1", {"pan": 1.0})

    method, url, _, json_body, _ = session.request_calls[0]
    assert method == "POST"
    assert url == "https://srv:7001/rest/v4/devices/cam-1/ptz/move"
    assert json_body == {"pan": 1.0}


def test_ptz_move_stop_sends_delete():
    session = FakeSession(request=FakeResponse(200, content=b""))
    client = sample.NxPtzClient("https://srv:7001", session=session)
    client.token = "tok"

    client.ptz_move_stop("cam-1")

    method, url, _, json_body, _ = session.request_calls[0]
    assert method == "DELETE"
    assert json_body == {"api": "operational"}


def test_request_unauthorized_raises_autherror():
    session = FakeSession(request=FakeResponse(401, text="no"))
    client = sample.NxPtzClient("https://srv:7001", session=session)
    client.token = "tok"
    with pytest.raises(sample.AuthError):
        client.get_camera("cam-1")


def test_request_without_login_raises_apierror():
    client = sample.NxPtzClient("https://srv:7001", session=FakeSession())
    with pytest.raises(sample.ApiError):
        client.get_camera("cam-1")


# ---------------------------------------------------------------------------
# Cloud relay: 307 redirect handling
# ---------------------------------------------------------------------------

def test_request_follows_redirect_and_reattaches_auth_header():
    # The relay answers 307, pointing at the node that actually serves the
    # request; the client must resend the bearer header (and body) itself.
    session = FakeSession(requests_queue=[
        FakeResponse(307, headers={"Location":
                                   "https://node7.relay.vmsproxy.com/rest/v4/devices/cam-1"}),
        FakeResponse(200, {"name": "Cam 1"}),
    ])
    client = sample.NxPtzClient("https://sys.relay.vmsproxy.com", session=session)
    client.token = "cloudtoken"

    info = client.get_camera("cam-1")

    assert info == {"name": "Cam 1"}
    assert len(session.request_calls) == 2
    first_url, second_url = session.request_calls[0][1], session.request_calls[1][1]
    assert first_url == "https://sys.relay.vmsproxy.com/rest/v4/devices/cam-1"
    assert second_url == "https://node7.relay.vmsproxy.com/rest/v4/devices/cam-1"
    # The bearer header must be present on BOTH hops (requests would drop it
    # on an automatic cross-host redirect, which is exactly what this avoids).
    assert session.request_calls[0][2]["Authorization"] == "Bearer cloudtoken"
    assert session.request_calls[1][2]["Authorization"] == "Bearer cloudtoken"


def test_request_resends_body_across_redirect():
    session = FakeSession(requests_queue=[
        FakeResponse(307, headers={"Location":
                                   "https://node7.relay.vmsproxy.com/rest/v4/devices/cam-1/ptz/move"}),
        FakeResponse(200, content=b""),
    ])
    client = sample.NxPtzClient("https://sys.relay.vmsproxy.com", session=session)
    client.token = "cloudtoken"

    client.ptz_move_start("cam-1", {"pan": 0.5})

    assert session.request_calls[0][3] == {"pan": 0.5}
    assert session.request_calls[1][3] == {"pan": 0.5}  # body repeated on the 2nd hop


def test_request_too_many_redirects_raises_apierror():
    location = {"Location": "https://sys.relay.vmsproxy.com/rest/v4/devices/cam-1"}
    session = FakeSession(requests_queue=[FakeResponse(307, headers=location)
                                          for _ in range(sample.MAX_REDIRECTS + 1)])
    client = sample.NxPtzClient("https://sys.relay.vmsproxy.com", session=session)
    client.token = "cloudtoken"

    with pytest.raises(sample.ApiError):
        client.get_camera("cam-1")


# ---------------------------------------------------------------------------
# logout()
# ---------------------------------------------------------------------------

def test_logout_deletes_local_session_and_clears_token():
    session = FakeSession(delete=FakeResponse(200, content=b""))
    client = sample.NxPtzClient("https://srv:7001", session=session)
    client.token = "abc123"
    client._local_session = True

    client.logout()

    assert session.delete_calls == 1
    assert session.delete_url == "https://srv:7001/rest/v4/login/sessions/abc123"
    assert client.token is None


def test_logout_skips_delete_for_cloud_session():
    session = FakeSession()
    client = sample.NxPtzClient("https://sys.relay.vmsproxy.com", session=session)
    client.token = "cloudtoken"
    client._local_session = False

    client.logout()

    assert session.delete_calls == 0
    assert client.token is None


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def test_config_uses_server_env_vars(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://env:7001")
    args = argparse.Namespace(host=None, user=None, password=None, cloud_host=None,
                              site_id=None, device_id=None)
    config = sample.resolve_config(args, {"NX_SERVER_HOST": "https://file:7001"})
    assert config["host"] == "https://env:7001"  # env beats file
