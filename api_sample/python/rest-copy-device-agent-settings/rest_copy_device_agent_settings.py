#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx VMS REST Server API sample: copy one device's Device Agent (analytics
plugin) settings onto another device.

Downloads the settings an analytics Engine keeps for one Device Agent, then
applies them to another device running the same (or a compatible) Engine. Two
subcommands, like rest-backup-site-database: "download" writes the settings to
a JSON file, "apply" loads that file and sends it to a target device. Run
"apply" once per target device; looping over many devices is a shell loop
around this command, not a flag on it.

  download:
    1. Log in:  POST /rest/v4/login/sessions  {username, password} -> {"token": ...}
    2. Get:     GET /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
    3. Log out: DELETE /rest/v4/login/sessions/<token>

  apply:
    1. Log in, as above.
    2. Set:     PUT /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
                with the downloaded settings, minus deviceId and engineId: those
                are read-only in the response and are not even in the spec's PUT
                request body schema, because the URL already identifies the
                device and engine. _error is dropped too: it is the source
                Engine's report on its own settings, not configuration.
                Everything else (values, model, analyzedStream,
                disableStreamSelection) is forwarded unchanged.
    3. Log out.

  Both subcommands log out on the way out, on failure as well as on success.
  No request follows a redirect: a 3xx is reported as a failure.

Connecting to the server:
  --host is the server, e.g. https://192.168.1.10:7001  (note the https + port).
  Local servers usually present a self-signed certificate, so for a lab server
  you will typically need --insecure.

Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
"""

import argparse
import datetime
import json
import os
import sys
import tempfile
import urllib.parse

import requests
import urllib3


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
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_config(cli_args, env_file_values):
    """Apply the house precedence: CLI flag > environment variable > .env file."""
    def pick(cli_value, env_name):
        if cli_value:
            return cli_value
        return os.environ.get(env_name) or env_file_values.get(env_name, "")

    return {
        "host": pick(cli_args.host, "NX_SERVER_HOST").rstrip("/"),
        "user": pick(cli_args.user, "NX_SERVER_USER"),
        "password": pick(cli_args.password, "NX_SERVER_PASSWORD"),
        "device_id": pick(cli_args.device_id, "NX_DEVICE_ID"),
        "engine_id": pick(cli_args.engine_id, "NX_ANALYTICS_ENGINE_ID"),
    }


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Login was rejected: wrong credentials, or a cloud user on a local login."""


class ApiError(Exception):
    """The server answered, but not with what the API contract promises."""


class EngineReportedError(ApiError):
    """The server took the settings, but the Engine reported errors on them."""


class ConfigError(Exception):
    """Configuration is missing, which is exit code 2 rather than a call failure."""


class ApplyInterrupted(KeyboardInterrupt):
    """Ctrl-C while the settings PUT was in flight: it may have reached the server."""


class LocalFileError(Exception):
    """Saving the download failed locally: a missing folder, no permission, a full disk."""

    def __init__(self, path, error):
        # The path the user gave, never the side file; the OS reason, no path.
        super().__init__("could not use {}: {}.".format(path, error.strerror or error))


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

# API version path segment. v4 is the latest Nx REST API.
API = "/rest/v4"

# Seconds each request may take, to connect and to answer.
REQUEST_TIMEOUT_S = 30

# deviceId and engineId are read-only in the response and are not even in the
# spec's PUT request body schema: the URL identifies the device and engine, not
# the body. _error is the source Engine's report on its own settings; echoing
# it back would hand the target device someone else's errors. Everything else
# the spec's PUT body accepts is forwarded unchanged.
_NOT_FORWARDED_SETTINGS_FIELDS = ("deviceId", "engineId", "_error")

# What apply says when the PUT may have reached the server but no answer came
# back: the settings may or may not have been applied.
OUTCOME_UNKNOWN = ("Outcome unknown: the connection was lost after the settings "
                   "were sent. Download the device's settings to check.")


def _status_text(status_code):
    """'HTTP 404', or 'HTTP 302 (redirect not followed)' for a 3xx."""
    if 300 <= status_code < 400:
        return "HTTP {} (redirect not followed)".format(status_code)
    return "HTTP {}".format(status_code)


def _is_success(status_code):
    return 200 <= status_code < 300


