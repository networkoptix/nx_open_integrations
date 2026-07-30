#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Save a short video CLIP from an Nx camera to a FILE -- the command-line
counterpart of the browser ../../web/media-http-stream sample. A CLI can't
render a <video>, so instead it fetches the media stream and writes it to a
file you can play in VLC / ffplay / a browser.

Python sample on the latest /rest/v4 API. Uses `requests` and streams the body
to disk in chunks, so the clip is never held in memory all at once.

BOTH auth modes, exactly like the browser sample:

  --mode direct  Direct to Media Server: connect to ONE media server by
                 IP:port with a LOCAL server account.
                   NX_SERVER_HOST / NX_SERVER_USER / NX_SERVER_PASSWORD
  --mode cloud   Pull Stream via Cloud Relay: a cloud account reaches the
                 site over the relay (token scoped with cloudSystemId, the
                 relay 307 followed manually with the bearer re-attached).
                   NX_CLOUD_HOST / NX_CLOUD_USER / NX_CLOUD_PASSWORD / NX_CLOUD_SITE_ID

THE MEDIA ENDPOINT (from the v4 spec):

  GET /rest/v4/devices/{id}/media.{format}   (Authorization: Bearer <token>)
    ?positionMs=<ms>     archive start time; OMIT this for LIVE
    &durationMs=<ms>    how much footage to pull (bounds the clip)

  format is one of the containers the v4 spec allows for this endpoint (see
  FORMATS, taken verbatim from docs/v4_api_spec.json):
    webm, mpegts, mpjpeg, mp4, mkv, _3gp, rtp, flv, f4v
  webm / mp4 / mkv are the most broadly playable for short saved clips;
  mpjpeg is a multipart MJPEG stream (frames, not a single video); rtp/flv/
  f4v/_3gp/mpegts are the remaining containers the server can mux to.

LIVE vs ARCHIVE:
  - No --pos            -> LIVE: save the next --duration seconds.
  - --pos <ISO|epochMs> -> ARCHIVE: save --duration seconds starting there.

Because a CLI must terminate, the clip is always bounded by --duration
(seconds, default 10). durationMs is sent to the server AND used as a
client-side safety stop so the program can never hang on an endless stream.

Important: in cloud mode the relay answers with an HTTP 307 redirect to the node
that actually serves the request. The `requests` library DROPS the Authorization
header on a cross-host redirect, so we follow the 307 MANUALLY and re-attach the
bearer header. See _get_following_redirects().

Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
"""

import argparse
import datetime as dt
import os
import re
import sys

import requests


CLIENT_ID = "3rdParty"
RELAY_SUFFIX = ".relay.vmsproxy.com"
# API version path segment. v4 is the latest Nx REST API.
API = "/rest/v4"

# The two auth modes this sample supports (same names as the web sample).
MODE_DIRECT = "direct"
MODE_CLOUD = "cloud"

# Container formats the v4 media.{format} endpoint supports, copied verbatim
# from the `format` enum in docs/v4_api_spec.json. Don't invent others.
FORMATS = ["webm", "mpegts", "mpjpeg", "mp4", "mkv", "_3gp", "rtp", "flv", "f4v"]
DEFAULT_FORMAT = "webm"

# Clip length when --duration is not given (seconds).
DEFAULT_DURATION_S = 10
# Extra wall-clock grace beyond durationMs before the client-side stop fires.
ABORT_GRACE_MS = 10000
# Most redirects we will follow when chasing the relay 307.
MAX_REDIRECTS = 5
# Size of the chunks streamed to disk (bytes).
CHUNK_SIZE = 64 * 1024


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when login or the bearer token is rejected."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


# ---------------------------------------------------------------------------
# Parsing helpers (pure functions = easy to test)
# ---------------------------------------------------------------------------

_DIGITS_RE = re.compile(r"^\d+$")


def parse_position_ms(value):
    """Turn the optional archive position into epoch ms, or None for live.

    Accepts an ISO 8601 string (2026-06-15T12:00:00Z) or a raw epoch-ms number.
    Empty/blank -> None (live). Naive times are treated as UTC.
    """
    text = "" if value is None else str(value).strip()
    if not text:
        return None  # live
    if _DIGITS_RE.match(text):
        return int(text)  # already epoch ms
    try:
        when = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError(
            f'Could not parse archive position "{text}". '
            "Use ISO time or epoch ms.") from exc
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.timezone.utc)
    return int(when.timestamp() * 1000)


def normalize_format(value):
    """Validate/normalize a requested container format."""
    text = (DEFAULT_FORMAT if value is None else str(value)).strip().lower()
    text = text[1:] if text.startswith(".") else text
    if text in FORMATS:
        return text
    raise ApiError(
        f'Unsupported format "{value}". Choose one of: {", ".join(FORMATS)}.')


def duration_to_ms(seconds):
    """Parse --duration (seconds, may be fractional) into whole milliseconds."""
    if seconds is None or seconds == "":
        return DEFAULT_DURATION_S * 1000
    try:
        number = float(seconds)
    except (TypeError, ValueError) as exc:
        raise ApiError(
            f'--duration must be a positive number of seconds (got "{seconds}").'
        ) from exc
    if number <= 0:
        raise ApiError(
            f'--duration must be a positive number of seconds (got "{seconds}").')
    return round(number * 1000)


def default_out_name(device_id, fmt, now=None):
    """Default output filename: clip-<device>-<ts>.<fmt> (filesystem-safe)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H-%M-%S")
    safe_id = re.sub(r"[^A-Za-z0-9._-]", "_", str(device_id))
    return f"clip-{safe_id}-{stamp}.{fmt}"


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
        "device_id": pick(cli_args.device_id, "NX_DEVICE_ID"),
        "format": normalize_format(pick(cli_args.format, "NX_MEDIA_FORMAT")),
        "position_ms": parse_position_ms(cli_args.pos),
        "duration_ms": duration_to_ms(cli_args.duration),
        "out": cli_args.out,
    }


