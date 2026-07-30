#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
List cameras on a SPECIFIC site using a CLOUD account.

This is the cloud-user counterpart of ../rest-list-cameras (which logs in as a
local server user). The key difference is the token:

  - A cloud-wide token (no scope) is NOT accepted by an individual site.
  - To call a site's API you need a token SCOPED to that site, obtained from the
    cloud with  scope = "cloudSystemId=<your-site-id>".

Flow (matches Network Optix's official cloud_bearer.py example):

  1. Get a site-scoped token:
        POST {cloud}/cdb/oauth2/token
        body: grant_type=password, response_type=token, client_id=3rdParty,
              username, password, scope="cloudSystemId=<id>"
  2. Reach the site through the Cloud relay:
        https://<site-id>.relay.vmsproxy.com
  3. List cameras:
        GET /rest/v4/devices   (Authorization: Bearer <site-token>)
  4. Delete the token on the cloud when done:
        DELETE {cloud}/cdb/oauth2/token/<site-token>

Reference: https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/authentication/cloud_bearer.py
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
        "cloud_host": pick(cli_args.cloud_host, "NX_CLOUD_HOST"),
        "user": pick(cli_args.user, "NX_CLOUD_USER"),
        "password": pick(cli_args.password, "NX_CLOUD_PASSWORD"),
        "site_id": pick(cli_args.site_id, "NX_CLOUD_SITE_ID"),
        "mfa_code": cli_args.mfa_code,
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when login or the scoped token is rejected."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


CLIENT_ID = "3rdParty"
RELAY_SUFFIX = ".relay.vmsproxy.com"
MAX_REDIRECTS = 5  # Most redirects we will follow when chasing the relay 307.


class NxCloudSiteClient:
    """Gets a site-scoped cloud token, then talks to that one site."""

    def __init__(self, cloud_host, user, password, site_id, mfa_code=None,
                 verify_tls=True, session=None, timeout=15):
        self.cloud_host = (cloud_host or "").rstrip("/")
        self.user = user
        self.password = password
        self.site_id = site_id
        self.mfa_code = mfa_code
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.verify = verify_tls
        self.token = None  # The SITE-SCOPED token.

    @property
    def relay_url(self):
        """The Cloud relay address for this specific site."""
        return f"https://{self.site_id}{RELAY_SUFFIX}"

    def login(self):
        """Get a token SCOPED to self.site_id from the cloud."""
        url = f"{self.cloud_host}/cdb/oauth2/token"
        body = {
            "grant_type": "password",
            "response_type": "token",
            "client_id": CLIENT_ID,
            "username": self.user,
            "password": self.password,
            # THIS scope is what makes the token usable against the site.
            "scope": f"cloudSystemId={self.site_id}",
        }
        if self.mfa_code:
            body["mfaCode"] = self.mfa_code

        try:
            response = self.session.post(url, json=body, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc

        if response.status_code in (401, 403):
            raise AuthError(
                f"Login rejected (HTTP {response.status_code}). Check credentials, "
                "the site id, and that the account has access to that site. "
                "Add --mfa-code for a 2FA account."
            )
        if not response.ok:
            raise ApiError(
                f"Token request failed: HTTP {response.status_code} "
                f"{response.text[:200]}")
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

    def _get_following_redirects(self, url):
        """GET that follows 307 redirects MANUALLY, re-attaching the bearer.

        The relay replies 307 pointing at the serving node. requests would
        strip the Authorization header across hosts, so we resend it
        ourselves.
        """
        headers = self._auth_header()
        for _hop in range(MAX_REDIRECTS + 1):
            try:
                response = self.session.get(
                    url, headers=headers, timeout=self.timeout,
                    allow_redirects=False)
            except requests.exceptions.RequestException as exc:
                raise ApiError(f"Could not reach {url}: {exc}") from exc
            # 301/302/303/307/308 -> follow with the bearer header preserved.
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("Location")
                if not location:
                    raise ApiError(f"Redirect {response.status_code} without a "
                                   "Location header.")
                url = location
                continue
            return response
        raise ApiError(f"Too many redirects (>{MAX_REDIRECTS}) chasing the relay.")

    def list_cameras(self):
        """List the site's cameras through the relay using the scoped token."""
        url = f"{self.relay_url}/rest/v4/devices"
        response = self._get_following_redirects(url)

        if response.status_code in (401, 403):
            raise AuthError(
                "The site rejected the token. Make sure it was scoped with "
                "cloudSystemId for THIS site.")
        if not response.ok:
            raise ApiError(
                f"Listing devices failed: HTTP {response.status_code} "
                f"{response.text[:200]}")
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError("Devices response was not valid JSON.") from exc
        if isinstance(data, dict) and isinstance(data.get("reply"), list):
            return data["reply"]
        return data if isinstance(data, list) else []

    def logout(self):
        """Delete the scoped token on the cloud. Best-effort cleanup."""
        if not self.token:
            return
        url = f"{self.cloud_host}/cdb/oauth2/token/{self.token}"
        try:
            self.session.delete(url, headers=self._auth_header(),
                                timeout=self.timeout)
        except requests.exceptions.RequestException:
            pass
        finally:
            self.token = None


# ---------------------------------------------------------------------------
# Pretty printing (same camera table as the local-user sample)
# ---------------------------------------------------------------------------

def format_cameras_table(cameras):
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
        description="List one cloud site's cameras using a cloud account.")
    parser.add_argument("--cloud-host", default=None,
                        help="Cloud host, e.g. https://nxvms.com")
    parser.add_argument("--user", default=None, help="Cloud account email")
    parser.add_argument("--password", default=None, help="Cloud account password")
    parser.add_argument("--site-id", default=None,
                        help="Cloud Site ID of the target site (RFC 4122 UUID)")
    parser.add_argument("--mfa-code", default=None,
                        help="One-time 2FA code (only if your account has 2FA)")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (lab use only)")
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    config = resolve_config(args, load_env_file(args.env_file))

    required = ("cloud_host", "user", "password", "site_id")
    missing = [name for name in required if not config[name]]
    if missing:
        print("Missing config: " + ", ".join(missing) +
              ".\nProvide via flags or .env (copy .env.example). See the README.",
              file=sys.stderr)
        return 2

    client = NxCloudSiteClient(
        cloud_host=config["cloud_host"], user=config["user"],
        password=config["password"], site_id=config["site_id"],
        mfa_code=config["mfa_code"], verify_tls=not args.insecure,
    )

    try:
        client.login()
        print(f"Got site-scoped token for {config['site_id']}\n")
        print(format_cameras_table(client.list_cameras()))
        return 0
    except AuthError as exc:
        print(f"Login failed: {exc}", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        client.logout()


if __name__ == "__main__":
    sys.exit(main())