def _never_connected(error):
    """True when a requests error means nothing was sent: the connection was
    refused, the name did not resolve, the TLS handshake failed, or connecting
    timed out. Anything else (a read timeout, a reset after connecting) may have
    happened after the request went out."""
    if isinstance(error, (requests.exceptions.ConnectTimeout,
                          requests.exceptions.SSLError)):
        return True
    # requests wraps a failure to connect in urllib3's MaxRetryError; a drop on
    # an open connection arrives unwrapped (ProtocolError).
    return (isinstance(error, requests.exceptions.ConnectionError)
            and bool(error.args)
            and isinstance(error.args[0], urllib3.exceptions.MaxRetryError))


def _reason(error):
    """A failure as printed after "could not reach the server: " or "could not
    log out: ", ending with exactly one period. A timeout says how long it
    waited, not requests' own text ("HTTPConnectionPool(...): Read timed out.")."""
    if isinstance(error, requests.exceptions.ConnectTimeout):
        return "no connection within {} s.".format(REQUEST_TIMEOUT_S)
    if isinstance(error, requests.exceptions.Timeout):
        return "no answer within {} s.".format(REQUEST_TIMEOUT_S)
    return "{}.".format(str(error).rstrip("."))


def _error_text(message):
    """An Engine error message as printed: a string as-is, anything else as JSON."""
    return message if isinstance(message, str) else json.dumps(message, separators=(",", ":"))


def _unwrap_reply(data):
    """Some Nx versions wrap a single-object reply in {"reply": {...}}, the
    same way list endpoints wrap an array."""
    if isinstance(data, dict) and isinstance(data.get("reply"), dict):
        return data["reply"]
    return data


class NxServerClient:
    """A minimal bearer-token client for one VMS server.

    Deliberately small: one session, one token, no retry logic. The point is to
    show the calls, not to be a library.
    """

    def __init__(self, host, verify_tls=True):
        self.host = host.rstrip("/")
        self.session = requests.Session()
        self.session.verify = verify_tls
        if not verify_tls:
            # --insecure is expected for local servers with self-signed certs;
            # don't spam the console with a warning for every request.
            urllib3.disable_warnings(
                urllib3.exceptions.InsecureRequestWarning)
        self.token = None

    def login(self, username, password):
        """POST login/sessions -> bearer token, stored on this client."""
        response = self.session.post(
            self.host + API + "/login/sessions",
            json={"username": username, "password": password},
            timeout=REQUEST_TIMEOUT_S,
            allow_redirects=False,
        )
        if response.status_code in (401, 403):
            raise AuthError(
                "Login unauthorized (HTTP {}). Check the password, and note that "
                "a cloud account cannot log in here. It needs the OAuth2 flow."
                .format(response.status_code))
        if not _is_success(response.status_code):
            # The server answered, so this is not "could not reach the server".
            raise ApiError("Login failed: {}.".format(_status_text(response.status_code)))

        try:
            data = response.json()
        except ValueError:
            raise ApiError("Login failed: the response was not valid JSON.")
        token = data.get("token") if isinstance(data, dict) else None
        if not isinstance(token, str) or not token:
            raise ApiError("Login failed: the response did not contain a token.")

        self.token = token
        self.session.headers["Authorization"] = "Bearer " + token
        return token

    def _settings_url(self, engine_id, device_id):
        # Percent-encoded: an id holding "/", "?" or "#" must not change the path.
        return "{}{}/analytics/engines/{}/deviceAgents/{}/settings".format(
            self.host, API, urllib.parse.quote(engine_id, safe=""),
            urllib.parse.quote(device_id, safe=""))

    def download_settings(self, engine_id, device_id):
        """GET a Device Agent's settings -> the bare settings object.

        Your account needs Power User (or better) on this site.
        """
        if not self.token:
            raise ApiError("Not logged in. Call login() first.")
        response = self.session.get(
            self._settings_url(engine_id, device_id), timeout=REQUEST_TIMEOUT_S,
            allow_redirects=False)
        if response.status_code in (401, 403):
            raise AuthError(
                "Reading settings was refused (HTTP {}). This endpoint needs "
                "Power User or better.".format(response.status_code))
        if not _is_success(response.status_code):
            raise ApiError(
                "Reading settings failed: {}.".format(_status_text(response.status_code)))
        try:
            data = _unwrap_reply(response.json())
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise ApiError("Reading settings failed: the server did not return a JSON object.")
        return data

    def apply_settings(self, engine_id, device_id, body):
        """PUT a Device Agent's settings. body should come from build_apply_body().

        Returns quietly when the settings were applied. Raises ApiError when the
        server refused them, when the Engine took them but reported errors, or
        when the connection was lost after they were sent (outcome unknown).
        """
        if not self.token:
            raise ApiError("Not logged in. Call login() first.")
        try:
            response = self.session.put(
                self._settings_url(engine_id, device_id), json=body, timeout=REQUEST_TIMEOUT_S,
                allow_redirects=False)
        except KeyboardInterrupt as error:
            raise ApplyInterrupted() from error
        except requests.exceptions.RequestException as error:
            if _never_connected(error):
                raise          # nothing was sent: main() says "not applied"
            raise ApiError(OUTCOME_UNKNOWN) from error
        if response.status_code in (401, 403):
            raise AuthError(
                "Applying settings was refused (HTTP {}). This endpoint needs "
                "Power User or better.".format(response.status_code))
        if not _is_success(response.status_code):
            status = response.status_code
            if status >= 500:
                # A server error can come after part of the settings landed.
                outcome = ("The server may have applied some of them; "
                           "download the device's settings to check.")
            elif status >= 400:
                outcome = ("The settings were not applied. The target device "
                           "may not be running this Engine.")
            else:
                outcome = "The settings were not applied."
            raise ApiError("Applying settings failed: {}. {}".format(
                _status_text(status), outcome))

        # A 2xx with an empty body, or one that is not JSON, is applied. A JSON
        # answer can still carry the Engine's own complaints in _error.
        if not response.content.strip():
            return
        try:
            data = _unwrap_reply(response.json())
        except ValueError:
            return
        errors = data.get("_error") if isinstance(data, dict) else None
        if isinstance(errors, dict) and errors:
            raise EngineReportedError(
                "The server took the settings but the Engine reported errors:\n"
                + "\n".join("  {}: {}".format(name, _error_text(message))
                            for name, message in errors.items()))

    def logout(self):
        """DELETE the session so the token is not left valid. Safe to call twice."""
        if not self.token:
            return
        try:
            response = self.session.delete(
                self.host + API + "/login/sessions/" + self.token, timeout=REQUEST_TIMEOUT_S,
                allow_redirects=False)
        finally:
            # Forget the token either way: a second attempt would not fare better.
            self.token = None
            self.session.headers.pop("Authorization", None)
        if not _is_success(response.status_code):
            raise ApiError("Logout failed: {}.".format(_status_text(response.status_code)))


