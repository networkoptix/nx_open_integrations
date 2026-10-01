#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Nx VMS REST Server API sample: back up and restore the Site database.

The Site database is shared by every server in the site, so one dump is a
snapshot of the whole site configuration: servers, cameras, users, groups,
layouts, rules, licences and storage settings.

  backup
  1. Log in:    POST   /rest/v4/login/sessions  {username, password} -> {"token": ...}
  2. Dump:      GET    /rest/v4/site/database   (Authorization: Bearer <token>)
  3. Log out:   DELETE /rest/v4/login/sessions/<token>

  restore
  1. Log in:    POST   /rest/v4/login/sessions
  2. Load:      POST   /rest/v4/site/database   (Content-Type: application/octet-stream)
  3. No log out. The server restarts as soon as it accepts the dump, so the
     session ends with it.

Both database calls want an administrator on a fresh session, which is why this
sample always logs in immediately before the call and never takes a token you
already hold.

Connecting to the server:
  --host is the server, e.g. https://192.168.1.10:7001 (note the https + port).
  Local servers usually present a self-signed certificate, so for a lab server
  you will typically need --insecure.

Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
"""

import argparse
import datetime
import os
import sys
import tempfile

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
            key, value = line.split("=", 1)
            value = value.strip()
            # Same as the other ports: a value wrapped in matching quotes loses
            # them, so PASSWORD="x" means x everywhere.
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            values[key.strip()] = value
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
    }


# ---------------------------------------------------------------------------
# Naming the dump file
# ---------------------------------------------------------------------------

def _remove_quietly(path):
    """Delete a file if it exists. Used to clean up a dump that did not finish."""
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def _open_private_beside(destination):
    """Create a fresh side file next to `destination`, readable by the owner only.

    The dump holds every user's password hashes and the servers' auth keys, so
    it must not come out world-readable the way a plain open() makes it under
    the usual umask. mkstemp creates it 0600 under a name no other run can be
    using, so two backups to the same --out never write into each other's file.
    Returns (path, handle).
    """
    folder, name = os.path.split(destination)
    fd, path = tempfile.mkstemp(prefix=name + ".", suffix=".partial", dir=folder or ".")
    return path, os.fdopen(fd, "wb")


def default_output_name(host, now=None):
    """Build a filename that says which site the dump came from, and when.

    The timestamp is UTC so that dumps taken from servers in different time
    zones still sort into the order they were taken.
    """
    moment = now or datetime.datetime.now(datetime.timezone.utc)
    # Dots and colons become dashes, and an IPv6 literal's brackets go, so the
    # name is safe on every filesystem: [fe80::1]:7001 -> fe80--1-7001.
    where = host.split("://", 1)[-1]
    for old, new in ((".", "-"), (":", "-"), ("[", ""), ("]", "")):
        where = where.replace(old, new)
    return "nx-site-database-{}-{}.db".format(
        where, moment.strftime("%Y%m%dT%H%M%SZ"))


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Login was rejected: wrong credentials, or a cloud user on a local login."""


class ApiError(Exception):
    """The server answered, but not with what the API contract promises."""


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

# API version path segment. v4 is the latest Nx REST API.
API = "/rest/v4"

# How long to wait for the server to answer a load. Like every requests timeout
# it limits each wait for data, not the whole call.
RESTORE_TIMEOUT = 300

# Read the dump in 1 MiB pieces. A site dump runs to tens of megabytes, so it is
# streamed to disk rather than held in memory.
CHUNK_SIZE = 1024 * 1024


def _stream_to(response, handle):
    """Copy a streamed response body into an open binary handle, chunk by chunk."""
    written = 0
    for chunk in response.iter_content(chunk_size=CHUNK_SIZE):
        if not chunk:
            continue
        handle.write(chunk)
        written += len(chunk)
    return written


