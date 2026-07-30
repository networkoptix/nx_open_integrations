#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Create a VIRTUAL camera on an Nx VMS server and UPLOAD a local video file into
its archive as recorded footage. A virtual camera has no real RTSP source; you
push it pre-recorded media and the server ingests it as if it had been captured
at the given time.

Python sample on the latest /rest/v4 API. Uses `requests` and reads the file in
chunks, so a large clip is never slurped into memory all at once.

Auth is DIRECT to ONE server with a LOCAL server account, exactly like
../rest-list-cameras:
  NX_SERVER_HOST / NX_SERVER_USER / NX_SERVER_PASSWORD

THE VIRTUAL-CAMERA UPLOAD FLOW (from docs/v4_api_spec.json):

  1. Log in:    POST   {server}/rest/v4/login/sessions  {username, password}
                  -> {"token": ...}
  2. Create:    POST   {server}/rest/v4/devices/*/virtual  {"name": ...}
                  -> the new device (read its "id")          [skip with --device-id]
  3. Lock:      PATCH  {server}/rest/v4/devices/{id}/virtual/lock  {"ttlMs": ...}
                  -> token at lockInfo.token ({id, lockInfo:{token, ...}})
  4. Create upload: POST {server}/rest/v4/devices/{id}/virtual/uploads
                  {"items": [{filename, sizeB, md5, startTimeMs, chunkSizeB}]}
                  -> per-item info incl. the chunkSizeB the server wants
                  (startTimeMs is declared HERE, not at a consume step)
  5. Upload bytes:  PUT  {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=<n>
                  raw chunk bytes, Content-Type: application/octet-stream
  6. Status:    GET    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}
                  -> the import auto-starts once all chunks arrive; this reports it
                  (PATCH .../virtual/consume is DEPRECATED -- not used)
  7. Release:   PATCH  {server}/rest/v4/devices/{id}/virtual/release  {"token": <lock>}
                  (always run, even on error, so the lock is freed)
  + Log out:    DELETE {server}/rest/v4/login/sessions/<token>

The `/*/` in step 2 is the current-server wildcard -- it is part of the path, not
a placeholder. The uploadId used in steps 5/6 is the server-returned uploadId, or
the file's name if none is echoed.

Connecting to the server:
  --server-host is the server, e.g. https://192.168.1.10:7001 (https + port).
  Local servers usually present a self-signed certificate, so for a lab server
  you will typically need --insecure.

Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
"""

import argparse
import base64
import datetime as dt
import hashlib
import os
import re
import sys

import requests


# API version path segment. v4 is the latest Nx REST API.
API = "/rest/v4"

# Default lock time-to-live (seconds) and requested upload chunk size (bytes).
DEFAULT_TTL_S = 300
DEFAULT_CHUNK_SIZE = 1024 * 1024  # 1 MiB
# Size of the reads used while hashing the file (bytes).
HASH_READ_SIZE = 1024 * 1024


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class AuthError(Exception):
    """Raised when the server rejects the credentials or token."""


class ApiError(Exception):
    """Raised for any other unexpected API/network failure."""


# ---------------------------------------------------------------------------
# Pure helpers (no I/O over the network = easy to test)
# ---------------------------------------------------------------------------

_DIGITS_RE = re.compile(r"^\d+$")


def parse_start_time_ms(value, now=None):
    """Turn the --start-time value into epoch milliseconds.

    Accepts an ISO 8601 string (2026-06-15T12:00:00Z) or a raw epoch-ms number.
    Empty/blank/None -> "now". Naive times are treated as UTC.
    """
    text = "" if value is None else str(value).strip()
    if not text:
        now = now or dt.datetime.now(dt.timezone.utc)
        return int(now.timestamp() * 1000)
    if _DIGITS_RE.match(text):
        return int(text)  # already epoch ms
    try:
        when = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ApiError(
            f'Could not parse --start-time "{text}". '
            "Use ISO time or epoch ms.") from exc
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.timezone.utc)
    return int(when.timestamp() * 1000)


def file_md5_base64(path, read_size=HASH_READ_SIZE):
    """Base64-encoded MD5 of the full file content (what the API expects)."""
    digest = hashlib.md5()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(read_size), b""):
            digest.update(block)
    return base64.b64encode(digest.digest()).decode("ascii")


def chunk_plan(total_size, chunk_size):
    """Plan how a file of `total_size` bytes splits into `chunk_size` pieces.

    Returns a list of (index, offset, length) tuples, zero-based, with the last
    piece holding the remainder. A zero-byte file yields a single empty chunk so
    the server still sees one PUT.
    """
    if chunk_size <= 0:
        raise ApiError("--chunk-size must be a positive number of bytes.")
    if total_size <= 0:
        return [(0, 0, 0)]
    plan = []
    index = 0
    offset = 0
    while offset < total_size:
        length = min(chunk_size, total_size - offset)
        plan.append((index, offset, length))
        index += 1
        offset += length
    return plan


def iter_file_chunks(path, chunk_size):
    """Yield (index, bytes) for each chunk of the file, reading lazily."""
    total_size = os.path.getsize(path)
    with open(path, "rb") as handle:
        for index, offset, length in chunk_plan(total_size, chunk_size):
            handle.seek(offset)
            yield index, handle.read(length)


def build_items_payload(filename, size_b, md5_b64, start_time_ms, chunk_size_b,
                        duration_ms=None):
    """Build the {"items": [...]} body for the create-upload request.

    startTimeMs is declared HERE (at create-upload), not at a separate consume
    step: the modern v4 flow drops the deprecated `.../virtual/consume` call and
    starts the import automatically once all chunks reach `.../virtual/uploads/
    {uploadId}`.

    durationMs is OPTIONAL: when known, the server uses it to reserve the
    archive period; when omitted, the server tries to derive the duration from
    the video file's own metadata. If that metadata is missing or unreadable
    and no durationMs was sent, the archive period comes back as zero and the
    footage will not appear on the timeline (see the README's troubleshooting
    section), so pass --duration-ms if you know the clip length.
    """
    item = {
        "filename": filename,
        "sizeB": size_b,
        "md5": md5_b64,
        "startTimeMs": start_time_ms,
        "chunkSizeB": chunk_size_b,
    }
    if duration_ms is not None and duration_ms > 0:
        item["durationMs"] = duration_ms
    return {"items": [item]}


def _unwrap(data):
    """Some Nx versions wrap a reply in {"reply": ...}. Unwrap defensively."""
    if isinstance(data, dict) and "reply" in data:
        return data["reply"]
    return data


def parse_device_id(data):
    """Pull the new device id from a create-virtual response, defensively.

    The reply may be a bare object, a {"reply": ...} envelope, or a single-item
    list. Return the "id" field.
    """
    data = _unwrap(data)
    if isinstance(data, list):
        data = data[0] if data else {}
    if isinstance(data, dict):
        device_id = data.get("id")
        if device_id:
            return device_id
    raise ApiError("Create-virtual response did not contain a device id.")


def parse_lock_token(data):
    """Pull the lock token from a lock response, defensively.

    The v4 lock reply is shaped { "id": ..., "lockInfo": { "token": ..., ... } },
    so the token lives under "lockInfo". Older/edge shapes may put it at the top
    level, so we check both.
    """
    data = _unwrap(data)
    if isinstance(data, dict):
        lock_info = data.get("lockInfo")
        if isinstance(lock_info, dict) and lock_info.get("token"):
            return lock_info["token"]
        token = data.get("token")
        if token:
            return token
    raise ApiError("Lock response did not contain a token.")


def parse_upload_item(data, requested_chunk_size, fallback_upload_id):
    """Read the create-upload reply -> (upload_id, chunk_size_b), defensively.

    Uses the server's returned chunkSizeB when present, else the requested size.
    Uses the server's returned uploadId when present, else the filename (the
    consume body documents uploadId as the previously uploaded file's name).
    """
    data = _unwrap(data)
    if isinstance(data, dict) and isinstance(data.get("items"), list):
        items = data["items"]
    elif isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = [data]
    else:
        items = []
    item = items[0] if items else {}
    if not isinstance(item, dict):
        item = {}
    upload_id = item.get("uploadId") or fallback_upload_id
    chunk_size_b = item.get("chunkSizeB") or requested_chunk_size
    try:
        chunk_size_b = int(chunk_size_b)
    except (TypeError, ValueError):
        chunk_size_b = requested_chunk_size
    if chunk_size_b <= 0:
        chunk_size_b = requested_chunk_size
    return upload_id, chunk_size_b


# ---------------------------------------------------------------------------
# Configuration (CLI > env > .env). Server vars are NX_SERVER_*.
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
    """CLI flag > OS environment variable > .env file."""

    def pick(cli_value, env_key):
        if cli_value is not None:
            return cli_value
        if os.environ.get(env_key):
            return os.environ[env_key]
        return env_file_values.get(env_key)

    return {
        "host": pick(cli_args.server_host, "NX_SERVER_HOST"),
        "user": pick(cli_args.user, "NX_SERVER_USER"),
        "password": pick(cli_args.password, "NX_SERVER_PASSWORD"),
    }


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------

class NxVirtualCameraClient:
    """Creates a virtual device on a single VMS server and uploads footage."""

    def __init__(self, host, user, password, verify_tls=True, session=None,
                 timeout=30):
        self.host = (host or "").rstrip("/")
        self.user = user
        self.password = password
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.verify = verify_tls
        if not verify_tls:
            # We deliberately skipped TLS verification (--insecure, for lab
            # servers with self-signed certs), so silence urllib3's repeated
            # InsecureRequestWarning instead of printing it on every request.
            try:
                import urllib3
                urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            except Exception:
                pass
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

    def _auth_header(self, extra=None):
        if not self.token:
            raise ApiError("Not logged in. Call login() first.")
        headers = {"Authorization": f"Bearer {self.token}"}
        if extra:
            headers.update(extra)
        return headers

    def _post(self, url, body, what):
        try:
            response = self.session.post(
                url, json=body, headers=self._auth_header(), timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        return self._check(response, what)

    def _patch(self, url, body, what):
        try:
            response = self.session.patch(
                url, json=body, headers=self._auth_header(), timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        return self._check(response, what)

    # -- 1. login / logout ---------------------------------------------------

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

    def logout(self):
        """DELETE the session so the token cannot be reused. Best-effort."""
        if not self.token:
            return
        url = f"{self.host}{API}/login/sessions/{self.token}"
        try:
            self.session.delete(url, headers=self._auth_header(), timeout=self.timeout)
        except requests.exceptions.RequestException:
            pass  # logout is cleanup; never let it crash the program
        finally:
            self.token = None

    # -- 2. create virtual device -------------------------------------------

    def create_virtual_device(self, name):
        """POST {server}/rest/v4/devices/*/virtual {"name": ...} -> device id.

        The `*` is the current-server wildcard; it is part of the path.
        """
        url = f"{self.host}{API}/devices/*/virtual"
        data = self._post(url, {"name": name}, "Create virtual device")
        return parse_device_id(data)

    # -- 3. lock -------------------------------------------------------------

    def lock_device(self, device_id, ttl_ms):
        """PATCH .../virtual/lock {"ttlMs": ...} -> the lock token."""
        url = f"{self.host}{API}/devices/{device_id}/virtual/lock"
        data = self._patch(url, {"ttlMs": ttl_ms}, "Lock virtual device")
        return parse_lock_token(data)

    # -- 4. create upload ----------------------------------------------------

    def create_upload(self, device_id, filename, size_b, md5_b64,
                      start_time_ms, requested_chunk_size, duration_ms=None):
        """POST .../virtual/uploads -> (upload_id, server chunk size in bytes)."""
        url = f"{self.host}{API}/devices/{device_id}/virtual/uploads"
        body = build_items_payload(
            filename, size_b, md5_b64, start_time_ms, requested_chunk_size,
            duration_ms)
        data = self._post(url, body, "Create upload")
        return parse_upload_item(data, requested_chunk_size, filename)

    # -- 5. upload one chunk -------------------------------------------------

    def upload_chunk(self, device_id, upload_id, index, data_bytes):
        """PUT raw chunk bytes at ?chunk=<index> with octet-stream content type."""
        from urllib.parse import quote
        url = (f"{self.host}{API}/devices/{device_id}/virtual/uploads/"
               f"{quote(str(upload_id), safe='')}")
        try:
            response = self.session.put(
                url, params={"chunk": index}, data=data_bytes,
                headers=self._auth_header({"Content-Type": "application/octet-stream"}),
                timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        if response.status_code in (401, 403):
            raise AuthError(
                f"Chunk upload unauthorized (HTTP {response.status_code}).")
        if not response.ok:
            raise ApiError(
                f"Chunk {index} upload failed: HTTP {response.status_code} "
                f"{response.text[:200]}")
        return response

    # -- 6. upload status ----------------------------------------------------

    def upload_status(self, device_id, upload_id):
        """GET .../virtual/uploads/{uploadId} -> the upload/consume status.

        There is NO separate consume call: `PATCH .../virtual/consume` is
        deprecated. Completing the chunk PUTs to `.../virtual/uploads/{uploadId}`
        starts the import automatically (using the startTimeMs given at create).
        This GET (the recommended path-form status endpoint) reports progress.
        """
        from urllib.parse import quote
        url = (f"{self.host}{API}/devices/{device_id}/virtual/uploads/"
               f"{quote(str(upload_id), safe='')}")
        try:
            response = self.session.get(
                url, headers=self._auth_header(), timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise ApiError(f"Could not reach {url}: {exc}") from exc
        if response.status_code in (401, 403):
            raise AuthError(f"Upload status unauthorized (HTTP {response.status_code}).")
        if not response.ok:
            raise ApiError(
                f"Upload status failed: HTTP {response.status_code} {response.text[:200]}")
        try:
            return response.json()
        except ValueError:
            return {}

    # -- 7. release ----------------------------------------------------------

    def release(self, device_id, lock_token):
        """PATCH .../virtual/release {"token": ...} -> free the lock."""
        url = f"{self.host}{API}/devices/{device_id}/virtual/release"
        return self._patch(url, {"token": lock_token}, "Release lock")


# ---------------------------------------------------------------------------
# Orchestration (steps 2-7) -- separated so it is easy to test end-to-end.
# ---------------------------------------------------------------------------

def upload_video(client, file_path, name, start_time_ms, ttl_ms,
                 requested_chunk_size, duration_ms=None, device_id=None,
                 on_progress=None):
    """Run the full create -> lock -> create-upload -> chunk PUTs -> status ->
    release sequence.

    There is NO explicit consume step: `PATCH .../virtual/consume` is deprecated,
    and the import starts automatically once all chunks reach the
    `.../virtual/uploads/{uploadId}` endpoint (footage placement comes from the
    startTimeMs given at create-upload). We GET that endpoint to report status.

    Returns a dict summarising what happened. The lock is always released in a
    finally block, even if a step fails.
    """
    def note(message):
        if on_progress:
            on_progress(message)

    size_b = os.path.getsize(file_path)
    md5_b64 = file_md5_base64(file_path)
    filename = os.path.basename(file_path)

    if device_id is None:
        device_id = client.create_virtual_device(name)
        note(f"Created virtual device {device_id}")
    else:
        note(f"Using existing virtual device {device_id}")

    lock_token = client.lock_device(device_id, ttl_ms)
    note("Lock acquired")
    status = None
    try:
        upload_id, server_chunk_size = client.create_upload(
            device_id, filename, size_b, md5_b64, start_time_ms,
            requested_chunk_size, duration_ms)

        chunk_count = 0
        for index, data_bytes in iter_file_chunks(file_path, server_chunk_size):
            client.upload_chunk(device_id, upload_id, index, data_bytes)
            chunk_count += 1
        note(f"{chunk_count} chunk(s) uploaded ({server_chunk_size} B each)")

        # No consume call (deprecated): the import auto-starts on completion.
        status = client.upload_status(device_id, upload_id)
        note(f"Upload complete; server is importing footage at {start_time_ms}ms")
    finally:
        client.release(device_id, lock_token)
        note("Released")

    return {
        "device_id": device_id,
        "upload_id": upload_id,
        "chunk_count": chunk_count,
        "chunk_size_b": server_chunk_size,
        "size_b": size_b,
        "start_time_ms": start_time_ms,
        "status": status,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_arg_parser():
    parser = argparse.ArgumentParser(
        description="Create an Nx virtual camera and upload a video file into "
                    "its archive.")
    parser.add_argument("--file", default=None, required=True,
                        help="Local video file to upload (required)")
    parser.add_argument("--name", default="Virtual Camera",
                        help="Name for the new virtual device (default 'Virtual Camera')")
    parser.add_argument("--device-id", default=None,
                        help="Upload to an EXISTING virtual device id (skips create)")
    parser.add_argument("--start-time", default=None,
                        help="Archive start (ISO 8601 or epoch ms); default now")
    parser.add_argument("--duration-ms", default=None, type=int,
                        help="Clip length in milliseconds (optional; if omitted "
                             "the server derives it from the file's own metadata)")
    parser.add_argument("--ttl", default=None, type=int,
                        help=f"Lock TTL in seconds (default {DEFAULT_TTL_S})")
    parser.add_argument("--chunk-size", default=None, type=int,
                        help=f"Requested chunk size in bytes (default {DEFAULT_CHUNK_SIZE})")
    parser.add_argument("--server-host", default=None,
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

    if not os.path.isfile(args.file):
        print(f"File not found: {args.file}", file=sys.stderr)
        return 2

    try:
        start_time_ms = parse_start_time_ms(args.start_time)
    except ApiError as exc:
        print(f"{exc}", file=sys.stderr)
        return 2

    ttl_ms = (DEFAULT_TTL_S if args.ttl is None else args.ttl) * 1000
    chunk_size = DEFAULT_CHUNK_SIZE if args.chunk_size is None else args.chunk_size
    if chunk_size <= 0:
        print("--chunk-size must be a positive number of bytes.", file=sys.stderr)
        return 2

    if args.duration_ms is not None and args.duration_ms <= 0:
        print("--duration-ms must be a positive number of milliseconds.", file=sys.stderr)
        return 2

    client = NxVirtualCameraClient(
        host=config["host"], user=config["user"], password=config["password"],
        verify_tls=not args.insecure,
    )

    try:
        client.login()
        print(f"Logged in to {config['host']} as {config['user']}")
        result = upload_video(
            client, args.file, args.name, start_time_ms, ttl_ms,
            chunk_size, duration_ms=args.duration_ms, device_id=args.device_id,
            on_progress=lambda m: print(f"  {m}"))
        print(f"Done. Uploaded {result['size_b']} bytes to device "
              f"{result['device_id']} as archive starting {start_time_ms}ms.")
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