# ---------------------------------------------------------------------------
# Settings file <-> PUT body
# ---------------------------------------------------------------------------

def build_apply_body(settings):
    """Drop the fields the URL already identifies (deviceId, engineId) and the
    source Engine's error report (_error); forward the rest of the downloaded
    settings unchanged (values, model, analyzedStream, disableStreamSelection).

    A field absent from `settings` (a hand-edited or partial file) stays absent
    from the body rather than being sent as null, so it is not mistaken for
    "clear this setting".
    """
    return {key: value for key, value in settings.items()
            if key not in _NOT_FORWARDED_SETTINGS_FIELDS}


def default_output_name(device_id, now=None):
    """Build a filename that says which device the settings came from, and when.

    The timestamp is UTC so that downloads taken in different time zones still
    sort into the order they were taken.
    """
    moment = now or datetime.datetime.now(datetime.timezone.utc)
    return "nx-device-agent-settings-{}-{}.json".format(
        device_id, moment.strftime("%Y%m%dT%H%M%SZ"))


def _remove_quietly(path):
    """Delete a file if it exists. Used to clean up a side file that did not finish."""
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def save_settings_file(path, settings, overwrite=False):
    """Write the downloaded settings object as pretty-printed JSON.

    The JSON goes to a fresh side file beside `path` first (mkstemp: a unique
    name, readable by the owner only), then moves into place, so an interrupted
    write never leaves a half-written settings file. An existing `path` is
    replaced only when `overwrite` is set; the check is made at the move, so a
    file that appeared during the download is not clobbered either.
    """
    try:
        _write_settings_file(path, settings, overwrite)
    except OSError as error:
        raise LocalFileError(path, error) from error