class _CountingReader:
    """A file wrapper for a requests body that counts the bytes read from it.

    __len__ keeps requests sending a Content-Length instead of chunking.
    """

    def __init__(self, handle, size):
        self._handle = handle
        self._size = size
        self.sent = 0

    def __len__(self):
        return self._size

    def read(self, amount=-1):
        chunk = self._handle.read(amount)
        self.sent += len(chunk)
        return chunk


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
            requests.packages.urllib3.disable_warnings(
                requests.packages.urllib3.exceptions.InsecureRequestWarning)
        self.token = None

    def login(self, username, password):
        """POST login/sessions -> bearer token, stored on this client."""
        response = self.session.post(
            self.host + API + "/login/sessions",
            json={"username": username, "password": password, "setCookie": False},
            timeout=30,
        )
        if response.status_code in (401, 403):
            raise AuthError(
                "Login unauthorized (HTTP {}). Check the password, and note that "
                "a cloud account cannot log in here. It needs the OAuth2 flow."
                .format(response.status_code))
        if response.status_code >= 400:
            # The server answered, so this is not "could not reach the server".
            raise ApiError("Login failed: HTTP {}.".format(response.status_code))

        try:
            data = response.json()
        except ValueError:
            raise ApiError("Login response was not valid JSON.")
        token = data.get("token") if isinstance(data, dict) else None
        if not token:
            raise ApiError("Login response did not contain a token.")

        self.token = token
        self.session.headers["Authorization"] = "Bearer " + token
        return token

    def backup_database(self, destination, overwrite=False):
        """GET site/database -> the binary dump, written to destination.

        An existing destination is replaced only when `overwrite` is set; the
        check is made when the finished dump is moved into place, so a file that
        appears during the download is not clobbered either.

        Returns the number of bytes written.
        """
        response = self.session.get(
            self.host + API + "/site/database", timeout=300, stream=True)
        if response.status_code in (401, 403):
            raise AuthError(
                "The site refused the dump (HTTP {}). This endpoint needs an "
                "administrator on a fresh session."
                .format(response.status_code))
        if response.status_code >= 400:
            raise ApiError(
                "The dump request failed (HTTP {}).".format(response.status_code))

        if destination == "-":
            written = _stream_to(response, sys.stdout.buffer)
        else:
            # Write to a side file and rename it into place only once the whole
            # dump has arrived. A transfer cut halfway then leaves nothing that
            # looks like a backup, and --force never destroys the old dump
            # before the new one is complete.
            partial, handle = _open_private_beside(destination)
            try:
                with handle:
                    written = _stream_to(response, handle)
                if written == 0:
                    _remove_quietly(partial)
                elif overwrite:
                    os.replace(partial, destination)
                else:
                    # link() fails if destination exists, atomically, where a
                    # rename would silently replace it.
                    try:
                        os.link(partial, destination)
                    except FileExistsError:
                        raise ApiError(
                            "Refusing to overwrite {}, which appeared during the "
                            "download. Choose another --out, or pass --force."
                            .format(destination))
                    _remove_quietly(partial)
            except BaseException:
                # Covers the rename too: a dump that cannot be moved into place
                # must not stay behind as <out>.partial either.
                _remove_quietly(partial)
                raise

        if written == 0:
            raise ApiError(
                "The server returned an empty dump. Check that the account is an "
                "administrator and that the site has finished starting.")
        return written

    def restore_database(self, source):
        """POST site/database with the dump bytes as the body.

        The server restarts as soon as it accepts the dump.
        """
        # The open file is the body: requests sends it with a Content-Length
        # taken from its size and reads it from disk as it goes, so the dump is
        # never held whole in memory. The wrapper counts what was read, which is
        # what tells the restart (whole dump sent, then the connection drops)
        # apart from a connection lost before the server had the dump.
        size = os.path.getsize(source)
        with open(source, "rb") as handle:
            body = _CountingReader(handle, size)
            try:
                response = self.session.post(
                    self.host + API + "/site/database",
                    data=body,
                    headers={"Content-Type": "application/octet-stream"},
                    timeout=RESTORE_TIMEOUT,
                    # A redirect would turn the POST into a GET of the dump and
                    # read as success; the load is only ever this URL.
                    allow_redirects=False)
            except requests.exceptions.ReadTimeout:
                # The dump went out but no answer came back. That is not the
                # restart (which drops the connection) and not a refusal (which
                # answers), so the honest report is that nobody knows yet.
                raise ApiError(
                    "No answer within {} s after the dump was sent. The server "
                    "may have loaded it and be restarting, or the load may have "
                    "failed. Check the server before restoring again."
                    .format(RESTORE_TIMEOUT))
            except requests.exceptions.ConnectionError:
                if body.sent < size:
                    # Refused, or cut off partway: the server never had the
                    # whole dump, so it cannot have loaded it.
                    raise ApiError(
                        "The connection was lost after {} of {} bytes were sent. "
                        "The dump was not loaded.".format(body.sent, size))
                # Expected. The server restarts the moment it accepts the dump,
                # so it often drops the connection instead of answering. The
                # whole dump was handed over, so this is success, not failure.
                self.token = None
                return

        if response.status_code in (401, 403):
            raise AuthError(
                "The site refused the load (HTTP {}). This endpoint needs an "
                "administrator on a fresh session."
                .format(response.status_code))
        if not 200 <= response.status_code < 300:
            # Anything else the server rejects (a dump from another version, a
            # corrupt file, a redirect) comes back as another status, and
            # nothing restarts.
            raise ApiError(
                "The load request failed (HTTP {}). The dump was not applied."
                .format(response.status_code))

    def logout(self):
        """DELETE the session so the token is not left valid. Safe to call twice."""
        if not self.token:
            return
        self.session.delete(
            self.host + API + "/login/sessions/" + self.token, timeout=30)
        self.token = None
        self.session.headers.pop("Authorization", None)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def format_size(byte_count):
    """Render a byte count the way a person reads a backup file size."""
    if byte_count < 1024:
        return "{} bytes".format(byte_count)
    if byte_count < 1024 * 1024:
        return "{:.3f} KiB".format(byte_count / 1024.0)
    return "{:.3f} MiB".format(byte_count / (1024.0 * 1024.0))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    subparsers = parser.add_subparsers(dest="command")

    def add_common(sub):
        sub.add_argument("--host", help="https://<server>:7001")
        sub.add_argument("--user", help="a LOCAL administrator account")
        sub.add_argument("--password", help="that account's password")
        sub.add_argument("--env-file", default=".env",
                         help="path to the shared .env (default: ./.env)")
        sub.add_argument("--insecure", action="store_true",
                         help="skip TLS verification (normal for a lab server's "
                              "self-signed certificate)")

    backup = subparsers.add_parser("backup", help="dump the Site database to a file")
    add_common(backup)
    backup.add_argument("--out", default=None,
                        help="where to write the dump. Default: an auto-named "
                             "file in the current directory. Use - for stdout.")
    backup.add_argument("--force", action="store_true",
                        help="overwrite --out if it already exists")

    restore = subparsers.add_parser("restore", help="load a dump back into the site")
    restore.add_argument("dump", help="path to a dump produced by the backup command")
    add_common(restore)
    restore.add_argument("--yes", action="store_true",
                         help="confirm. The load replaces the whole site "
                              "configuration and restarts the server.")

    return parser


