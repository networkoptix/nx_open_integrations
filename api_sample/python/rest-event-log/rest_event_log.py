#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx VMS REST API sample: read a site's event log via the Cloud relay.

This reads the event history of ONE site using a CLOUD account, exactly the
way the cloud routes API calls to a server:

  1. Get a token from the cloud, SCOPED to the target site:
        POST {cloud}/cdb/oauth2/token
        { grant_type:"password", response_type:"token", client_id:"3rdParty",
          username, password, scope:"cloudSystemId=<site id>" }
     (or pass an existing scoped token with --token)
  2. Reach the site through the Cloud relay:
        https://<site id>.relay.vmsproxy.com
  3. Read the event log (the v4 endpoint):
        GET /rest/v4/events/log?startTimeMs=<ms>&durationMs=<ms>[&eventType=...]
        Header: Authorization: Bearer <token>

Important: the relay answers with an HTTP 307 redirect to the node that actually
serves the request. The `requests` library DROPS the Authorization header on a
cross-host redirect, so we follow the 307 MANUALLY and re-attach the bearer
header. See _get_following_redirects().

Contract (from the v4 OpenAPI spec):
  - Time window is startTimeMs + durationMs (milliseconds), NOT from/to.
  - eventType and actionType are LISTS (repeatable query params).
  - Each response record is:
      { timestampMs, eventData{}, actionData{}, aggregatedInfo{}, ruleId, flags }
    where eventData / actionData are maps keyed by manifest field names
    (e.g. eventData["eventType"], eventData["caption"]).