def missing_fields(config):
    """Which required fields are missing for the chosen mode."""
    required = (("cloud_host", "user", "password", "site_id", "device_id")
                if config["mode"] == MODE_CLOUD
                else ("server_host", "user", "password", "device_id"))
    return [name for name in required if not config[name]]


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class NxMediaClient:
    """Logs in (direct OR cloud) and streams a media clip via the bearer token."""

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
    def media_base(self):
        """Where media requests go: the server directly, or the site relay."""
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
    # build_media_url(): the upstream media URL (header auth -- no token in URL).
    # -----------------------------------------------------------------------

    def build_media_url(self, device_id, fmt, position_ms=None, duration_ms=None):
        if not device_id:
            raise ApiError("A device_id is required to build the media URL.")
        from urllib.parse import quote, urlencode
        path = (f"{self.media_base}{API}/devices/"
                f"{quote(str(device_id), safe='')}/media.{fmt}")
        params = []
        # position_ms present == archive; absent == live.
        if position_ms is not None:
            params.append(("positionMs", str(position_ms)))
        if duration_ms is not None:
            params.append(("durationMs", str(duration_ms)))
        query = urlencode(params)
        return f"{path}?{query}" if query else path

    def _get_following_redirects(self, url):
        """GET that follows the relay's 307 MANUALLY, re-attaching the bearer.

        Auto-follow can drop the Authorization header across hosts, so we use
        allow_redirects=False and resolve Location ourselves, re-sending the
        bearer on every hop. Works for the direct server too (it just won't
        redirect). stream=True so the body is read in chunks, not buffered.
        """
        from urllib.parse import urljoin
        headers = self._auth_header()
        current = url
        for _hop in range(MAX_REDIRECTS + 1):
            try:
                response = self.session.get(
                    current, headers=headers, timeout=self.timeout,
                    allow_redirects=False, stream=True)
            except requests.exceptions.RequestException as exc:
                raise ApiError(f"Could not reach {current}: {exc}") from exc
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("Location")
                if not location:
                    return response
                current = urljoin(current, location)
                continue  # re-issue with the SAME headers -> bearer re-attached
            return response
        raise ApiError(
            f"Too many redirects (>{MAX_REDIRECTS}) chasing the relay.")

    # -----------------------------------------------------------------------
    # save_clip(): fetch the media stream and write it through `sink`.
    # -----------------------------------------------------------------------

    def save_clip(self, sink, device_id, fmt, position_ms=None, duration_ms=None):
        """Fetch the clip and hand the response body to `sink`, which writes it
        somewhere and returns the number of bytes written. Returns the byte
        count. A client-side wall-clock stop (durationMs + grace) ensures the
        CLI can never hang on an endless live stream.
        """
        url = self.build_media_url(device_id, fmt, position_ms, duration_ms)
        response = self._get_following_redirects(url)

        if response.status_code in (401, 403):
            raise AuthError(
                f"The server rejected the token (HTTP {response.status_code}). "
                "In cloud mode make sure it was scoped with cloudSystemId for "
                "THIS site.")
        if not response.ok:
            raise ApiError(f"Media request failed: HTTP {response.status_code} "
                           f"{response.text[:200]}")
        if response.raw is None:
            raise ApiError("Media response had no body to save.")

        deadline = None
        if duration_ms and duration_ms > 0:
            deadline = _now_ms() + duration_ms + ABORT_GRACE_MS

        def chunks():
            for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
                if deadline is not None and _now_ms() > deadline:
                    # Safety stop: never hang on an endless stream.
                    break
                if chunk:
                    yield chunk

        try:
            return sink(chunks())
        finally:
            response.close()

    # -----------------------------------------------------------------------
    # logout(): revoke the token. Best-effort cleanup.
    # -----------------------------------------------------------------------

    def logout(self):
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