class ConfigError(Exception):
    """Configuration is missing, which is exit code 2 rather than a call failure."""


def _resolve_or_fail(args):
    config = resolve_config(args, load_env_file(args.env_file))
    missing = [name for name in ("host", "user", "password") if not config[name]]
    if missing:
        raise ConfigError(
            "missing configuration: {}. Set it with a flag, an NX_SERVER_* "
            "environment variable, or in {}."
            .format(", ".join(missing), args.env_file))
    return config


def _logout_quietly(client):
    """Log out on the way out of a failure, without hiding the failure itself."""
    try:
        client.logout()
    except requests.exceptions.RequestException:
        pass


def _run_backup(args):
    destination = args.out
    if destination and destination != "-" and os.path.isdir(destination):
        print("ERROR: {} is a directory. Give --out a file path.".format(destination),
              file=sys.stderr)
        return 1
    if destination and destination != "-" and os.path.exists(destination) \
            and not args.force:
        print("ERROR: Refusing to overwrite {}. Choose another --out, or pass "
              "--force.".format(destination), file=sys.stderr)
        return 1

    if destination == "-" and sys.stdout.isatty():
        print("ERROR: Refusing to write a binary dump to the terminal. Redirect "
              "it, for example --out - > site.db, or pipe it on.", file=sys.stderr)
        return 1

    config = _resolve_or_fail(args)
    if not destination:
        destination = default_output_name(config["host"])

    # With --out - the dump owns stdout, so progress goes to stderr and the pipe
    # stays clean.
    status = sys.stderr if destination == "-" else sys.stdout

    client = NxServerClient(config["host"], verify_tls=not args.insecure)
    # Log in here, immediately before the dump: the endpoint wants a fresh
    # session, so a token minted earlier is not good enough.
    client.login(config["user"], config["password"])
    print("Logged in to {} as {}\n".format(config["host"], config["user"]),
          file=status)

    print("Dumping Site database from {}".format(config["host"]), file=status)
    try:
        written = client.backup_database(destination, overwrite=args.force)
    except BaseException:
        # A failed dump must not leave an administrator session open behind it.
        _logout_quietly(client)
        raise
    print("  -> {}  ({})".format(destination, format_size(written)), file=status)

    # The dump is already on disk, so a logout that cannot be delivered is not a
    # reason to report failure.
    try:
        client.logout()
        print("Done. Logged out.", file=status)
    except requests.exceptions.RequestException:
        print("Done. The dump is written; the logout could not be delivered.",
              file=status)
    return 0


