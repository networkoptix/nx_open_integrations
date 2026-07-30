#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Set the SCHEDULE of an Nx event rule -- the v4 modernization of Network Optix's
`python/examples/setup_rule_schedule.py`.

The original example used the legacy `/ec2/getEventRules` + `/ec2/saveEventRule`
transactional API, where a rule's schedule was a packed HEX BITSTREAM that had to
be serialized/deserialized by hand (1-hour resolution). The latest `/rest/v4` API
replaces all of that:

  - List rules:    GET   /rest/v4/events/rules            -> [ Rule, ... ]
  - Modify a rule: PATCH /rest/v4/events/rules/{id}       (partial body)

  The schedule is now a STRUCTURED ARRAY (no bit-twiddling):
    schedule: [ { dayOfWeek, startTime, endTime }, ... ]
      dayOfWeek : 1=Mon .. 7=Sun
      startTime : seconds since 00:00 (0..endTime)
      endTime   : seconds since 00:00 (startTime..86400)
    An EMPTY array means "always enabled".

Python sample on the latest /rest/v4 API. Uses `requests`.

TWO things it can do (pick one):
  --list                 List every rule (id, enabled, comment, schedule).
  --rule-id <id> --preset <always|weekdays|weekend|24x7> [--start H --end H]
                         PATCH ONE rule's schedule to a preset.

BOTH auth modes (same as the other rest- samples):
  --mode direct  Local login to one server (NX_SERVER_*).
  --mode cloud   Cloud account over the relay (NX_CLOUD_* + Site ID; token
                 scoped with cloudSystemId; relay 307 followed manually with the
                 bearer re-attached -- and PATCH keeps its method + body across
                 the 307).

Important: in cloud mode the relay answers with an HTTP 307 redirect to the node
that actually serves the request. The `requests` library DROPS the Authorization
header on a cross-host redirect, so we follow the 307 MANUALLY and re-attach the
bearer header, preserving the method and body (a 307 keeps both -- this matters
for the PATCH). See _request_following_redirects().

