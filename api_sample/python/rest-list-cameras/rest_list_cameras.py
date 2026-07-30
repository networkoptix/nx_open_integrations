#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx VMS REST Server API sample: log in to ONE site and list its cameras.

This talks to a single VMS server/site (not the cloud). It is the step that
actually lists cameras, which the Cloud CDB cannot do. The flow follows Network
Optix's recommended bearer-token authentication, on the latest v4 REST API:

  1. Log in:    POST /rest/v4/login/sessions  {username, password}  -> {"token": ...}
  2. List:      GET  /rest/v4/devices         (Authorization: Bearer <token>)
  3. Log out:   DELETE /rest/v4/login/sessions/<token>   (clean up the session)

"Devices" are the cameras (and other media devices) attached to the site.

Connecting to the server:
  --host is the server, e.g. https://192.168.1.10:7001  (note the https + port),
  or a cloud relay address like https://<siteId>.relay.vmsproxy.com.
  Local servers usually present a self-signed certificate, so for a lab server
  you will typically need --insecure.

Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
           https://support.networkoptix.com/hc/en-us/articles/32895719318935
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


class NxServerClient:
    """Talks to a single VMS server using bearer-token auth."""

    def __init__(self, host, user, password, verify_tls=True, session=None, timeout=15):
        self.host = (host or "").rstrip("/")
        self.user = user
        self.password = password
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.verify = verify_tls
        self.token = None

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

    def login(self):
        """POST credentials, receive a bearer token, remember it."""
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
        return self.token

    def _auth_header(self):
        if not self.token:
            raise ApiError("Not logged in. Call login() first.")
        return {"Authorization": f"Bearer {self.token}"}

    def list_cameras(self):
        """GET the devices (cameras) on this site using the bearer token."""
        url = f"{self.host}{API}/devices"
        try:
            response = self.session.get(
                url, headers=self._auth_header(), timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        data = self._check(response, "Listing devices")
        # Some Nx versions wrap the array in a {"reply": [...]} envelope.
        if isinstance(data, dict) and isinstance(data.get("reply"), list):
            return data["reply"]
        return data if isinstance(data, list) else []

    def logout(self):
        """DELETE the session so the token cannot be reused. Best-effort."""
        if not self.token:
            return
        url = f"{self.host}{API}/login/sessions/{self.token}"
        try:
            self.session.delete(url, headers=self._auth_header(), timeout=self.timeout)
        except requests.exceptions.RequestException:
            # Logout is cleanup; never let it crash the program.
            pass
        finally:
            self.token = None


# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------

def format_cameras_table(cameras):
    """Build a plain-text table of cameras. Pure function = easy to test."""
    if not cameras:
        return "No cameras found on this site."
    rows = [("NAME", "STATUS", "MODEL", "ID")]
    for cam in cameras:
        rows.append((
            str(cam.get("name", "")),
            str(cam.get("status", "")),
            str(cam.get("model", "")),
            str(cam.get("id", "")),
        ))
    widths = [max(len(row[col]) for row in rows) for col in range(len(rows[0]))]
    return "\n".join(
        "  ".join(cell.ljust(widths[col]) for col, cell in enumerate(row))
        for row in rows
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Log in to one Nx VMS server and list its cameras.")
    parser.add_argument("--host", default=None,
                        help="Server URL, e.g. https://192.168.1.10:7001")
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

    client = NxServerClient(
        host=config["host"], user=config["user"], password=config["password"],
        verify_tls=not args.insecure,
    )

    try:
        client.login()
        print(f"Logged in to {config['host']} as {config['user']}\n")
        print(format_cameras_table(client.list_cameras()))
        return 0
    except AuthError as exc:
        print(f"Login failed: {exc}", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        # Always try to release the session token, even on error.
        client.logout()


if __name__ == "__main__":
    sys.exit(main())