def _run_restore(args):
    if os.path.isdir(args.dump):
        print("ERROR: {} is a directory, not a dump.".format(args.dump),
              file=sys.stderr)
        return 1
    if not os.path.exists(args.dump):
        print("ERROR: No such dump: {}".format(args.dump), file=sys.stderr)
        return 1
    if os.path.getsize(args.dump) == 0:
        print("ERROR: {} is empty, so it is not a dump.".format(args.dump),
              file=sys.stderr)
        return 1
    if not args.yes:
        print("ERROR: Refusing to restore without --yes. Loading this dump "
              "replaces the whole site configuration and restarts the server.",
              file=sys.stderr)
        return 1

    config = _resolve_or_fail(args)

    client = NxServerClient(config["host"], verify_tls=not args.insecure)
    # Same reason as backup: log in immediately before the call, because the
    # endpoint wants a fresh session.
    client.login(config["user"], config["password"])
    print("Logged in to {} as {}\n".format(config["host"], config["user"]))

    print("Loading Site database into {}".format(config["host"]))
    print("  <- {}  ({})".format(
        args.dump, format_size(os.path.getsize(args.dump))))
    try:
        client.restore_database(args.dump)
    except BaseException:
        # Refused, or the outcome is unknown: the server did not visibly
        # restart, so the administrator session must not be left open.
        _logout_quietly(client)
        raise
    # No logout after success on purpose: the server restarts on accepting the
    # dump, so the session is already gone and a DELETE would only confuse.
    print("Accepted. The server is restarting; the session ends with it.")
    return 0


def main(argv=None):
    parser = build_arg_parser()
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help(sys.stderr)
        return 2

    try:
        if args.command == "backup":
            return _run_backup(args)
        return _run_restore(args)

    except ConfigError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 2
    except AuthError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 1
    except ApiError as error:
        print("ERROR: {}".format(error), file=sys.stderr)
        return 1
    except requests.exceptions.SSLError:
        print("ERROR: certificate verification failed. Local servers use a "
              "self-signed certificate, add --insecure.", file=sys.stderr)
        return 1
    except requests.exceptions.RequestException as error:
        print("ERROR: could not reach the server: {}".format(error),
              file=sys.stderr)
        return 1
    except OSError as error:
        # A local file problem: --out in a missing folder, no permission, a full
        # disk. Comes after RequestException, which is an OSError too.
        # A failed rename names the side file first and the destination second;
        # the destination is the one the user asked for.
        print("ERROR: could not use {}: {}".format(
            error.filename2 or error.filename or "the file", error.strerror or error),
            file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
