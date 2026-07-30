#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx Cloud CDB API sample: keep a token-based session alive with refresh tokens.

THE IDEA (read this if you are new to token auth)
--------------------------------------------------
With token-based auth you do NOT send your password on every request. Instead:

  * You log in once and receive two things:
      - an ACCESS token  -> short-lived (minutes/hours). Sent on every API call
                            as  "Authorization: Bearer <access token>".
      - a REFRESH token  -> long-lived. Used ONLY to get new access tokens.
  * When the access token is about to expire, you call the token endpoint again
    with grant_type=refresh_token to get a fresh access token -- no password.
  * Some servers ROTATE the refresh token: the refresh response contains a NEW
    refresh token, and the old one stops working. You must store the new one.

So "the session" is really: {access_token, refresh_token, expiry}. This file
wraps that state in a TokenSession class and shows the three things you must do
to keep it healthy:

  1. PROACTIVE refresh  - refresh shortly BEFORE the access token expires.
  2. REACTIVE refresh   - if a call still returns 401, refresh once and retry.
  3. ROTATION + STORAGE - always keep the latest refresh token (and optionally
                          persist it to disk so the session survives a restart).

The calls themselves:

  Login:    POST /cdb/oauth2/token
            { grant_type:"password", response_type:"token", client_id:"3rdParty",
              username, password }
  Refresh:  POST /cdb/oauth2/token
            { grant_type:"refresh_token", response_type:"token",
              client_id:"3rdParty", refresh_token:"<latest refresh token>" }

Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html  (RFC 6749 §6)
"""

import argparse
import json
import os
import sys
import time

import requests


CLIENT_ID = "3rdParty"
# If the server doesn't tell us a lifetime, assume this many seconds.
DEFAULT_EXPIRES_IN_S = 3600
# Refresh this many seconds BEFORE the access token actually expires, so we
# never hand a request a token that dies mid-flight.
REFRESH_SAFETY_MARGIN_S = 60


# ---------------------------------------------------------------------------
# Configuration (CLI flag > OS environment variable > .env file)
# ---------------------------------------------------------------------------

def load_env_file(path=".env"):
    """Read a simple KEY=VALUE .env file into a dict. Missing file -> {}."""
    values = {}
    if not os.path.exists(path):
        return values
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_config(cli_args, env_file_values):
    """CLI flag > OS environment variable > .env file."""

    def pick(cli_value, env_key):
        if cli_value is not None:
            return cli_value
        if os.environ.get(env_key):
            return os.environ[env_key]
        return env_file_values.get(env_key)

    return {
        "host": pick(cli_args.host, "NX_CLOUD_HOST"),
        "user": pick(cli_args.user, "NX_CLOUD_USER"),
        "password": pick(cli_args.password, "NX_CLOUD_PASSWORD"),
        "mfa_code": cli_args.mfa_code,
        "refresh_token": pick(cli_args.refresh_token, "NX_CLOUD_REFRESH_TOKEN"),
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when the cloud rejects the login or the refresh token."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


# ---------------------------------------------------------------------------
# Request bodies (own functions so the exact payloads are easy to read/test)
# ---------------------------------------------------------------------------

def build_password_request(user, password, mfa_code=None):
    """Body for the initial login that returns access + refresh tokens."""
    body = {
        "grant_type": "password",
        "response_type": "token",
        "client_id": CLIENT_ID,
        "username": user,
        "password": password,
    }
    if mfa_code:
        body["mfaCode"] = mfa_code
    return body


def build_refresh_request(refresh_token):
    """Body for exchanging a refresh token for a fresh access token."""
    return {
        "grant_type": "refresh_token",
        "response_type": "token",
        "client_id": CLIENT_ID,
        "refresh_token": refresh_token,
    }


# ---------------------------------------------------------------------------
# The session: holds the tokens and the logic to keep them valid
# ---------------------------------------------------------------------------

class TokenSession:
    """A token-based session: access token + refresh token + expiry.

    Inject `session` (for tests) and `time_fn` (to make expiry testable).
    Pass `store_path` to persist the refresh token across program runs.
    """

    def __init__(self, host, store_path=None, verify_tls=True,
                 session=None, timeout=15, time_fn=time.time):
        self.host = (host or "").rstrip("/")
        self.store_path = store_path
        self.timeout = timeout
        self.time_fn = time_fn
        self.session = session or requests.Session()
        self.session.verify = verify_tls

        self.access_token = None
        self.refresh_token = None
        self.expires_at = 0.0   # epoch seconds when the access token expires
        self.last_raw = None    # raw JSON of the last token response (for --debug)

        # If we were given a store file, try to load a saved refresh token so we
        # can resume a session without logging in again.
        if store_path:
            self._load()

    # -- persistence -------------------------------------------------------

    def _load(self):
        """Load a previously saved session from disk (best-effort)."""
        try:
            with open(self.store_path, "r", encoding="utf-8") as handle:
                saved = json.load(handle)
            self.access_token = saved.get("access_token")
            self.refresh_token = saved.get("refresh_token")
            self.expires_at = float(saved.get("expires_at", 0) or 0)
        except (FileNotFoundError, ValueError):
            pass  # no/!valid store yet -> start fresh

    def _save(self):
        """Persist the current session. The file holds secrets, so 0600."""
        if not self.store_path:
            return
        data = {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
        }
        with open(self.store_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle)
        try:
            os.chmod(self.store_path, 0o600)  # owner read/write only
        except OSError:
            pass

    # -- core http ---------------------------------------------------------

    def _post_token(self, body, what):
        url = f"{self.host}/cdb/oauth2/token"
        try:
            response = self.session.post(url, json=body, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc

        if response.status_code in (401, 403):
            raise AuthError(
                f"{what} rejected (HTTP {response.status_code}). "
                "Check credentials / refresh token; add --mfa-code for a 2FA login.")
        if not response.ok:
            raise ApiError(
                f"{what} failed: HTTP {response.status_code} {response.text[:200]}")
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError(f"{what}: response was not valid JSON.") from exc
        if not data.get("access_token"):
            raise ApiError(f"{what}: response did not contain an access_token.")
        return data

    def _absorb(self, data):
        """Update session state from a token response, then persist it.

        This is where ROTATION happens: if the response carries a new refresh
        token we adopt it, because the previous one may now be invalid.
        """
        self.last_raw = data
        self.access_token = data["access_token"]
        expires_in = int(data.get("expires_in", DEFAULT_EXPIRES_IN_S))
        self.expires_at = self.time_fn() + expires_in
        if data.get("refresh_token"):
            self.refresh_token = data["refresh_token"]   # <-- keep the latest
        self._save()

    # -- public api --------------------------------------------------------

    def login(self, user, password, mfa_code=None):
        """First login with the password. Returns the raw token response."""
        data = self._post_token(
            build_password_request(user, password, mfa_code), "Login")
        self._absorb(data)
        return data

    def refresh(self):
        """Exchange the stored refresh token for a fresh access token."""
        if not self.refresh_token:
            raise ApiError("No refresh token available. Log in first.")
        data = self._post_token(
            build_refresh_request(self.refresh_token), "Refresh")
        self._absorb(data)
        return data

    def seconds_until_expiry(self):
        return self.expires_at - self.time_fn()

    def is_expiring(self, margin=REFRESH_SAFETY_MARGIN_S):
        """True if the access token is gone or within `margin` of expiry."""
        return self.seconds_until_expiry() <= margin

    def ensure_valid(self):
        """PROACTIVE refresh: get a usable access token, refreshing if needed.

        Call this right before you make an API request. It refreshes only when
        the token is missing or about to expire, so it is cheap to call often.
        """
        if not self.access_token and not self.refresh_token:
            raise ApiError("No session yet. Call login() first.")
        if self.is_expiring():
            self.refresh()
        return self.access_token

    def auth_header(self):
        return {"Authorization": f"Bearer {self.access_token}"}

    def authorized_get(self, path):
        """GET an API path with the bearer token.

        Demonstrates BOTH refresh strategies:
          - ensure_valid() refreshes proactively before the call,
          - and if the server still answers 401 (token revoked early, clock
            skew, rotation elsewhere), we refresh once and retry.
        """
        self.ensure_valid()
        url = f"{self.host}{path}"
        response = self.session.get(
            url, headers=self.auth_header(), timeout=self.timeout)
        if response.status_code == 401:
            self.refresh()           # reactive refresh
            response = self.session.get(
                url, headers=self.auth_header(), timeout=self.timeout)
        return response


# ---------------------------------------------------------------------------
# Printing helpers
# ---------------------------------------------------------------------------

def short(token):
    return (token[:24] + "...") if token and len(token) > 27 else (token or "")


def print_state(label, sess):
    line = (f"{label}: access_token={short(sess.access_token)}  "
            f"~{int(sess.seconds_until_expiry())}s to expiry  "
            f"refresh_token={short(sess.refresh_token)}")
    print(line)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Keep a token session alive with refresh tokens.")
    parser.add_argument("--host", default=None, help="Cloud host, e.g. https://nxvms.com")
    parser.add_argument("--user", default=None, help="Cloud account email")
    parser.add_argument("--password", default=None, help="Cloud account password")
    parser.add_argument("--mfa-code", default=None, help="One-time 2FA code")
    parser.add_argument("--refresh-token", default=None,
                        help="Resume using this refresh token (skip the password)")
    parser.add_argument("--store", default=None,
                        help="Persist the session to this file so it survives "
                             "restarts (holds secrets; written with 0600)")
    parser.add_argument("--force-refresh", action="store_true",
                        help="Do one refresh now to demonstrate rotation")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (lab use only)")
    parser.add_argument("--debug", action="store_true",
                        help="Print the raw token JSON responses")
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    config = resolve_config(args, load_env_file(args.env_file))

    if not config["host"]:
        print("Missing config: host. Provide --host or NX_CLOUD_HOST.", file=sys.stderr)
        return 2

    sess = TokenSession(host=config["host"], store_path=args.store,
                        verify_tls=not args.insecure)

    # A refresh token can come from the CLI/env even without a --store file.
    if config["refresh_token"]:
        sess.refresh_token = config["refresh_token"]

    try:
        # Decide how to establish the session.
        if sess.refresh_token and not (config["user"] and config["password"]):
            # Resume: we already have a refresh token, so skip the password.
            print("Resuming session from a refresh token (no password)...")
            sess.refresh()
            if args.debug:
                _dump(sess)
            print_state("resumed", sess)
        elif config["user"] and config["password"]:
            sess.login(config["user"], config["password"], config["mfa_code"])
            if args.debug:
                _dump(sess)
            print_state("login  ", sess)
        else:
            print("Provide --user/--password to log in, or --refresh-token to resume.",
                  file=sys.stderr)
            return 2

        # Optionally demonstrate a manual refresh (shows rotation if the server
        # issues a new refresh token).
        if args.force_refresh:
            before = sess.refresh_token
            sess.refresh()
            if args.debug:
                _dump(sess)
            print_state("refresh", sess)
            rotated = sess.refresh_token != before
            print(f"refresh token rotated: {rotated}")

        if args.store:
            print(f"\nSession saved to {args.store} — re-run without a password to resume.")
        return 0

    except AuthError as exc:
        print(f"Auth failed: {exc}", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


def _dump(sess):
    print("--- raw token response ---", file=sys.stderr)
    print(json.dumps(sess.last_raw, indent=2)[:4000], file=sys.stderr)
    print("--- end raw ---", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
