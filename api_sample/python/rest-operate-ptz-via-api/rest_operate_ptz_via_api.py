#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx VMS REST API sample: drive a PTZ (Pan-Tilt-Zoom) camera on one site.

Talks to a single VMS server/site (local, or a cloud account routed through the
Cloud relay) and issues PTZ commands. The flow follows Network Optix's
recommended bearer-token authentication, on the v4 REST API:

  1. Log in:
       Local:  POST /rest/v4/login/sessions  {username, password} -> {"token": ...}
       Cloud:  POST {cloud}/cdb/oauth2/token  {..., scope:"cloudSystemId=<id>"}
               -> {"access_token": ...}, then talk to the relay
               https://<site id>.relay.vmsproxy.com
  2. Read camera info:  GET /rest/v4/devices/{id}   (used to report PTZ capabilities)
  3. Issue PTZ commands:
       Continuous move:  POST/DELETE /rest/v4/devices/{id}/ptz/move
       Absolute move:    POST /rest/v4/devices/{id}/ptz/position
       Presets:          GET/POST /rest/v4/devices/{id}/ptz/presets[/{id}/activate]
       Tours:            GET /rest/v4/devices/{id}/ptz/tours, POST .../{id}/active
  4. Log out:  DELETE /rest/v4/login/sessions/<token>   (local sessions only)

Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
           https://support.networkoptix.com/hc/en-us/articles/32895719318935
