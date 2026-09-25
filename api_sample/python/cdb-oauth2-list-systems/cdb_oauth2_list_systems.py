#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx Cloud CDB API sample (OAuth2 bearer-token flow): log in and list your Sites.

This project uses bearer-token authentication only (no HTTP Basic). The flow:

  1. Log in once: POST /cdb/oauth2/token  ->  receive a short-lived bearer token.
  2. Use that token (Authorization: Bearer ...) for the actual work.
  3. List your Sites:  GET /cdb/systems.

Notes:
  - Works with accounts that have 2FA enabled (pass --mfa-code).
  - The password is sent once (to get the token), not on every request.
  - This is the authentication pattern used in Nx's own examples.

The token body fields (grant_type / response_type / client_id) come straight from
Network Optix's official cloud authentication example.

Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html
           https://support.networkoptix.com/hc/en-us/articles/32895719318935
"""

import argparse
import os
import sys

import requests


# ---------------------------------------------------------------------------
# Configuration (CLI > env > .env)
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
        # MFA code is only set when the account has 2FA enabled.
        "mfa_code": cli_args.mfa_code,
        # Optional. See the note on token scope below.
        "cloud_site_id": pick(cli_args.cloud_site_id, "NX_CLOUD_SITE_ID"),
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when login fails (bad credentials, missing/invalid 2FA code)."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

# A fixed client id Nx uses for third-party integrations in their examples.
CLIENT_ID = "3rdParty"


# Keys the CDB might use if it wraps the sites array inside an object.
_SYSTEM_LIST_KEYS = ("sites", "reply", "results", "items", "data")


def extract_systems(data):
    """Pull the list of sites out of the response, whatever its shape.

    Accepts a bare JSON array, or an object that wraps the array under a key
    such as "sites" / "reply" / "data". Falls back to the first list-of-objects
    value found in the object. Returns [] only when there is genuinely no list.
    """
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        # Try the known wrapper keys first (including a nested object).
        for key in _SYSTEM_LIST_KEYS:
            value = data.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                nested = extract_systems(value)
                if nested:
                    return nested
        # Last resort: any value that looks like a list of site objects.
        for value in data.values():
            if isinstance(value, list) and (not value or isinstance(value[0], dict)):
                return value
    return []


class NxCloudOAuthClient:
    """Cloud CDB client that authenticates with an OAuth2 bearer token."""

    def __init__(self, host, user, password, mfa_code=None, cloud_site_id=None,
                 verify_tls=True, session=None, timeout=15):
        self.host = (host or "").rstrip("/")
        self.user = user
        self.password = password
        self.mfa_code = mfa_code
        # Token scope:
        #   cloud_site_id is None -> a CLOUD (cdb) token. Use it for account-level
        #     CDB calls such as listing your Sites (what this sample does).
        #   cloud_site_id set      -> a SITE-SCOPED token. Required to operate
        #     against ONE specific site (e.g. that site's cameras via the relay).
        #     See ../rest-list-cameras-cloud-user for that flow.
        self.cloud_site_id = cloud_site_id
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.verify = verify_tls
        self.token = None      # Filled in by login().
        self.last_raw = None   # Raw JSON of the last /cdb/systems response.

    def login(self):
        """Exchange email + password (+ optional 2FA code) for a bearer token.

        Returns the access token string. Also stores it on self.token so later
        calls can send it automatically.
        """
        url = f"{self.host}/cdb/oauth2/token"
        # These four fields are the documented "password grant" request body.
        body = {
            "grant_type": "password",
            "response_type": "token",
            "client_id": CLIENT_ID,
            "username": self.user,
            "password": self.password,
        }
        # If the account uses 2FA, the one-time code goes in the body too.
        if self.mfa_code:
            body["mfaCode"] = self.mfa_code
        # Adding a scope ties the token to ONE site. Omit it for a cloud-wide
        # (cdb) token. Format matches Nx's create_cloud_auth_payload helper.
        if self.cloud_site_id:
            body["scope"] = f"cloudSystemId={self.cloud_site_id}"

        try:
            response = self.session.post(url, json=body, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc

        if response.status_code in (401, 403):
            raise AuthError(
                f"Login rejected (HTTP {response.status_code}). Check your "
                "credentials; if 2FA is enabled, pass --mfa-code."
            )
        if not response.ok:
            raise ApiError(
                f"Token request failed: HTTP {response.status_code} "
                f"{response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError("Token response was not valid JSON.") from exc

        self.token = data.get("access_token")
        if not self.token:
            raise ApiError("Token response did not contain an access_token.")
        return self.token

    def _auth_header(self):
        if not self.token:
            raise ApiError("Not logged in. Call login() first.")
        return {"Authorization": f"Bearer {self.token}"}

    def list_systems(self):
        """Return the account's Sites using the bearer token."""
        url = f"{self.host}/cdb/systems"
        try:
            response = self.session.get(
                url, headers=self._auth_header(), timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc

        if response.status_code in (401, 403):
            raise AuthError("Token was rejected. It may have expired; log in again.")
        if not response.ok:
            raise ApiError(
                f"Listing sites failed: HTTP {response.status_code} "
                f"{response.text[:200]}"
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError("Sites response was not valid JSON.") from exc

        # Keep the raw payload around so --debug can print it.
        self.last_raw = data
        # The CDB may return a bare array OR wrap it in an object (e.g.
        # {"sites": [...]}). extract_systems() handles either shape, so we
        # don't silently report zero sites just because of an envelope.
        return extract_systems(data)


# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------

def format_systems_table(sites):
    if not sites:
        return "No Sites found on this account."
    rows = [("NAME", "STATUS", "VERSION", "ID")]
    for site in sites:
        rows.append((
            str(site.get("name", "")),
            str(site.get("status", "")),
            str(site.get("version", "")),
            str(site.get("id", "")),
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
        description="Log in to the Nx Cloud via OAuth2 and list your Sites.")
    parser.add_argument("--host", default=None, help="Cloud host, e.g. https://nxvms.com")
    parser.add_argument("--user", default=None, help="Cloud account email")
    parser.add_argument("--password", default=None, help="Cloud account password")
    parser.add_argument("--mfa-code", default=None,
                        help="One-time 2FA code (only if your account has 2FA)")
    parser.add_argument("--cloud-site-id", default=None,
                        help="Scope the token to one site (cloudSystemId). "
                             "Omit for a cloud-wide token used to list Sites.")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (lab use only)")
    parser.add_argument("--debug", action="store_true",
                        help="Print the raw /cdb/systems JSON response")
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

    client = NxCloudOAuthClient(
        host=config["host"], user=config["user"], password=config["password"],
        mfa_code=config["mfa_code"], cloud_site_id=config["cloud_site_id"],
        verify_tls=not args.insecure,
    )

    try:
        client.login()
        print(f"Logged in as: {config['user']} (bearer token acquired)\n")
        sites = client.list_systems()
        if args.debug:
            import json
            print("--- raw /cdb/systems response ---", file=sys.stderr)
            print(json.dumps(client.last_raw, indent=2)[:4000], file=sys.stderr)
            print("--- end raw ---\n", file=sys.stderr)
        print(format_systems_table(sites))
        return 0
    except AuthError as exc:
        print(f"Login failed: {exc}", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
