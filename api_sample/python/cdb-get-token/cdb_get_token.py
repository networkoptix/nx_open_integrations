#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx Cloud CDB API sample: get an OAuth2 bearer token (and nothing else).

This is the smallest possible "how do I authenticate?" example. It performs the
single login call and prints the token. Once you have the token you put it in an
`Authorization: Bearer <token>` header on any other CDB / site request.

The one call:

    POST {cloud}/cdb/oauth2/token
    Content-Type: application/json
    {
      "grant_type":   "password",
      "response_type":"token",
      "client_id":    "3rdParty",
      "username":     "<your cloud email>",
      "password":     "<your cloud password>"
    }

Optional fields:
  - "mfaCode": "123456"            -> if your account has 2FA enabled
  - "scope":   "cloudSystemId=<id>"-> scope the token to ONE site (omit for a
                                      cloud-wide token)

The response contains "access_token" (it begins with "nxcdb-").

Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html
           https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/authentication/cloud_bearer.py
"""

import argparse
import os
import sys

import requests


# A fixed client id Nx uses for third-party integrations in their examples.
CLIENT_ID = "3rdParty"


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
        "cloud_site_id": pick(cli_args.cloud_site_id, "NX_CLOUD_SITE_ID"),
    }


# ---------------------------------------------------------------------------
# The one function that matters: build the body and call the endpoint
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when the cloud rejects the login (bad credentials / 2FA)."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


def build_token_request(user, password, mfa_code=None, cloud_site_id=None):
    """Return the exact JSON body sent to POST /cdb/oauth2/token.

    Kept as its own function so it is easy to read and easy to test.
    """
    body = {
        "grant_type": "password",
        "response_type": "token",
        "client_id": CLIENT_ID,
        "username": user,
        "password": password,
    }
    if mfa_code:
        body["mfaCode"] = mfa_code          # only when the account uses 2FA
    if cloud_site_id:
        # Scope the token to one site. Omit for a cloud-wide token.
        body["scope"] = f"cloudSystemId={cloud_site_id}"
    return body


def get_token(host, user, password, mfa_code=None, cloud_site_id=None,
              verify_tls=True, session=None, timeout=15):
    """Perform the login and return the full token response (a dict).

    The access token itself is under the "access_token" key.
    """
    session = session or requests.Session()
    session.verify = verify_tls
    url = f"{host.rstrip('/')}/cdb/oauth2/token"
    body = build_token_request(user, password, mfa_code, cloud_site_id)

    try:
        response = session.post(url, json=body, timeout=timeout)
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

    if not data.get("access_token"):
        raise ApiError("Token response did not contain an access_token.")
    return data


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Get an OAuth2 bearer token from the Nx Cloud.")
    parser.add_argument("--host", default=None, help="Cloud host, e.g. https://nxvms.com")
    parser.add_argument("--user", default=None, help="Cloud account email")
    parser.add_argument("--password", default=None, help="Cloud account password")
    parser.add_argument("--mfa-code", default=None,
                        help="One-time 2FA code (only if your account has 2FA)")
    parser.add_argument("--cloud-site-id", default=None,
                        help="Scope the token to one site (omit for cloud-wide)")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (lab use only)")
    parser.add_argument("--token-only", action="store_true",
                        help="Print just the token string (handy for scripting)")
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

    try:
        data = get_token(
            host=config["host"], user=config["user"], password=config["password"],
            mfa_code=config["mfa_code"], cloud_site_id=config["cloud_site_id"],
            verify_tls=not args.insecure,
        )
    except AuthError as exc:
        print(f"Login failed: {exc}", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1

    token = data["access_token"]
    if args.token_only:
        # Just the raw token, e.g. for:  TOKEN=$(python cdb_get_token.py --token-only ...)
        print(token)
        return 0

    print("Token acquired.\n")
    print(f"access_token : {token}")
    # expires_in is reported in seconds when present.
    if "expires_in" in data:
        print(f"expires_in   : {data['expires_in']} seconds")
    print("\nUse it on later requests as a header:")
    print(f'  Authorization: Bearer {token}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