Reference: /rest/v4/events/log in the Nx v4 REST API spec.
"""

import argparse
import datetime as dt
import os
import re
import sys
import time

import requests


CLIENT_ID = "3rdParty"
RELAY_SUFFIX = ".relay.vmsproxy.com"
EVENTS_PATH = "/rest/v4/events/log"
MANIFEST_PATH = "/rest/v4/events/manifest/events"
MAX_REDIRECTS = 5


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
        "token": cli_args.token,
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when login or the scoped token is rejected."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


# ---------------------------------------------------------------------------
# Parsing helpers (pure functions = easy to test)
# ---------------------------------------------------------------------------

def _ms_to_iso(ms):
    """Convert an epoch-millisecond timestamp to a readable UTC string."""
    try:
        return dt.datetime.fromtimestamp(int(ms) / 1000, dt.timezone.utc) \
            .strftime("%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return str(ms)


# --- time window ----------------------------------------------------------
# The window is given in human terms and converted to the API's startTimeMs +
# durationMs (milliseconds). Two ways to express it:
#   * --since <duration>   e.g. 30m, 24h, 7d, 2w  -> window = [now - dur, now]
#   * --start / --end       absolute bounds (ISO 8601 or epoch)

_DURATION_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$", re.IGNORECASE)
_UNIT_MS = {"s": 1000, "m": 60_000, "h": 3_600_000,
            "d": 86_400_000, "w": 604_800_000}


def parse_duration(text):
    """Parse a duration like '30m', '24h', '7d', '2w' into milliseconds.

    A unit suffix is required (s/m/h/d/w) so a bare number can't be misread.
    """
    match = _DURATION_RE.match(text or "")
    if not match:
        raise ValueError(
            f"Invalid duration {text!r}. Use a number + unit "
            "(s, m, h, d, w), e.g. 30m, 24h, 7d, 2w.")
    value, unit = float(match.group(1)), match.group(2).lower()
    return int(value * _UNIT_MS[unit])


def parse_time(text):
    """Parse an absolute time into epoch milliseconds.

    Accepts epoch milliseconds, epoch seconds, or ISO 8601
    (e.g. '2026-06-10' or '2026-06-10T14:30:00Z'). Naive times are treated as UTC.
    """
    text = (text or "").strip()
    if text.isdigit():
        number = int(text)
        return number if len(text) >= 13 else number * 1000   # 13+ digits = ms
    try:
        when = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(
            f"Invalid time {text!r}. Use ISO 8601 "
            "(e.g. 2026-06-10T14:00:00Z) or an epoch timestamp.") from exc
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.timezone.utc)
    return int(when.timestamp() * 1000)


def resolve_window(now_ms, since="24h", start=None, end=None):
    """Return (start_ms, duration_ms) from --since OR --start/--end.

    If --start is given it wins (with --end defaulting to now); otherwise the
    window is the last <since> ending now. Both forms feed the API's
    startTimeMs + durationMs.
    """
    if start:
        start_ms = parse_time(start)
        end_ms = parse_time(end) if end else now_ms
        if end_ms < start_ms:
            raise ValueError("--end is before --start.")
        return start_ms, end_ms - start_ms
    duration_ms = parse_duration(since)
    return now_ms - duration_ms, duration_ms


def _first(d, *keys):
    """Return the first present, non-empty value among keys in dict d."""
    if isinstance(d, dict):
        for k in keys:
            v = d.get(k)
            if v:
                return v
    return ""


def normalize_event(record):
    """Flatten one v4 event-log record into a simple dict for display.

    A record is { timestampMs, eventData{}, actionData{}, ruleId, flags }.
    eventData / actionData are maps keyed by manifest field names, so we look
    up the common keys defensively.
    """
    event_data = record.get("eventData", {}) if isinstance(record, dict) else {}
    action_data = record.get("actionData", {}) if isinstance(record, dict) else {}
    return {
        "time": _ms_to_iso(record.get("timestampMs")),
        "event_type": _first(event_data, "eventType", "type"),
        "resource": _first(event_data, "caption", "resourceName",
                           "eventResourceId", "source"),
        "action_type": _first(action_data, "actionType", "type"),
    }


def format_events_table(events):
    """Build a plain-text table of normalized events."""
    if not events:
        return "No events in this time range."
    rows = [("TIME (UTC)", "EVENT", "ACTION", "RESOURCE")]
    for ev in events:
        rows.append((
            str(ev.get("time", "")),
            str(ev.get("event_type", "")),
            str(ev.get("action_type", "")),
            str(ev.get("resource", "")),
        ))
    widths = [max(len(row[col]) for row in rows) for col in range(len(rows[0]))]
    return "\n".join(
        "  ".join(cell.ljust(widths[col]) for col, cell in enumerate(row))
        for row in rows
    )


def parse_event_manifest(data):
    """Flatten the v4 event-type manifest into an {id: displayName} dict.

    The endpoint returns a JSON OBJECT MAP keyed by event-type id; each value
    has at least `id` and `displayName`. We read defensively: if a value lacks
    `id`, fall back to the map key; if it lacks `displayName`, leave it blank.
    """
    out = {}
    if not isinstance(data, dict):
        return out
    for key, value in data.items():
        if isinstance(value, dict):
            type_id = value.get("id") or key
            display = value.get("displayName", "")
        else:
            type_id, display = key, ""
        out[type_id] = display
    return out


def format_manifest_table(manifest):
    """Build a plain-text two-column table of event types, sorted by id."""
    if not manifest:
        return "No event types reported by this site."
    rows = [("ID", "DISPLAY NAME")]
    for type_id in sorted(manifest):
        rows.append((str(type_id), str(manifest[type_id])))
    widths = [max(len(row[col]) for row in rows) for col in range(len(rows[0]))]
    return "\n".join(
        "  ".join(cell.ljust(widths[col]) for col, cell in enumerate(row))
        for row in rows
    )


def build_event_params(start_ms, duration_ms, event_type=None, action_type=None,
                       order="desc", limit=50):
    """Assemble the v4 query parameters. eventType/actionType are lists."""
    params = {
        "startTimeMs": str(start_ms),
        "durationMs": str(duration_ms),
        "order": order,
        "limit": str(limit),
    }
    # These are array parameters: requests repeats them (?eventType=a&eventType=b).
    if event_type:
        params["eventType"] = event_type if isinstance(event_type, list) else [event_type]
    if action_type:
        params["actionType"] = action_type if isinstance(action_type, list) else [action_type]
    return params


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class NxCloudEventLogClient:
    """Gets a site-scoped cloud token, then reads the event log via the relay."""

    def __init__(self, cloud_host, site_id, verify_tls=True,
                 session=None, timeout=15):
        self.cloud_host = (cloud_host or "").rstrip("/")
        self.site_id = site_id
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.verify = verify_tls
        self.token = None
        self.last_raw = None

    @property
    def relay_url(self):
        return f"https://{self.site_id}{RELAY_SUFFIX}"

    def login(self, user, password, mfa_code=None):
        """Get a token from the cloud SCOPED to this site."""
        url = f"{self.cloud_host}/cdb/oauth2/token"
        body = {
            "grant_type": "password",
            "response_type": "token",
            "client_id": CLIENT_ID,
            "username": user,
            "password": password,
            "scope": f"cloudSystemId={self.site_id}",
        }
        if mfa_code:
            body["mfaCode"] = mfa_code
        try:
            response = self.session.post(url, json=body, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        if response.status_code in (401, 403):
            raise AuthError(
                f"Login rejected (HTTP {response.status_code}). Check credentials, "
                "the site id, and access; add --mfa-code for a 2FA account.")
        if not response.ok:
            raise ApiError(f"Token request failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")
        try:
            self.token = response.json().get("access_token")
        except ValueError as exc:
            raise ApiError("Token response was not valid JSON.") from exc
        if not self.token:
            raise ApiError("Token response did not contain an access_token.")
        return self.token

    def use_token(self, token):
        """Use a scoped bearer token obtained elsewhere."""
        self.token = token

    def _auth_header(self):
        if not self.token:
            raise ApiError("No token. Call login() or use_token() first.")
        return {"Authorization": f"Bearer {self.token}"}

    def _get_following_redirects(self, url, params):
        """GET that follows 307 redirects MANUALLY, re-attaching the bearer.

        The relay replies 307 pointing at the serving node. requests would strip
        the Authorization header across hosts, so we resend it ourselves. Params
        only need to go on the first request; the redirect Location carries them.
        """
        headers = self._auth_header()
        for hop in range(MAX_REDIRECTS + 1):
            try:
                response = self.session.get(
                    url, headers=headers, params=params if hop == 0 else None,
                    timeout=self.timeout, allow_redirects=False)
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
        raise ApiError("Too many redirects from the relay.")

    def get_event_log(self, start_ms, duration_ms, event_type=None,
                      action_type=None, order="desc", limit=50):
        """Read the event log through the relay; returns normalized events."""
        url = f"{self.relay_url}{EVENTS_PATH}"
        params = build_event_params(start_ms, duration_ms, event_type,
                                    action_type, order, limit)
        response = self._get_following_redirects(url, params)

        if response.status_code in (401, 403):
            raise AuthError(
                "The site rejected the token. Make sure it was scoped with "
                "cloudSystemId for THIS site.")
        if not response.ok:
            raise ApiError(f"Reading events failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError("Events response was not valid JSON.") from exc

        self.last_raw = data
        records = data if isinstance(data, list) else []
        return [normalize_event(r) for r in records]

    def get_event_manifest(self):
        """Read the site's event-type manifest; returns {id: displayName}.

        Uses the same relay / 307 / scoped-token plumbing as the event log.
        """
        url = f"{self.relay_url}{MANIFEST_PATH}"
        response = self._get_following_redirects(url, None)

        if response.status_code in (401, 403):
            raise AuthError(
                "The site rejected the token. Make sure it was scoped with "
                "cloudSystemId for THIS site.")
        if not response.ok:
            raise ApiError(f"Reading the manifest failed: HTTP "
                           f"{response.status_code} {response.text[:200]}")
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError("Manifest response was not valid JSON.") from exc

        self.last_raw = data
        return parse_event_manifest(data)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Read one cloud site's event log via the relay.")
    parser.add_argument("--cloud-host", default=None,
                        help="Cloud host, e.g. https://nxvms.com")
    parser.add_argument("--user", default=None, help="Cloud account email")
    parser.add_argument("--password", default=None, help="Cloud account password")
    parser.add_argument("--site-id", default=None,
                        help="Cloud Site ID of the target site (UUID)")
    parser.add_argument("--token", default=None,
                        help="Use this site-scoped bearer token (skip login)")
    parser.add_argument("--mfa-code", default=None, help="One-time 2FA code")
    parser.add_argument("--since", default="24h",
                        help="How far back to read, as a duration: "
                             "30m, 24h (default), 7d, 2w")
    parser.add_argument("--start", default=None,
                        help="Absolute window start (ISO 8601 or epoch). "
                             "Overrides --since.")
    parser.add_argument("--end", default=None,
                        help="Absolute window end (default: now). Use with --start.")
    parser.add_argument("--list-event-types", action="store_true",
                        help="List the event types this site supports, then exit")
    parser.add_argument("--event-type", action="append", default=None,
                        help="Filter by event type (repeatable)")
    parser.add_argument("--action-type", action="append", default=None,
                        help="Filter by action type (repeatable)")
    parser.add_argument("--order", choices=("asc", "desc"), default="desc",
                        help="Sort order (default desc)")
    parser.add_argument("--limit", type=int, default=50, help="Max records (default 50)")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (lab use only)")
    parser.add_argument("--debug", action="store_true",
                        help="Print the raw events JSON response")
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)
    config = resolve_config(args, load_env_file(args.env_file))

    for name in ("cloud_host", "site_id"):
        if not config[name]:
            print(f"Missing config: {name}. See the README.", file=sys.stderr)
            return 2

    client = NxCloudEventLogClient(cloud_host=config["cloud_host"],
                                   site_id=config["site_id"],
                                   verify_tls=not args.insecure)

    now_ms = int(time.time() * 1000)
    if not args.list_event_types:
        try:
            start_ms, duration_ms = resolve_window(
                now_ms, since=args.since, start=args.start, end=args.end)
        except ValueError as exc:
            print(f"Error: {exc}", file=sys.stderr)
            return 2

    try:
        if config["token"]:
            client.use_token(config["token"])
        elif config["user"] and config["password"]:
            client.login(config["user"], config["password"], config["mfa_code"])
        else:
            print("Provide --user/--password to log in, or --token.", file=sys.stderr)
            return 2

        if args.list_event_types:
            manifest = client.get_event_manifest()

            if args.debug:
                import json
                print("--- raw manifest response (truncated) ---", file=sys.stderr)
                print(json.dumps(client.last_raw, indent=2)[:4000], file=sys.stderr)
                print("--- end raw ---", file=sys.stderr)

            print(f"Event types for {config['site_id']}"
                  f"   ({len(manifest)} types)\n")
            print(format_manifest_table(manifest))
            return 0

        events = client.get_event_log(
            start_ms, duration_ms, event_type=args.event_type,
            action_type=args.action_type, order=args.order, limit=args.limit)

        if args.debug:
            import json
            print("--- raw events response (truncated) ---", file=sys.stderr)
            print(json.dumps(client.last_raw, indent=2)[:4000], file=sys.stderr)
            print("--- end raw ---", file=sys.stderr)

        print(f"Events for {config['site_id']}\n"
              f"window: {_ms_to_iso(start_ms)} -> {_ms_to_iso(start_ms + duration_ms)} UTC"
              f"   ({len(events)} events)\n")
        print(format_events_table(events))
        return 0
    except AuthError as exc:
        print(f"Auth failed: {exc}", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