def _write_settings_file(path, settings, overwrite):
    folder, name = os.path.split(path)
    fd, partial = tempfile.mkstemp(prefix=name + ".", suffix=".partial", dir=folder or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(settings, handle, indent=2, sort_keys=True)
            handle.write("\n")
        if overwrite:
            os.replace(partial, path)
        else:
            # link() fails if path exists, atomically, where a rename would
            # silently replace it.
            try:
                os.link(partial, path)
            except FileExistsError:
                raise ApiError("{} already exists; use --force".format(path))
            except OSError:
                # No hard links here (FAT/exFAT, some network shares, Windows
                # without them). Check, then rename. On Windows the rename
                # itself refuses an existing destination; on POSIX it replaces
                # it, so a file that appears in the small window between the
                # check and the rename would still be replaced there.
                if os.path.lexists(path):
                    raise ApiError("{} already exists; use --force".format(path))
                try:
                    os.rename(partial, path)
                except FileExistsError:
                    raise ApiError("{} already exists; use --force".format(path))
            _remove_quietly(partial)
    except BaseException:
        # Covers Ctrl-C and the move too: no side file stays behind.
        _remove_quietly(partial)
        raise


def load_settings_file(path):
    """Read a settings file for apply. Raises ApiError when it is not a JSON object."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            settings = json.load(handle)
    except (ValueError, UnicodeDecodeError) as error:
        raise ApiError("{} is not valid JSON: {}.".format(path, str(error).rstrip(".")))
    if not isinstance(settings, dict):
        raise ApiError("{} does not hold a JSON object.".format(path))
    return settings


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

# Flags that take a value (argparse dest names). An empty value is an argument error.
_VALUE_FLAGS = ("host", "user", "password", "device_id", "engine_id", "env_file", "out")


def build_arg_parser():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    subparsers = parser.add_subparsers(dest="command")

    def add_common(sub):
        sub.add_argument("--host", help="https://<server>:7001")
        sub.add_argument("--user", help="a LOCAL server account")
        sub.add_argument("--password", help="that account's password")
        sub.add_argument("--device-id", help="the device this invocation concerns")
        sub.add_argument("--engine-id", help="the analytics Engine this invocation concerns")
        sub.add_argument("--env-file", default=".env",
                         help="path to the shared .env (default: ./.env)")
        sub.add_argument("--insecure", action="store_true",
                         help="skip TLS verification (normal for a lab server's "
                              "self-signed certificate)")

    download = subparsers.add_parser(
        "download", help="download a Device Agent's settings to a file")
    add_common(download)
    download.add_argument("--out", default=None,
                          help="where to write the settings. Default: an "
                               "auto-named file in the current directory.")
    download.add_argument("--force", action="store_true",
                          help="overwrite --out if it already exists")

    apply_ = subparsers.add_parser(
        "apply", help="apply a downloaded settings file to a device")
    apply_.add_argument("file", help="a settings file produced by the download command")
    add_common(apply_)
    apply_.add_argument("--yes", action="store_true",
                        help="confirm. This overwrites the target device's "
                             "existing Device Agent settings.")

    return parser


def _resolve_or_fail(args):
    config = resolve_config(args, load_env_file(args.env_file))
    missing = [name for name in ("host", "user", "password", "device_id", "engine_id")
               if not config[name]]
    if missing:
        raise ConfigError(
            "missing configuration: {}. Set it with a flag, an NX_* "
            "environment variable, or in {}."
            .format(", ".join(missing), args.env_file))
    return config


def _logout_quietly(client):
    """Log out on the way out of a failure, without hiding the failure itself."""
    try:
        client.logout()
    except (requests.exceptions.RequestException, ApiError):
        pass


def _logout_after_result(client):
    """Log out once the run has its result: the success line, or the Engine's
    errors, is already printed.

    A logout that fails is only a warning: the result stands, so it does not
    change the exit code. That includes Ctrl-C during this logout: the run is
    finished, so it is not "Interrupted." either.
    """
    try:
        client.logout()
    except (requests.exceptions.RequestException, ApiError) as error:
        print("WARNING: could not log out: {}".format(_reason(error)), file=sys.stderr)
    except KeyboardInterrupt:
        print("WARNING: could not log out: interrupted.", file=sys.stderr)


def _run_download(args):
    destination = args.out
    if destination and os.path.isdir(destination):
        print("ERROR: {} is a directory. Give --out a file path.".format(destination),
              file=sys.stderr)
        return 1
    # lexists: a dangling symlink at --out is refused too, before login.
    if destination and os.path.lexists(destination) and not args.force:
        print("ERROR: {} already exists; use --force".format(destination), file=sys.stderr)
        return 1

    config = _resolve_or_fail(args)
    if not destination:
        destination = default_output_name(config["device_id"])

    client = NxServerClient(config["host"], verify_tls=not args.insecure)
    try:
        client.login(config["user"], config["password"])
        print("Logged in to {} as {}\n".format(config["host"], config["user"]))

        settings = client.download_settings(config["engine_id"], config["device_id"])
        save_settings_file(destination, settings, overwrite=args.force)
    except BaseException:
        # A failed (or interrupted) download must not leave the session open.
        _logout_quietly(client)
        raise
    print("Downloaded Device Agent settings for device {} (engine {}) -> {}"
          .format(config["device_id"], config["engine_id"], destination))

    _logout_after_result(client)
    return 0


def _run_apply(args):
    if not args.yes:
        print("ERROR: Refusing to apply without --yes. This overwrites the "
              "target device's existing Device Agent settings.", file=sys.stderr)
        return 1
    if os.path.isdir(args.file):
        print("ERROR: {} is a directory, not a settings file.".format(args.file),
              file=sys.stderr)
        return 1
    if not os.path.exists(args.file):
        print("ERROR: No such settings file: {}".format(args.file), file=sys.stderr)
        return 1

    # Checked before logging in: a file that cannot be sent costs no session.
    body = build_apply_body(load_settings_file(args.file))

    config = _resolve_or_fail(args)

    client = NxServerClient(config["host"], verify_tls=not args.insecure)
    try:
        client.login(config["user"], config["password"])
        print("Logged in to {} as {}\n".format(config["host"], config["user"]))

        client.apply_settings(config["engine_id"], config["device_id"], body)
    except EngineReportedError as error:
        # A finished result, like success: say it first, then log out, with
        # the same warning if that logout fails.
        print("ERROR: {}".format(error), file=sys.stderr)
        _logout_after_result(client)
        return 1
    except BaseException:
        # Refused, could not reach the server, outcome unknown, or Ctrl-C: log
        # out all the same, silently, so only the real error is shown.
        _logout_quietly(client)
        raise
    print("Applied Device Agent settings to device {} (engine {})."
          .format(config["device_id"], config["engine_id"]))

    _logout_after_result(client)
    return 0


def main(argv=None):
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    # "--out=" parses as an empty value; that is a missing value, not a default.
    for dest in _VALUE_FLAGS:
        if getattr(args, dest, None) == "":
            parser.error("Missing value for --{}".format(dest.replace("_", "-")))

    if not args.command:
        parser.print_help(sys.stderr)
        return 2

    # Said when apply could not reach the server: nothing was sent.
    not_applied = " The settings were not applied." if args.command == "apply" else ""

    try:
        if args.command == "download":
            return _run_download(args)
        return _run_apply(args)

    except ApplyInterrupted:
        # Ctrl-C with the PUT in flight: nobody knows whether it landed.
        print("Interrupted. Outcome unknown: the settings may have been sent. "
              "Download the device's settings to check.", file=sys.stderr)
        return 130
    except KeyboardInterrupt:
        # The side file is already removed and the session logged out by the
        # cleanup on the way here.
        print("Interrupted.", file=sys.stderr)
        return 130
    except ConfigError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2
    except AuthError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 1
    except (ApiError, LocalFileError) as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 1
    except requests.exceptions.SSLError:
        print("ERROR: certificate verification failed. Local servers use a "
              "self-signed certificate, add --insecure.{}".format(not_applied),
              file=sys.stderr)
        return 1
    except requests.exceptions.RequestException as error:
        print("ERROR: could not reach the server: {}{}".format(_reason(error), not_applied),
              file=sys.stderr)
        return 1
    except OSError as error:
        # A local file problem: --out in a missing folder, no permission, a full
        # disk. Comes after RequestException, which is an OSError too.
        print("ERROR: could not use {}: {}.".format(
            error.filename2 or error.filename or "the file", error.strerror or error),
            file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
