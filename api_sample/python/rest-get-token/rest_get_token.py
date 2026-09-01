#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx REST Server API sample: the login session lifecycle.

This is the smallest possible "how do I authenticate through the Nx REST API?" sample. 
It gets a bearer token from the mediaserver, uses it on a real authenticated request, gives it
back, and then proves the token is deleted/dead.

The flow, on the latest v4 REST API:

  1. Log in/create session:   
  POST   /rest/v4/login/sessions          {username, password}
  -> {"id", "username", "token", "ageS", "expiresInS"}
  
  2. Use the token:   
  GET    /rest/v4/login/sessions/current  (Authorization: Bearer <token>)
  The literal "current" (or "-") means "the token in my auth header",so this call both proves 
  the token works AND shows what a session is.
  
  3. Log out, revoke the tokens:  
  DELETE /rest/v4/login/sessions/current  (release the session and revoke the token)

  4. Re-check: 
  GET    /rest/v4/login/sessions/current  
  -> now fails, as it should.(optional in sample but recommend in real applications)

"""

import argparse
import os
import sys

import requests


# ---------------------------------------------------------------------------
# Configuration (CLI > env > .env). Server vars are NX_SERVER_*.
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
        "host": pick(cli_args.host, "NX_SERVER_HOST"),
        "user": pick(cli_args.user, "NX_SERVER_USER"),
        "password": pick(cli_args.password, "NX_SERVER_PASSWORD"),
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when the server rejects the credentials or token."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

# API version path segment. v4 is the latest Nx REST API.
API = "/rest/v4"


class NxLoginClient:
    """Creates, inspects and destroys a login session on one mediaserver."""

    def __init__(self, host, user, password, verify_tls=True, session=None, timeout=15):
        self.host = (host or "").rstrip("/")
        self.user = user
        self.password = password
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.verify = verify_tls
        if not verify_tls:
            # --insecure is expected for local servers with self-signed certs;
            # don't spam the console with a warning for every request.
            requests.packages.urllib3.disable_warnings(
                requests.packages.urllib3.exceptions.InsecureRequestWarning)
        self.token = None

    # -- shared plumbing ---------------------------------------------------

    def _check(self, response, what):
        """Shared response validation -> typed errors + parsed JSON."""
        if response.status_code in (401, 403):
            raise AuthError(
                f"{what} unauthorized (HTTP {response.status_code}). Check the "
                "username/password, and that you are using a local (not cloud) user."
            )
        if not response.ok:
            raise ApiError(
                f"{what} failed: HTTP {response.status_code} {response.text[:200]}")
        try:
            return response.json()
        except ValueError as exc:
            raise ApiError(f"{what}: response was not valid JSON.") from exc

    def _auth_header(self, token=None):
        """Build the bearer header. This is the ONLY place the token is used."""
        token = token or self.token
        if not token:
            raise ApiError("Not logged in. Call login() first.")
        return {"Authorization": f"Bearer {token}"}

    # -- step 1: get a token ----------------------------------------------

    def login(self):
        """POST credentials, receive a session (incl. its token), remember it.

        Returns the whole session object, not just the token, because the other
        fields are the interesting part: `expiresInS` is how long you have.
        """
        url = f"{self.host}{API}/login/sessions"
        body = {"username": self.user, "password": self.password, "setCookie": False}
        try:
            response = self.session.post(url, json=body, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        data = self._check(response, "Login")
        self.token = data.get("token")
        if not self.token:
            raise ApiError("Login response did not contain a token.")
        return data

    # -- step 2: use the token --------------------------------------------

    def get_current_session(self):
        """GET the session that the bearer token in our header belongs to.

        The path literal "current" (the v4 API also accepts "-") means
        "whatever token is in the Authorization header", so the request needs
        no token in the path.

        A successful call here is the proof that the token works: the server
        only answers if it recognises the token we sent.
        """
        url = f"{self.host}{API}/login/sessions/current"
        try:
            response = self.session.get(
                url, headers=self._auth_header(), timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        return self._check(response, "Reading the current session")

    # -- step 4: confirm the token really is dead --------------------------

    def token_still_works(self, token):
        """Probe the session endpoint with `token` and report whether it is live.

        Unlike get_current_session() this NEVER raises on a rejection: after
        logout a 401 is the expected, correct answer, not a failure. Returns
        (is_live, status_code); status_code is None if the request never landed.
        """
        url = f"{self.host}{API}/login/sessions/current"
        try:
            response = self.session.get(
                url, headers=self._auth_header(token), timeout=self.timeout)
        except requests.exceptions.RequestException:
            # Can't reach the server, so we can't say. Report "not live".
            return False, None
        return response.ok, response.status_code

    # -- step 3: give the token back ---------------------------------------

    def logout(self):
        """DELETE the session so the token cannot be reused.

        Best-effort by design: this is cleanup, and cleanup failing should never
        be the thing that crashes the program. Returns True if the server
        confirmed it. Clears the remembered token either way.
        """
        if not self.token:
            return False
        # Address the session with the "current" sentinel; the server takes the
        # token from the Authorization header.
        url = f"{self.host}{API}/login/sessions/current"
        try:
            response = self.session.delete(
                url, headers=self._auth_header(), timeout=self.timeout)
            return bool(getattr(response, "ok", False))
        except requests.exceptions.RequestException:
            return False
        finally:
            self.token = None


# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------

def format_session(session):
    """Build a plain-text block describing a session. Pure function = testable."""
    rows = [
        ("token", str(session.get("token", ""))),
        ("session id", str(session.get("id", ""))),
        ("username", str(session.get("username", ""))),
    ]
    # ageS / expiresInS are seconds, per the v4 spec field names.
    if session.get("ageS") is not None:
        rows.append(("age", f"{session['ageS']} seconds"))
    if session.get("expiresInS") is not None:
        rows.append(("expires in", f"{session['expiresInS']} seconds"))
    width = max(len(label) for label, _ in rows)
    return "\n".join(f"{label.ljust(width)} : {value}" for label, value in rows)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Get a bearer token from an Nx mediaserver, use it, and release it.")
    parser.add_argument("--host", default=None,
                        help="Mediaserver URL, e.g. https://192.168.1.10:7001")
    parser.add_argument("--user", default=None, help="Local server username")
    parser.add_argument("--password", default=None, help="Local server password")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (usually needed for local servers)")
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    config = resolve_config(args, load_env_file(args.env_file))

    missing = [name for name in ("host", "user", "password") if not config[name]]
    if missing:
        print("Missing config: " + ", ".join(missing) +
              ".\nProvide via flags or .env (copy .env.example). See the README.",
              file=sys.stderr)
        return 2

    client = NxLoginClient(
        host=config["host"], user=config["user"], password=config["password"],
        verify_tls=not args.insecure,
    )

    try:
        # 1. Trade the username/password for a token.
        session = client.login()
        print(f"Logged in to {config['host']} as {config['user']}\n")
        print(format_session(session))

        # 2. Use the token on a real authenticated request.
        print(f"\nUsing the token: GET {API}/login/sessions/current")
        live = client.get_current_session()
        print("  -> 200 OK, the server recognised the token. "
              f"Session belongs to '{live.get('username', '')}'.")

        # 3. Hand the token back. Keep a copy so we can prove it stopped working.
        spent_token = client.token
        print(f"\nLogging out: DELETE {API}/login/sessions/current")
        confirmed = client.logout()
        print("  -> session deleted." if confirmed else
              "  -> the server did not confirm the delete (the session may still expire on its own).")

        # 4. Show that the token really is gone. A rejection here is success.
        print(f"\nRe-checking with the same token: GET {API}/login/sessions/current")
        still_live, status = client.token_still_works(spent_token)
        if still_live:
            print("  -> unexpectedly still accepted. The session was not released.")
        elif status is None:
            print("  -> could not reach the server to confirm.")
        else:
            print(f"  -> HTTP {status}, the token is rejected. "
                  "That is the expected result: logout worked.")
        return 0
    except AuthError as exc:
        print(f"Login failed: {exc}", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        # If we bailed out early the session is still open; release it.
        client.logout()


if __name__ == "__main__":
    sys.exit(main())
