# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_cloud_sample.py. No network, no account needed.

Run from this folder:  pytest -v
"""

import argparse

import pytest

import rest_cloud_sample as sample


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
    """Serves queued GET responses in order (for redirect-chasing tests);
    POST/DELETE each return one fixed response."""

    def __init__(self, post=None, get=None, gets=None, delete=None):
        self.verify = None
        self._post, self._delete = post, delete
        self._gets = list(gets) if gets is not None else ([get] if get is not None else [])
        self.post_url = self.post_json = None
        self.get_calls = []  # (url, headers, allow_redirects)
        self.delete_url = None
        self.delete_calls = 0

    def post(self, url, json=None, timeout=None):
        self.post_url, self.post_json = url, json
        return self._post

    def get(self, url, headers=None, timeout=None, allow_redirects=None):
        self.get_calls.append((url, headers, allow_redirects))
        return self._gets.pop(0)

    def delete(self, url, headers=None, timeout=None):
        self.delete_url = url
        self.delete_calls += 1
        return self._delete

    # -- back-compat helpers used by the pre-existing single-GET tests --
    @property
    def get_url(self):
        return self.get_calls[-1][0] if self.get_calls else None

    @property
    def get_headers(self):
        return self.get_calls[-1][1] if self.get_calls else None

    @property
    def get_kwargs(self):
        return {"allow_redirects": self.get_calls[-1][2]} if self.get_calls else None


SYS = "11111111-2222-3333-4444-555555555555"


def make_client(**kw):
    defaults = dict(cloud_host="https://nxvms.com", user="me@x.com",
                    password="pw", site_id=SYS)
    defaults.update(kw)
    return sample.NxCloudSiteClient(**defaults)


# ---------------------------------------------------------------------------
# login(): the token MUST carry the cloudSystemId scope
# ---------------------------------------------------------------------------

def test_login_includes_system_scope():
    session = FakeSession(post=FakeResponse(200, {"access_token": "nxcdb-t"}))
    client = make_client(session=session)

    token = client.login()

    assert token == "nxcdb-t"
    assert session.post_url == "https://nxvms.com/cdb/oauth2/token"
    assert session.post_json["scope"] == f"cloudSystemId={SYS}"
    assert session.post_json["client_id"] == "3rdParty"


def test_login_adds_mfa_code():
    session = FakeSession(post=FakeResponse(200, {"access_token": "t"}))
    make_client(session=session, mfa_code="999111").login()
    assert session.post_json["mfaCode"] == "999111"


def test_login_rejected_raises_autherror():
    session = FakeSession(post=FakeResponse(403, text="no"))
    with pytest.raises(sample.AuthError):
        make_client(session=session).login()


# ---------------------------------------------------------------------------
# relay url + list_cameras()
# ---------------------------------------------------------------------------

def test_relay_url():
    assert make_client().relay_url == f"https://{SYS}.relay.vmsproxy.com"


def test_list_cameras_uses_relay_and_bearer():
    payload = [{"id": "c1", "name": "Lobby", "status": "Online", "model": "Axis"}]
    session = FakeSession(get=FakeResponse(200, payload))
    client = make_client(session=session)
    client.token = "nxcdb-t"

    cams = client.list_cameras()

    assert cams[0]["name"] == "Lobby"
    assert session.get_url == f"https://{SYS}.relay.vmsproxy.com/rest/v4/devices"
    assert session.get_headers["Authorization"] == "Bearer nxcdb-t"
    assert session.get_kwargs["allow_redirects"] is False


def test_list_cameras_unwraps_reply_envelope():
    session = FakeSession(get=FakeResponse(200, {"reply": [{"id": "c1", "name": "L"}]}))
    client = make_client(session=session)
    client.token = "t"
    assert client.list_cameras()[0]["name"] == "L"


def test_list_cameras_without_login_raises():
    with pytest.raises(sample.ApiError):
        make_client(session=FakeSession()).list_cameras()


def test_list_cameras_follows_307_with_bearer_preserved():
    # First GET -> 307 to the serving node; second GET -> the data.
    node = "https://node7.relay.vmsproxy.com/rest/v4/devices"
    session = FakeSession(gets=[
        FakeResponse(307, headers={"Location": node}),
        FakeResponse(200, [{"id": "c1", "name": "Lobby"}]),
    ])
    client = make_client(session=session)
    client.token = "nxcdb-t"

    cams = client.list_cameras()

    assert len(session.get_calls) == 2
    # Crucially, the bearer header is re-attached on the redirected request.
    assert session.get_calls[1][0] == node
    assert session.get_calls[1][1]["Authorization"] == "Bearer nxcdb-t"
    assert session.get_calls[1][2] is False  # still not auto-following
    assert cams[0]["name"] == "Lobby"


def test_list_cameras_redirect_without_location_raises():
    session = FakeSession(gets=[FakeResponse(307, headers={})])
    client = make_client(session=session)
    client.token = "t"
    with pytest.raises(sample.ApiError):
        client.list_cameras()


def test_list_cameras_too_many_redirects_raises():
    node = "https://node7.relay.vmsproxy.com/rest/v4/devices"
    # One more 307 than MAX_REDIRECTS allows -> should give up.
    session = FakeSession(
        gets=[FakeResponse(307, headers={"Location": node})] * (sample.MAX_REDIRECTS + 1)
    )
    client = make_client(session=session)
    client.token = "t"
    with pytest.raises(sample.ApiError):
        client.list_cameras()


# ---------------------------------------------------------------------------
# logout() deletes the token ON THE CLOUD
# ---------------------------------------------------------------------------

def test_logout_deletes_token_on_cloud():
    session = FakeSession(delete=FakeResponse(204))
    client = make_client(session=session)
    client.token = "nxcdb-t"

    client.logout()

    assert session.delete_url == "https://nxvms.com/cdb/oauth2/token/nxcdb-t"
    assert client.token is None


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def test_config_reads_site_id(monkeypatch):
    monkeypatch.setenv("NX_CLOUD_SITE_ID", "env-sys")
    args = argparse.Namespace(cloud_host=None, user=None, password=None,
                              site_id=None, mfa_code=None)
    config = sample.resolve_config(args, {"NX_CLOUD_SITE_ID": "file-sys"})
    assert config["site_id"] == "env-sys"


def test_format_cameras_table():
    out = sample.format_cameras_table([{"name": "Lobby"}])
    assert "Lobby" in out
    assert "No cameras" in sample.format_cameras_table([])