def _now_ms():
    """Wall-clock milliseconds (separate so tests can patch it)."""
    import time
    return int(time.time() * 1000)


# ---------------------------------------------------------------------------
# File sink: stream the response body to a file on disk (no buffering).
# ---------------------------------------------------------------------------

def file_sink(out_path):
    """Return a sink that writes each chunk to out_path and returns the byte
    count. The clip is never held in memory all at once.
    """
    def sink(chunks):
        written = 0
        with open(out_path, "wb") as handle:
            for chunk in chunks:
                handle.write(chunk)
                written += len(chunk)
        return written
    return sink


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Save a short video clip from an Nx camera to a file.")
    parser.add_argument("--mode", default=None, choices=(MODE_DIRECT, MODE_CLOUD),
                        help="Auth mode (default direct)")
    parser.add_argument("--server-host", default=None,
                        help="Media server base URL (direct mode), "
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
    parser.add_argument("--device-id", default=None, help="Camera/device id")
    parser.add_argument("--format", default=None,
                        help=f"Container, one of: {', '.join(FORMATS)} (default webm)")
    parser.add_argument("--pos", default=None,
                        help="Archive start (ISO 8601 or epoch ms); omit for live")
    parser.add_argument("--duration", default=None,
                        help="Clip length in seconds (default 10)")
    parser.add_argument("--out", default=None,
                        help="Output file (default clip-<device>-<ts>.<format>)")
    parser.add_argument("--env-file", default=".env", help="Path to a .env file")
    parser.add_argument("--insecure", action="store_true",
                        help="Skip TLS verification (usually needed for local servers)")
    return parser


def main(argv=None):
    args = build_arg_parser().parse_args(argv)

    try:
        # bad --format / --pos / --duration surface here
        config = resolve_config(args, load_env_file(args.env_file))
    except ApiError as exc:
        print(f"{exc}", file=sys.stderr)
        return 2

    missing = missing_fields(config)
    if missing:
        print("Missing config: " + ", ".join(missing) +
              ".\nProvide via flags or .env (copy .env.example). See the README.",
              file=sys.stderr)
        return 2

    out_path = config["out"] or default_out_name(config["device_id"], config["format"])

    client = NxMediaClient(
        config["mode"], config["user"], config["password"],
        server_host=config["server_host"], cloud_host=config["cloud_host"],
        site_id=config["site_id"], mfa_code=config["mfa_code"],
        verify_tls=not args.insecure,
    )

    live_or_archive = ("live" if config["position_ms"] is None
                       else f"archive @ {config['position_ms']}ms")
    try:
        client.login()
        print(f"Saving {config['duration_ms'] / 1000}s {live_or_archive} clip of "
              f"device {config['device_id']} ({config['format']}) to {out_path} ...")
        bytes_written = client.save_clip(
            file_sink(out_path), config["device_id"], config["format"],
            position_ms=config["position_ms"], duration_ms=config["duration_ms"])
        print(f"Done. Wrote {bytes_written} bytes to {out_path}")
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
