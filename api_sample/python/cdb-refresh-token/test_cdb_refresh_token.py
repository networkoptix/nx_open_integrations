# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for cdb_refresh_token.py. No network, no account needed.

These cover the session lifecycle: expiry tracking, proactive refresh, refresh
token rotation, reactive 401-retry, and on-disk persistence.

Run from this folder:  pytest -v
"""

import argparse

import pytest

import cdb_refresh_token as sample


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
    """Serves queued POST and GET responses in order; records each call."""

    def __init__(self, posts=None, gets=None):
        self.verify = None
        self._posts = list(posts or [])
        self._gets = list(gets or [])
        self.post_calls = []  # (url, body)
        self.get_calls = []   # (url, headers)

    def post(self, url, json=None, timeout=None):
        self.post_calls.append((url, json))
        return self._posts.pop(0)

    def get(self, url, headers=None, timeout=None):
        self.get_calls.append((url, headers))
        return self._gets.pop(0)


class Clock:
    """A controllable time source so expiry logic is deterministic."""

    def __init__(self, now=1000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def make_session(posts=None, gets=None, clock=None, store_path=None):
    clock = clock or Clock()
    fake = FakeSession(posts=posts, gets=gets)
    sess = sample.TokenSession("https://nxvms.com", store_path=store_path,
                               session=fake, time_fn=clock)
    return sess, fake, clock


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------

def test_password_body():
    body = sample.build_password_request("me@x.com", "pw")
    assert body["grant_type"] == "password"
    assert body["client_id"] == "3rdParty"
    assert "mfaCode" not in body


def test_refresh_body():
    assert sample.build_refresh_request("r1") == {
        "grant_type": "refresh_token",
        "response_type": "token",
        "client_id": "3rdParty",
        "refresh_token": "r1",
    }


# ---------------------------------------------------------------------------
# login() / refresh() basics
# ---------------------------------------------------------------------------

def test_login_sets_tokens_and_expiry():
    sess, fake, clock = make_session(posts=[
        FakeResponse(200, {"access_token": "a1", "refresh_token": "r1",
                           "expires_in": 3600})])
    sess.login("me@x.com", "pw")
    assert sess.access_token == "a1"
    assert sess.refresh_token == "r1"
    assert sess.expires_at == clock.now + 3600
    assert fake.post_calls[0][1]["grant_type"] == "password"


def test_refresh_sends_no_password():
    sess, fake, _ = make_session(posts=[FakeResponse(200, {"access_token": "a2"})])
    sess.refresh_token = "r1"
    sess.refresh()
    body = fake.post_calls[0][1]
    assert body["grant_type"] == "refresh_token"
    assert "password" not in body


def test_refresh_without_token_raises():
    sess, _, _ = make_session()
    with pytest.raises(sample.ApiError):
        sess.refresh()


# ---------------------------------------------------------------------------
# Rotation: a new refresh token in the response must replace the old one
# ---------------------------------------------------------------------------

def test_refresh_token_rotation():
    sess, _, _ = make_session(posts=[
        FakeResponse(200, {"access_token": "a2", "refresh_token": "r2"})])
    sess.refresh_token = "r1"
    sess.refresh()
    assert sess.refresh_token == "r2"   # adopted the rotated token


def test_refresh_keeps_old_token_when_none_returned():
    sess, _, _ = make_session(posts=[FakeResponse(200, {"access_token": "a2"})])
    sess.refresh_token = "r1"
    sess.refresh()
    assert sess.refresh_token == "r1"   # unchanged when server omits it


# ---------------------------------------------------------------------------
# Expiry + proactive ensure_valid()
# ---------------------------------------------------------------------------

def test_is_expiring_respects_margin():
    sess, _, clock = make_session()
    sess.access_token = "a1"
    sess.expires_at = clock.now + 3600
    assert not sess.is_expiring()
    clock.advance(3600 - 10)            # 10s left, inside the 60s margin
    assert sess.is_expiring()


def test_ensure_valid_refreshes_only_when_needed():
    # First login (fresh token, far from expiry), then ensure_valid should NOT
    # refresh. After we advance the clock, it SHOULD refresh.
    sess, fake, clock = make_session(posts=[
        FakeResponse(200, {"access_token": "a1", "refresh_token": "r1",
                           "expires_in": 3600}),
        FakeResponse(200, {"access_token": "a2", "refresh_token": "r2",
                           "expires_in": 3600}),
    ])
    sess.login("me@x.com", "pw")
    sess.ensure_valid()
    assert sess.access_token == "a1"     # no refresh happened
    assert len(fake.post_calls) == 1

    clock.advance(3600)                  # now expired
    sess.ensure_valid()
    assert sess.access_token == "a2"     # proactive refresh happened
    assert len(fake.post_calls) == 2


# ---------------------------------------------------------------------------
# Reactive 401 -> refresh -> retry
# ---------------------------------------------------------------------------

def test_authorized_get_retries_after_401():
    sess, fake, clock = make_session(
        posts=[FakeResponse(200, {"access_token": "a2", "refresh_token": "r2"})],
        gets=[FakeResponse(401, text="expired"),
              FakeResponse(200, {"ok": True})],
    )
    sess.access_token = "a1"
    sess.refresh_token = "r1"
    sess.expires_at = clock.now + 3600   # not expiring, so the 401 is a surprise

    resp = sess.authorized_get("/cdb/systems")

    assert resp.status_code == 200
    assert len(fake.post_calls) == 1                 # one reactive refresh
    assert fake.get_calls[1][1]["Authorization"] == "Bearer a2"  # retried w/ new token


# ---------------------------------------------------------------------------
# Persistence across "runs"
# ---------------------------------------------------------------------------

def test_session_persists_and_reloads(tmp_path):
    store = str(tmp_path / "session.json")

    # Run 1: log in, which saves the refresh token to disk.
    sess1, _, _ = make_session(
        posts=[FakeResponse(200, {"access_token": "a1", "refresh_token": "r1",
                                  "expires_in": 3600})],
        store_path=store)
    sess1.login("me@x.com", "pw")

    # Run 2: a brand-new session with the same store loads the refresh token,
    # so it can refresh without a password.
    sess2, fake2, _ = make_session(
        posts=[FakeResponse(200, {"access_token": "a2", "refresh_token": "r2"})],
        store_path=store)
    assert sess2.refresh_token == "r1"   # loaded from disk
    sess2.refresh()
    assert sess2.access_token == "a2"
    assert "password" not in fake2.post_calls[0][1]


# ---------------------------------------------------------------------------
# Errors + config
# ---------------------------------------------------------------------------

def test_login_bad_credentials_raises():
    sess, _, _ = make_session(posts=[FakeResponse(401, text="no")])
    with pytest.raises(sample.AuthError):
        sess.login("u", "p")


def test_config_reads_refresh_token_env(monkeypatch):
    monkeypatch.setenv("NX_CLOUD_REFRESH_TOKEN", "env-rt")
    args = argparse.Namespace(host=None, user=None, password=None,
                              mfa_code=None, refresh_token=None)
    config = sample.resolve_config(args, {})
    assert config["refresh_token"] == "env-rt"