Reference (legacy): https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/setup_rule_schedule.py
v4 API: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
"""

import argparse
import os
import sys

import requests


CLIENT_ID = "3rdParty"
RELAY_SUFFIX = ".relay.vmsproxy.com"
# API version path segment. v4 is the latest Nx REST API.
API = "/rest/v4"
RULES_PATH = f"{API}/events/rules"

# The two auth modes this sample supports (same names as the other samples).
MODE_DIRECT = "direct"
MODE_CLOUD = "cloud"

SECONDS_PER_HOUR = 3600
SECONDS_PER_DAY = 86400
# Most redirects we will follow when chasing the relay 307.
MAX_REDIRECTS = 5

# Schedule presets the CLI offers.
PRESETS = ["always", "weekdays", "weekend", "24x7"]

# dayOfWeek: 1=Mon .. 7=Sun.
DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
WEEKDAYS = [1, 2, 3, 4, 5]
WEEKEND = [6, 7]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when login or the bearer token is rejected."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


# ---------------------------------------------------------------------------
# Schedule helpers (pure functions -- the heart of the sample)
# ---------------------------------------------------------------------------

def build_schedule(preset, start_hour=9, end_hour=18):
    """Build a v4 schedule array from a preset.

      always  -> []                      (always enabled)
      24x7    -> all 7 days, full day
      weekdays-> Mon-Fri, start_hour..end_hour
      weekend -> Sat-Sun, start_hour..end_hour
    start_hour/end_hour are whole hours in [0..24], start_hour < end_hour. They
    are ignored for "always" and "24x7".
    """
    if preset == "always":
        return []
    if preset == "24x7":
        return [{"dayOfWeek": d, "startTime": 0, "endTime": SECONDS_PER_DAY}
                for d in [1, 2, 3, 4, 5, 6, 7]]
    if (not _is_int(start_hour) or not _is_int(end_hour)
            or start_hour < 0 or end_hour > 24 or start_hour >= end_hour):
        raise ApiError(
            f"Invalid hours: --start {start_hour} --end {end_hour} "
            "(need 0 <= start < end <= 24).")
    days = WEEKDAYS if preset == "weekdays" else WEEKEND
    return [{"dayOfWeek": d,
             "startTime": start_hour * SECONDS_PER_HOUR,
             "endTime": end_hour * SECONDS_PER_HOUR}
            for d in days]


def _is_int(value):
    """True for whole-number values (rejects floats like 9.5 and non-numbers)."""
    return isinstance(value, int) and not isinstance(value, bool)


def _normalize(schedule):
    """Sort tasks by (dayOfWeek, startTime) and strip extra keys, so comparison
    ignores ordering and unrelated fields.
    """
    tasks = [{"dayOfWeek": t.get("dayOfWeek"),
              "startTime": t.get("startTime"),
              "endTime": t.get("endTime")}
             for t in (schedule or [])]
    return sorted(tasks, key=lambda t: (t["dayOfWeek"], t["startTime"]))


def _hhmm(seconds):
    hours = seconds // SECONDS_PER_HOUR
    minutes = (seconds % SECONDS_PER_HOUR) // 60
    return f"{hours:02d}:{minutes:02d}"


def summarize_schedule(schedule):
    """Human summary of a schedule for the --list table."""
    tasks = schedule or []
    if not tasks:
        return "always"
    parts = []
    for t in _normalize(tasks):
        day = t["dayOfWeek"]
        name = DAY_NAMES[day] if 0 <= day < len(DAY_NAMES) and DAY_NAMES[day] else day
        parts.append(f"{name} {_hhmm(t['startTime'])}-{_hhmm(t['endTime'])}")
    return ", ".join(parts)


def normalize_preset(value):
    """Validate the requested preset string."""
    text = ("" if value is None else str(value)).strip().lower()
    if text in PRESETS:
        return text
    raise ApiError(
        f'Unknown --preset "{value}". Choose one of: {", ".join(PRESETS)}.')


# ---------------------------------------------------------------------------
# Configuration (CLI > env > .env)
# ---------------------------------------------------------------------------

def load_env_file(path=".env"):
    """Read a simple KEY=VALUE .env file into a dict. Missing file -> {}."""
    values = {}
    if not path or not os.path.exists(path):
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
    """CLI flag > OS environment variable > .env file (mode-aware)."""

    def pick(cli_value, env_key):
        if cli_value is not None:
            return cli_value
        if os.environ.get(env_key):
            return os.environ[env_key]
        return env_file_values.get(env_key)

    raw_mode = (cli_args.mode if cli_args.mode is not None
                else os.environ.get("NX_MODE") or env_file_values.get("NX_MODE"))
    mode = MODE_CLOUD if raw_mode == MODE_CLOUD else MODE_DIRECT

    return {
        "mode": mode,
        "server_host": pick(cli_args.server_host, "NX_SERVER_HOST"),
        "cloud_host": pick(cli_args.cloud_host, "NX_CLOUD_HOST") or "https://nxvms.com",
        "user": pick(cli_args.user,
                     "NX_CLOUD_USER" if mode == MODE_CLOUD else "NX_SERVER_USER"),
        "password": pick(cli_args.password,
                         "NX_CLOUD_PASSWORD" if mode == MODE_CLOUD else "NX_SERVER_PASSWORD"),
        "site_id": pick(cli_args.site_id, "NX_CLOUD_SITE_ID"),
        "mfa_code": cli_args.mfa_code,
    }


def missing_fields(config):
    """Which required auth fields are missing for the chosen mode."""
    required = (("cloud_host", "user", "password", "site_id")
                if config["mode"] == MODE_CLOUD
                else ("server_host", "user", "password"))
    return [name for name in required if not config[name]]


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class NxRuleClient:
    """Logs in (direct OR cloud) and lists / patches event-rule schedules."""

    def __init__(self, mode, user, password, server_host="",
                 cloud_host="https://nxvms.com", site_id="", mfa_code=None,
                 verify_tls=True, session=None, timeout=15):
        self.mode = mode
        self.user = user
        self.password = password
        self.server_host = (server_host or "").rstrip("/")
        self.cloud_host = (cloud_host or "").rstrip("/")
        self.site_id = site_id
        self.mfa_code = mfa_code
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.verify = verify_tls
        self.token = None

    @property
    def relay_url(self):
        """The Cloud relay address for this site (cloud mode)."""
        return f"https://{self.site_id}{RELAY_SUFFIX}"

    @property
    def api_base(self):
        """Where rule requests go: the server directly, or the site relay."""
        return self.relay_url if self.mode == MODE_CLOUD else self.server_host

    def _auth_header(self):
        if not self.token:
            raise ApiError("Not logged in. Call login() first.")
        return {"Authorization": f"Bearer {self.token}"}

    # -----------------------------------------------------------------------
    # login(): two flows, one method.
    # -----------------------------------------------------------------------

    def login(self):
        return self._login_cloud() if self.mode == MODE_CLOUD else self._login_direct()

    def _login_direct(self):
        """Direct: POST {server}/rest/v4/login/sessions -> { token }."""
        url = f"{self.server_host}{API}/login/sessions"
        body = {"username": self.user, "password": self.password, "setCookie": False}
        try:
            response = self.session.post(url, json=body, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        if response.status_code in (401, 403):
            raise AuthError(
                f"Login rejected (HTTP {response.status_code}). Check the "
                "username/password, and that it is a LOCAL server account "
                "(cloud users use --mode cloud).")
        if not response.ok:
            raise ApiError(f"Login failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError("Login response was not valid JSON.") from exc
        self.token = data.get("token")
        if not self.token:
            raise ApiError("Login response did not contain a token.")
        return self.token

    def _login_cloud(self):
        """Cloud: POST {cloud}/cdb/oauth2/token with cloudSystemId scope."""
        url = f"{self.cloud_host}/cdb/oauth2/token"
        body = {
            "grant_type": "password",
            "response_type": "token",
            "client_id": CLIENT_ID,
            "username": self.user,
            "password": self.password,
            # THIS scope is what makes the token usable against the site relay.
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
                f"Login rejected (HTTP {response.status_code}). Check the cloud "
                "email/password, the site id, and that the account has access to "
                "that site. Add --mfa-code for 2FA.")
        if not response.ok:
            raise ApiError(f"Token request failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError("Token response was not valid JSON.") from exc
        self.token = data.get("access_token")
        if not self.token:
            raise ApiError("Token response did not contain an access_token.")
        return self.token

    # -----------------------------------------------------------------------
    # _request_following_redirects(): follow the relay 307 MANUALLY.
    # -----------------------------------------------------------------------

    def _request_following_redirects(self, method, url, json_body=None):
        """Issue a request, following the relay's 307 MANUALLY and re-attaching
        the bearer (and preserving method + body -- a 307 keeps both) on each hop.

        Auto-follow can drop the Authorization header across hosts, so we use
        allow_redirects=False and resolve Location ourselves, re-sending the same
        method and body on every hop. Works for the direct server too (it just
        won't redirect). One helper serves both GET and PATCH.
        """
        from urllib.parse import urljoin
        headers = dict(self._auth_header())
        if json_body is not None:
            headers["Content-Type"] = "application/json"
        current = url
        for _hop in range(MAX_REDIRECTS + 1):
            try:
                response = self.session.request(
                    method, current, headers=headers, json=json_body,
                    timeout=self.timeout, allow_redirects=False)
            except requests.exceptions.RequestException as exc:
                raise ApiError(f"Could not reach {current}: {exc}") from exc
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("Location")
                if not location:
                    return response
                current = urljoin(current, location)
                continue  # re-issue with the SAME method/body/headers
            return response
        raise ApiError(
            f"Too many redirects (>{MAX_REDIRECTS}) chasing the relay.")

    def _check_auth_ok(self, response, what):
        if response.status_code in (401, 403):
            raise AuthError(
                f"{what} unauthorized (HTTP {response.status_code}). In cloud "
                "mode make sure the token was scoped with cloudSystemId for "
                "THIS site.")
        if not response.ok:
            raise ApiError(f"{what} failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")

    def list_rules(self):
        """GET every event rule."""
        url = f"{self.api_base}{RULES_PATH}"
        response = self._request_following_redirects("GET", url)
        self._check_auth_ok(response, "Listing rules")
        try:
            data = response.json()
        except ValueError as exc:
            raise ApiError("Rules response was not valid JSON.") from exc
        if isinstance(data, dict) and isinstance(data.get("reply"), list):
            return data["reply"]
        return data if isinstance(data, list) else []

    def patch_schedule(self, rule_id, schedule):
        """PATCH one rule's schedule. Returns the modified rule (if echoed)."""
        if not rule_id:
            raise ApiError("A rule id is required to PATCH a schedule.")
        from urllib.parse import quote
        url = f"{self.api_base}{RULES_PATH}/{quote(str(rule_id), safe='')}"
        response = self._request_following_redirects(
            "PATCH", url, json_body={"schedule": schedule})
        self._check_auth_ok(response, "Patching rule")
        try:
            return response.json()
        except ValueError:
            # Some servers answer 200 with an empty body; treat as success.
            return {"id": rule_id, "schedule": schedule}

    def logout(self):
        """Revoke the token. Best-effort cleanup."""
        if not self.token:
            return
        url = (f"{self.cloud_host}/cdb/oauth2/token/{self.token}"
               if self.mode == MODE_CLOUD
               else f"{self.server_host}{API}/login/sessions/{self.token}")
        try:
            self.session.delete(url, headers=self._auth_header(),
                                timeout=self.timeout)
        except requests.exceptions.RequestException:
            pass  # best effort
        finally:
            self.token = None


# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------

def format_rules_table(rules):
    if not rules:
        return "No event rules found on this site."
    rows = [("ID", "ENABLED", "COMMENT", "SCHEDULE")]
    for r in rules:
        rows.append((
            str(r.get("id", "")),
            "no" if r.get("enabled") is False else "yes",
            str(r.get("comment", "")),
            summarize_schedule(r.get("schedule")),
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
        description="Set the schedule of an Nx event rule (v4).")
    parser.add_argument("--mode", default=None, choices=(MODE_DIRECT, MODE_CLOUD),
                        help="Auth mode (default direct)")
    parser.add_argument("--server-host", default=None,
                        help="VMS server base URL (direct mode), "
                             "e.g. https://192.168.1.10:7001")
    parser.add_argument("--cloud-host", default=None,
                        help="Cloud host (cloud mode; default https://nxvms.com)")
    parser.add_argument("--user", default=None,
                        help="Local server account (direct) or cloud email (cloud)")
    parser.add_argument("--password", default=None, help="Account password")
    parser.add_argument("--site-id", default=None,
                        help="Cloud Site ID of the target site (cloud mode)")
    parser.add_argument("--mfa-code", default=None,
                        help="One-time 2FA code (cloud mode)")
    parser.add_argument("--list", action="store_true",
                        help="List every rule (id, enabled, comment, schedule)")
    parser.add_argument("--rule-id", default=None,
                        help="Rule id to PATCH (use with --preset)")
    parser.add_argument("--preset", default=None,
                        help=f"Schedule preset: {', '.join(PRESETS)}")
    parser.add_argument("--start", default=None,
                        help="Start hour 0..24 for weekdays/weekend (default 9)")
    parser.add_argument("--end", default=None,
                        help="End hour 0..24 for weekdays/weekend (default 18)")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (usually needed for local servers)")
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)

    # Exactly one action must be chosen.
    actions = sum(bool(x) for x in (args.list, args.rule_id))
    if actions != 1:
        print("Choose exactly one action: --list, or "
              "--rule-id <id> --preset <preset>.", file=sys.stderr)
        return 2

    config = resolve_config(args, load_env_file(args.env_file))
    missing = missing_fields(config)
    if missing:
        print("Missing config: " + ", ".join(missing) +
              ".\nProvide via flags or .env (copy .env.example). See the README.",
              file=sys.stderr)
        return 2

    # Validate the set-by-id action up front (before any network call).
    preset = None
    start_hour = 9
    end_hour = 18
    if args.rule_id:
        try:
            preset = normalize_preset(args.preset)
            if args.start is not None:
                start_hour = _parse_hour(args.start, "--start")
            if args.end is not None:
                end_hour = _parse_hour(args.end, "--end")
            # build_schedule validates the hour range; call it once to surface errors.
            build_schedule(preset, start_hour, end_hour)
        except ApiError as exc:
            print(f"{exc}", file=sys.stderr)
            return 2

    client = NxRuleClient(
        config["mode"], config["user"], config["password"],
        server_host=config["server_host"], cloud_host=config["cloud_host"],
        site_id=config["site_id"], mfa_code=config["mfa_code"],
        verify_tls=not args.insecure,
    )

    try:
        client.login()

        if args.list:
            print(format_rules_table(client.list_rules()))
            return 0

        # Set one rule by id.
        schedule = build_schedule(preset, start_hour, end_hour)
        updated = client.patch_schedule(args.rule_id, schedule)
        print(f"Set rule {args.rule_id} schedule -> "
              f"{summarize_schedule(updated.get('schedule') or schedule)}")
        return 0
    except AuthError as exc:
        print(f"Login failed: {exc}", file=sys.stderr)
        return 1
    except ApiError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    finally:
        client.logout()


def _parse_hour(value, flag):
    """Parse an hour flag into an int, rejecting non-integers (e.g. 9.5)."""
    try:
        text = str(value).strip()
        if text != str(int(text)):
            raise ValueError
        return int(text)
    except (TypeError, ValueError):
        raise ApiError(
            f"{flag} must be a whole hour 0..24 (got \"{value}\").") from None


if __name__ == "__main__":
    sys.exit(main())