"""

import argparse
import json
import os
import sys
import uuid

import requests


CLIENT_ID = "3rdParty"
RELAY_SUFFIX = ".relay.vmsproxy.com"
API = "/rest/v4"
MAX_REDIRECTS = 5

PTZ_OPERATIONS = (
    "move", "stop", "abs_move",
    "get_presets", "set_preset", "go_preset",
    "get_tours", "activate_tour", "stop_tour",
)

# Bitmask definitions for the legacy (v3) ptzCapabilities field. v4 servers
# report the same capabilities as a pipe-separated string instead, so no
# mapping is needed for v4.
PTZ_CAPABILITY_BITS = {
    "ContinuousPanCapability": 1,
    "ContinuousTiltCapability": 2,
    "ContinuousZoomCapability": 4,
    "ContinuousFocusCapability": 8,
    "AbsolutePanCapability": 16,
    "AbsoluteTiltCapability": 32,
    "AbsoluteZoomCapability": 64,
    "ViewportPtzCapability": 128,
    "FlipPtzCapability": 256,
    "LimitsPtzCapability": 512,
    "RelativePanCapability": 1024,
    "RelativeTiltCapability": 2048,
    "DevicePositioningPtzCapability": 4096,
    "LogicalPositioningPtzCapability": 8192,
    "RelativeZoomCapability": 16384,
    "RelativeRotationCapability": 32768,
    "PresetsPtzCapability": 65536,
    "ToursPtzCapability": 131072,
    "ActivityPtzCapability": 262144,
    "HomePtzCapability": 524288,
    "AsynchronousPtzCapability": 1048576,
    "SynchronizedPtzCapability": 2097152,
    "VirtualPtzCapability": 4194304,
    "RelativeFocusCapability": 8388608,
    "AuxiliaryPtzCapability": 16777216,
    "NativePresetsPtzCapability": 134217728,
    "ContinuousRotationCapability": 536870912,
    "AbsoluteRotationCapability": 1073741824,
}


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
        "host": pick(cli_args.host, "NX_SERVER_HOST"),
        "user": pick(cli_args.user, "NX_SERVER_USER"),
        "password": pick(cli_args.password, "NX_SERVER_PASSWORD"),
        "cloud_host": pick(cli_args.cloud_host, "NX_CLOUD_HOST"),
        "site_id": pick(cli_args.site_id, "NX_CLOUD_SITE_ID"),
        "device_id": pick(cli_args.device_id, "NX_DEVICE_ID"),
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when the server/cloud rejects the credentials or token."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


# ---------------------------------------------------------------------------
# Pure helpers (easy to test)
# ---------------------------------------------------------------------------

def parse_ptz_capabilities(camera_info):
    """Return the set of PTZ capability names a camera reports.

    v4 servers expose a pipe-separated string under ptz.capabilities
    (e.g. "ContinuousPanCapability|AbsoluteTiltCapability"). Older v3
    servers expose an integer bitmask under parameters.ptzCapabilities,
    which is decoded against PTZ_CAPABILITY_BITS for compatibility.
    """
    if not isinstance(camera_info, dict):
        return set()

    ptz = camera_info.get("ptz")
    if isinstance(ptz, dict) and "capabilities" in ptz:
        caps = ptz.get("capabilities") or ""
        return {cap for cap in caps.split("|") if cap}

    value = camera_info.get("parameters", {}).get("ptzCapabilities")
    if isinstance(value, int):
        return {name for name, bit in PTZ_CAPABILITY_BITS.items() if value & bit}

    return set()


def build_ptz_request_body(operation, pan=0.0, tilt=0.0, zoom=0.0, speed=0.5,
                           preset_name=None):
    """Build the JSON body for a given PTZ operation."""
    if operation == "move":
        return {"api": "operational", "pan": pan, "tilt": tilt, "zoom": zoom,
                "speed": speed}
    if operation == "abs_move":
        return {"type": "absolute", "api": "operational", "pan": pan,
                "tilt": tilt, "zoom": zoom, "speed": speed}
    if operation == "set_preset":
        return {"id": str(uuid.uuid4()),
                "name": preset_name or f"Preset_{pan}_{tilt}_{zoom}"}
    if operation == "go_preset":
        return {"speed": speed}
    return {}


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class NxPtzClient:
    """Logs in to a site (local or cloud-relayed) and issues PTZ commands."""

    def __init__(self, host, verify_tls=True, session=None, timeout=15):
        self.host = (host or "").rstrip("/")
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.verify = verify_tls
        self.token = None
        self._local_session = False
        if not verify_tls:
            # --insecure is expected for local servers with self-signed certs;
            # don't spam the console with a warning for every request.
            requests.packages.urllib3.disable_warnings(
                requests.packages.urllib3.exceptions.InsecureRequestWarning)

    def login_local(self, user, password):
        """POST local credentials, receive a bearer token, remember it."""
        url = f"{self.host}{API}/login/sessions"
        body = {"username": user, "password": password, "setCookie": False}
        try:
            response = self.session.post(url, json=body, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        if response.status_code in (401, 403):
            raise AuthError(f"Login unauthorized (HTTP {response.status_code}). "
                            "Check the username/password.")
        if not response.ok:
            raise ApiError(f"Login failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")
        try:
            self.token = response.json().get("token")
        except ValueError as exc:
            raise ApiError("Login response was not valid JSON.") from exc
        if not self.token:
            raise ApiError("Login response did not contain a token.")
        self._local_session = True
        return self.token

    def login_cloud(self, cloud_host, user, password, site_id):
        """POST cloud credentials scoped to one site; receive a bearer token."""
        url = f"{cloud_host.rstrip('/')}/cdb/oauth2/token"
        body = {
            "grant_type": "password",
            "response_type": "token",
            "client_id": CLIENT_ID,
            "username": user,
            "password": password,
            "scope": f"cloudSystemId={site_id}",
        }
        try:
            response = self.session.post(url, json=body, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        if response.status_code in (401, 403):
            raise AuthError(f"Cloud login unauthorized (HTTP {response.status_code}). "
                            "Check the account credentials and site id.")
        if not response.ok:
            raise ApiError(f"Cloud login failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")
        try:
            self.token = response.json().get("access_token")
        except ValueError as exc:
            raise ApiError("Cloud token response was not valid JSON.") from exc
        if not self.token:
            raise ApiError("Cloud token response did not contain an access_token.")
        self._local_session = False
        return self.token

    def _auth_header(self):
        if not self.token:
            raise ApiError("Not logged in. Call login_local() or login_cloud() first.")
        return {"Authorization": f"Bearer {self.token}"}

    def _request(self, method, path, what, json_body=None):
        """Issue a request, following redirects MANUALLY and re-attaching the
        bearer header on every hop.

        The Cloud relay answers with an HTTP 307 pointing at the node that
        actually serves the request. The `requests` library strips the
        Authorization header on a cross-host redirect, so it can't be allowed
        to follow it automatically; we resend the header (and body, since a
        307/308 must repeat the original request) ourselves.
        """
        url = f"{self.host}{path}"
        headers = self._auth_header()
        for _ in range(MAX_REDIRECTS + 1):
            try:
                response = self.session.request(
                    method, url, headers=headers, json=json_body,
                    timeout=self.timeout, allow_redirects=False)
            except requests.exceptions.RequestException as exc:
                raise ApiError(f"Could not reach {url}: {exc}") from exc
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("Location")
                if not location:
                    raise ApiError(f"Redirect {response.status_code} without a "
                                   "Location header.")
                url = location
                continue
            break
        else:
            raise ApiError("Too many redirects.")

        if response.status_code in (401, 403):
            raise AuthError(f"{what} unauthorized (HTTP {response.status_code}).")
        if not response.ok:
            raise ApiError(f"{what} failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError:
            return {}

    def get_camera(self, device_id):
        """GET camera metadata, including PTZ capabilities."""
        return self._request("GET", f"{API}/devices/{device_id}", "Reading camera info")

    def ptz_move_start(self, device_id, body):
        """Start a continuous PTZ move."""
        self._request("POST", f"{API}/devices/{device_id}/ptz/move",
                      "Starting PTZ move", body)

    def ptz_move_stop(self, device_id):
        """Stop a continuous PTZ move."""
        self._request("DELETE", f"{API}/devices/{device_id}/ptz/move",
                      "Stopping PTZ move", {"api": "operational"})

    def ptz_move_absolute(self, device_id, body):
        """Perform an absolute PTZ move."""
        self._request("POST", f"{API}/devices/{device_id}/ptz/position",
                      "Moving PTZ to position", body)

    def ptz_get_presets(self, device_id):
        """List PTZ presets."""
        return self._request("GET", f"{API}/devices/{device_id}/ptz/presets",
                             "Reading PTZ presets")

    def ptz_set_preset(self, device_id, body):
        """Save a new PTZ preset."""
        self._request("POST", f"{API}/devices/{device_id}/ptz/presets",
                      "Creating PTZ preset", body)

    def ptz_goto_preset(self, device_id, preset_id, body):
        """Move to a saved PTZ preset."""
        self._request("POST",
                      f"{API}/devices/{device_id}/ptz/presets/{preset_id}/activate",
                      "Activating PTZ preset", body)

    def ptz_get_tours(self, device_id):
        """List PTZ tours."""
        return self._request("GET", f"{API}/devices/{device_id}/ptz/tours",
                             "Reading PTZ tours")

    def ptz_activate_tour(self, device_id, tour_id):
        """Activate a PTZ tour."""
        self._request("POST", f"{API}/devices/{device_id}/ptz/tours/{tour_id}/active",
                      "Activating PTZ tour")

    def ptz_stop_tour(self, device_id, body):
        """Stop a running tour by interrupting it with a move command."""
        self.ptz_move_start(device_id, body)

    def logout(self):
        """DELETE the local session so the token cannot be reused. Best-effort."""
        if not self.token or not self._local_session:
            self.token = None
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
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Drive a PTZ camera on one Nx VMS site.")
    parser.add_argument("--host", default=None,
                        help="Server URL, e.g. https://192.168.1.10:7001")
    parser.add_argument("--user", default=None, help="Local server username")
    parser.add_argument("--password", default=None, help="Local server password")
    parser.add_argument("--cloud-host", default=None,
                        help="Cloud host, e.g. https://nxvms.com (use with --site-id "
                             "instead of --host for cloud-relayed access)")
    parser.add_argument("--site-id", default=None,
                        help="Cloud Site ID of the target site (UUID)")
    parser.add_argument("--device-id", default=None, help="Camera/device id")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (usually needed for local servers)")

    parser.add_argument("--ptz", required=True, choices=PTZ_OPERATIONS,
                        help="PTZ operation to run")
    parser.add_argument("--pan", type=float, default=0.0, help="Pan value (-1.0 to 1.0)")
    parser.add_argument("--tilt", type=float, default=0.0, help="Tilt value (-1.0 to 1.0)")
    parser.add_argument("--zoom", type=float, default=0.0, help="Zoom value (-1.0 to 1.0)")
    parser.add_argument("--speed", type=float, default=0.5, help="Speed (0.0 to 1.0)")
    parser.add_argument("--preset-id", default=None, help="Preset id (for go_preset)")
    parser.add_argument("--preset-name", default=None,
                        help="Preset name (for set_preset, optional)")
    parser.add_argument("--tour-id", default=None, help="Tour id (for activate_tour)")
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    config = resolve_config(args, load_env_file(args.env_file))

    using_cloud = bool(config["cloud_host"] and config["site_id"])
    if not using_cloud and not config["host"]:
        print("Missing config: provide --host (local) or --cloud-host/--site-id "
              "(cloud). See the README.", file=sys.stderr)
        return 2
    if not config["device_id"]:
        print("Missing config: --device-id (or NX_DEVICE_ID). See the README.",
              file=sys.stderr)
        return 2
    if not config["user"] or not config["password"]:
        print("Missing config: --user/--password. See the README.", file=sys.stderr)
        return 2

    host = f"https://{config['site_id']}{RELAY_SUFFIX}" if using_cloud else config["host"]
    client = NxPtzClient(host=host, verify_tls=not args.insecure)

    try:
        if using_cloud:
            client.login_cloud(config["cloud_host"], config["user"],
                               config["password"], config["site_id"])
        else:
            client.login_local(config["user"], config["password"])

        device_id = config["device_id"]
        camera_info = client.get_camera(device_id)
        capabilities = parse_ptz_capabilities(camera_info)
        print(f"Camera: {camera_info.get('name', device_id)}\n"
              f"PTZ capabilities: {', '.join(sorted(capabilities)) or 'none reported'}\n")

        body = build_ptz_request_body(
            args.ptz, pan=args.pan, tilt=args.tilt, zoom=args.zoom,
            speed=args.speed, preset_name=args.preset_name)

        print(f"Executing PTZ command: {args.ptz}...")
        if args.ptz == "move":
            client.ptz_move_start(device_id, body)
        elif args.ptz == "stop":
            client.ptz_move_stop(device_id)
        elif args.ptz == "abs_move":
            client.ptz_move_absolute(device_id, body)
        elif args.ptz == "get_presets":
            print(json.dumps(client.ptz_get_presets(device_id), indent=2))
        elif args.ptz == "set_preset":
            client.ptz_set_preset(device_id, body)
        elif args.ptz == "go_preset":
            if not args.preset_id:
                print("--preset-id is required for go_preset.", file=sys.stderr)
                return 2
            client.ptz_goto_preset(device_id, args.preset_id, body)
        elif args.ptz == "get_tours":
            print(json.dumps(client.ptz_get_tours(device_id), indent=2))
        elif args.ptz == "activate_tour":
            if not args.tour_id:
                print("--tour-id is required for activate_tour.", file=sys.stderr)
                return 2
            client.ptz_activate_tour(device_id, args.tour_id)
        elif args.ptz == "stop_tour":
            client.ptz_stop_tour(device_id, body)

        print("Done.")
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
