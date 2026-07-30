# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for cdb_oauth2_sample.py. No network, no account needed.

Run from this folder:  pytest -v
"""

import argparse

import pytest

import cdb_oauth2_sample as sample


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
    """Serves a queued response per HTTP verb and records what was sent."""

    def __init__(self, post=None, get=None):
        self.verify = None
        self._post = post
        self._get = get
        self.post_url = self.post_json = None
        self.get_url = self.get_headers = None

    def post(self, url, json=None, timeout=None):
        self.post_url, self.post_json = url, json
        return self._post

    def get(self, url, headers=None, timeout=None):
        self.get_url, self.get_headers = url, headers
        return self._get


# ---------------------------------------------------------------------------
# login()
# ---------------------------------------------------------------------------

def test_login_returns_and_stores_token():
    session = FakeSession(post=FakeResponse(200, {"access_token": "nxcdb-xyz"}))
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       session=session)

    token = client.login()

    assert token == "nxcdb-xyz"
    assert client.token == "nxcdb-xyz"
    assert session.post_url == "https://nxvms.com/cdb/oauth2/token"
    # The documented password-grant fields must be present.
    assert session.post_json["grant_type"] == "password"
    assert session.post_json["client_id"] == "3rdParty"
    assert session.post_json["username"] == "me@x.com"
    # No 2FA code was supplied, so it must not be in the body.
    assert "mfaCode" not in session.post_json


def test_login_includes_mfa_code_when_set():
    session = FakeSession(post=FakeResponse(200, {"access_token": "t"}))
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       mfa_code="123456", session=session)
    client.login()
    assert session.post_json["mfaCode"] == "123456"


def test_login_bad_credentials_raises():
    session = FakeSession(post=FakeResponse(401, text="no"))
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       session=session)
    with pytest.raises(sample.AuthError):
        client.login()


def test_login_missing_token_raises_apierror():
    session = FakeSession(post=FakeResponse(200, {"something_else": 1}))
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       session=session)
    with pytest.raises(sample.ApiError):
        client.login()


# ---------------------------------------------------------------------------
# list_systems()
# ---------------------------------------------------------------------------

def test_list_systems_sends_bearer_header():
    payload = [{"id": "s1", "name": "HQ", "status": "activated", "version": "6.0"}]
    session = FakeSession(get=FakeResponse(200, payload))
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       session=session)
    client.token = "nxcdb-abc"  # pretend we already logged in

    sites = client.list_systems()

    assert sites[0]["name"] == "HQ"
    assert session.get_url == "https://nxvms.com/cdb/systems"
    assert session.get_headers["Authorization"] == "Bearer nxcdb-abc"


def test_list_systems_without_login_raises():
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       session=FakeSession())
    with pytest.raises(sample.ApiError):
        client.list_systems()


# ---------------------------------------------------------------------------
# config + table
# ---------------------------------------------------------------------------

def _args(**overrides):
    base = dict(host=None, user=None, password=None, mfa_code=None,
                cloud_site_id=None)
    base.update(overrides)
    return argparse.Namespace(**base)


def test_cli_overrides_env(monkeypatch):
    monkeypatch.setenv("NX_CLOUD_HOST", "https://env")
    config = sample.resolve_config(_args(host="https://cli"),
                                   {"NX_CLOUD_HOST": "https://file"})
    assert config["host"] == "https://cli"


def test_no_scope_means_cloud_wide_token():
    # Without a cloud_site_id, the request body must NOT carry a scope:
    # that yields a cloud-wide (cdb) token, correct for listing Sites.
    session = FakeSession(post=FakeResponse(200, {"access_token": "t"}))
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       session=session)
    client.login()
    assert "scope" not in session.post_json


def test_scope_set_when_cloud_site_id_given():
    # With a cloud_site_id, the body must carry scope=cloudSystemId=<id>,
    # which produces a site-scoped token.
    session = FakeSession(post=FakeResponse(200, {"access_token": "t"}))
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       cloud_site_id="sys-123", session=session)
    client.login()
    assert session.post_json["scope"] == "cloudSystemId=sys-123"


def test_list_systems_unwraps_object_envelope():
    # The real CDB may wrap the array in an object; we must still find sites.
    payload = {"sites": [{"id": "s1", "name": "HQ"}, {"id": "s2", "name": "Lab"}]}
    session = FakeSession(get=FakeResponse(200, payload))
    client = sample.NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw",
                                       session=session)
    client.token = "nxcdb-abc"
    sites = client.list_systems()
    assert [s["name"] for s in sites] == ["HQ", "Lab"]


def test_extract_systems_handles_shapes():
    bare = [{"id": "s1"}]
    assert sample.extract_systems(bare) is bare
    assert sample.extract_systems({"sites": bare}) == bare
    assert sample.extract_systems({"reply": bare}) == bare
    assert sample.extract_systems({"data": {"sites": bare}}) == bare
    # Unknown key but still a list of objects -> found by the fallback scan.
    assert sample.extract_systems({"whatever": bare}) == bare
    # Genuinely nothing -> empty list.
    assert sample.extract_systems({"count": 0}) == []
    assert sample.extract_systems("nope") == []


def test_format_systems_table():
    out = sample.format_systems_table(
        [{"id": "s1", "name": "HQ", "status": "activated", "version": "6.0"}])
    assert "NAME" in out and "HQ" in out
    assert "No Sites" in sample.format_systems_table([])
