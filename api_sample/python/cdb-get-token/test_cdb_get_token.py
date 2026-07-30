# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for cdb_get_token.py. No network, no account needed.

Run from this folder:  pytest -v
"""

import argparse

import pytest

import cdb_get_token as sample


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
    def __init__(self, post=None):
        self.verify = None
        self._post = post
        self.post_url = self.post_json = None

    def post(self, url, json=None, timeout=None):
        self.post_url, self.post_json = url, json
        return self._post


# ---------------------------------------------------------------------------
# build_token_request(): the request body
# ---------------------------------------------------------------------------

def test_body_minimal_fields():
    body = sample.build_token_request("me@x.com", "pw")
    assert body == {
        "grant_type": "password",
        "response_type": "token",
        "client_id": "3rdParty",
        "username": "me@x.com",
        "password": "pw",
    }


def test_body_adds_mfa_code_only_when_given():
    assert "mfaCode" not in sample.build_token_request("u", "p")
    assert sample.build_token_request("u", "p", mfa_code="123456")["mfaCode"] == "123456"


def test_body_adds_scope_only_when_site_id_given():
    assert "scope" not in sample.build_token_request("u", "p")
    body = sample.build_token_request("u", "p", cloud_site_id="sys-1")
    assert body["scope"] == "cloudSystemId=sys-1"


# ---------------------------------------------------------------------------
# get_token(): the call + response handling
# ---------------------------------------------------------------------------

def test_get_token_success():
    session = FakeSession(post=FakeResponse(200, {"access_token": "nxcdb-xyz",
                                                  "expires_in": 3600}))
    data = sample.get_token("https://nxvms.com", "me@x.com", "pw", session=session)

    assert data["access_token"] == "nxcdb-xyz"
    assert session.post_url == "https://nxvms.com/cdb/oauth2/token"
    assert session.post_json["username"] == "me@x.com"


def test_get_token_trims_trailing_slash_in_host():
    session = FakeSession(post=FakeResponse(200, {"access_token": "t"}))
    sample.get_token("https://nxvms.com/", "u", "p", session=session)
    assert session.post_url == "https://nxvms.com/cdb/oauth2/token"


def test_get_token_bad_credentials_raises():
    session = FakeSession(post=FakeResponse(401, text="no"))
    with pytest.raises(sample.AuthError):
        sample.get_token("https://nxvms.com", "u", "p", session=session)


def test_get_token_missing_token_raises():
    session = FakeSession(post=FakeResponse(200, {"something": 1}))
    with pytest.raises(sample.ApiError):
        sample.get_token("https://nxvms.com", "u", "p", session=session)


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def test_cli_overrides_env(monkeypatch):
    monkeypatch.setenv("NX_CLOUD_USER", "env-user")
    args = argparse.Namespace(host=None, user="cli-user", password=None,
                              mfa_code=None, cloud_site_id=None)
    config = sample.resolve_config(args, {"NX_CLOUD_USER": "file-user"})
    assert config["user"] == "cli-user"
