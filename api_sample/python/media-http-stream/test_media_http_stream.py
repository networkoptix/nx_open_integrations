# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for media_http_stream.py. No network, no account, no live camera.
The "video" is a fake byte stream; save_clip writes it through an injected sink
(and, in one test, a real temp file).

Run from this folder:  pytest -v
"""

import argparse
import os

import pytest

import media_http_stream as sample


# ---------------------------------------------------------------------------
# Fake HTTP plumbing
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text="",
                 headers=None, body=None):
        self.status_code = status_code
        self._json = json_data
        self.text = text
        self.headers = headers or {}
        # body: list of byte chunks, or None to mean "no body".
        self._body = body
        self.raw = None if body is None else object()
        self.closed = False

    @property
    def ok(self):
        return 200 <= self.status_code < 300

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json

    def iter_content(self, chunk_size=None):
        for chunk in (self._body or []):
            yield chunk

    def close(self):
        self.closed = True


class RecordedCall:
    def __init__(self, method, url, headers, json_body):
        self.method = method
        self.url = url
        self.headers = headers or {}
        self.json = json_body


class FakeSession:
    """Programmable fake session: a handler decides each response from the call."""

    def __init__(self, handler):
        self.verify = None
        self._handler = handler
        self.calls = []

    def _record(self, method, url, headers=None, json=None):
        call = RecordedCall(method, url, headers, json)
        idx = len(self.calls)
        self.calls.append(call)
        return self._handler(call, idx)

    def post(self, url, json=None, timeout=None):
        return self._record("POST", url, json=json)

    def get(self, url, headers=None, timeout=None, allow_redirects=None, stream=None):
        return self._record("GET", url, headers=headers)

    def delete(self, url, headers=None, timeout=None):
        return self._record("DELETE", url, headers=headers)


SITE = "11111111-2222-3333-4444-555555555555"
SERVER = "https://192.168.1.10:7001"


def direct_client(handler, **opts):
    session = FakeSession(handler)
    client = sample.NxMediaClient(sample.MODE_DIRECT, "admin", "pw",
                                  server_host=SERVER, session=session, **opts)
    return client, session


def cloud_client(handler, **opts):
    session = FakeSession(handler)
    client = sample.NxMediaClient(sample.MODE_CLOUD, "me@x.com", "pw",
                                  cloud_host="https://nxvms.com", site_id=SITE,
                                  session=session, **opts)
    return client, session


# ---------------------------------------------------------------------------
# Pure helpers: format, position, duration
# ---------------------------------------------------------------------------

def test_formats_matches_v4_spec_enum_exactly():
    assert sample.FORMATS == [
        "webm", "mpegts", "mpjpeg", "mp4", "mkv", "_3gp", "rtp", "flv", "f4v"]


def test_normalize_format_accepts_every_spec_format_and_strips_dot():
    for fmt in sample.FORMATS:
        assert sample.normalize_format(fmt) == fmt
        assert sample.normalize_format("." + fmt) == fmt
        assert sample.normalize_format(fmt.upper()) == fmt
    assert sample.normalize_format(None) == sample.DEFAULT_FORMAT


def test_normalize_format_rejects_unsupported_container():
    with pytest.raises(sample.ApiError):
        sample.normalize_format("avi")
    with pytest.raises(sample.ApiError):
        sample.normalize_format("m3u8")  # HLS is not on this endpoint


def test_parse_position_ms_blank_live_digits_epoch_iso_junk():
    assert sample.parse_position_ms("") is None
    assert sample.parse_position_ms(None) is None
    assert sample.parse_position_ms("1700000000000") == 1700000000000
    import datetime as dt
    expected = int(dt.datetime(2026, 6, 15, 12, 0, 0,
                               tzinfo=dt.timezone.utc).timestamp() * 1000)
    assert sample.parse_position_ms("2026-06-15T12:00:00Z") == expected
    with pytest.raises(sample.ApiError):
        sample.parse_position_ms("not-a-time")


def test_duration_to_ms_default_value_and_rejection():
    assert sample.duration_to_ms(None) == 10000
    assert sample.duration_to_ms("5") == 5000
    assert sample.duration_to_ms("2.5") == 2500
    with pytest.raises(sample.ApiError):
        sample.duration_to_ms("0")
    with pytest.raises(sample.ApiError):
        sample.duration_to_ms("-3")
    with pytest.raises(sample.ApiError):
        sample.duration_to_ms("abc")


def test_default_out_name_is_filesystem_safe_and_ends_with_format():
    import datetime as dt
    name = sample.default_out_name(
        "cam/01:02", "mp4", dt.datetime(2026, 6, 15, 12, 0, 0,
                                        tzinfo=dt.timezone.utc))
    assert name.startswith("clip-cam_01_02-")
    assert name.endswith(".mp4")
    assert ":" not in name
    assert "/" not in name


# ---------------------------------------------------------------------------
# CLI parsing (argparse: space + equals forms, --env-file, unknown rejected)
# ---------------------------------------------------------------------------

def test_parse_args_reads_space_and_equals_flags_and_the_boolean():
    a = sample.build_arg_parser().parse_args([
        "--mode", "cloud",
        "--site-id=" + SITE,
        "--device-id", "cam1",
        "--format=mkv",
        "--pos", "2026-06-15T12:00:00Z",
        "--duration", "8",
        "--out=/tmp/clip.mkv",
        "--insecure",
    ])
    assert a.mode == "cloud"
    assert a.site_id == SITE
    assert a.device_id == "cam1"
    assert a.format == "mkv"
    assert a.pos == "2026-06-15T12:00:00Z"
    assert a.duration == "8"
    assert a.out == "/tmp/clip.mkv"
    assert a.insecure is True


def test_parse_args_accepts_env_file_flag():
    a = sample.build_arg_parser().parse_args(["--env-file", "x.env"])
    assert a.env_file == "x.env"


def test_parse_args_rejects_unknown_flag():
    with pytest.raises(SystemExit):
        sample.build_arg_parser().parse_args(["--dotenv", "x.env"])


# ---------------------------------------------------------------------------
# resolve_config + missing_fields (mode-aware env var selection)
# ---------------------------------------------------------------------------

def _args(**kw):
    defaults = dict(mode=None, server_host=None, cloud_host=None, user=None,
                    password=None, site_id=None, mfa_code=None, device_id=None,
                    format=None, pos=None, duration=None, out=None)
    defaults.update(kw)
    return argparse.Namespace(**defaults)


def test_resolve_config_picks_server_vars_in_direct_mode(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", SERVER)
    monkeypatch.setenv("NX_SERVER_USER", "admin")
    monkeypatch.setenv("NX_SERVER_PASSWORD", "pw")
    monkeypatch.setenv("NX_CLOUD_USER", "should-not-win")
    cfg = sample.resolve_config(_args(mode="direct", device_id="cam1"), {})
    assert cfg["mode"] == sample.MODE_DIRECT
    assert cfg["server_host"] == SERVER
    assert cfg["user"] == "admin"
    assert cfg["format"] == sample.DEFAULT_FORMAT
    assert cfg["position_ms"] is None  # live
    assert cfg["duration_ms"] == 10000  # default
    assert sample.missing_fields(cfg) == []


def test_resolve_config_picks_cloud_vars_and_defaults_cloud_host(monkeypatch):
    monkeypatch.setenv("NX_CLOUD_USER", "me@x.com")
    monkeypatch.setenv("NX_CLOUD_PASSWORD", "pw")
    cfg = sample.resolve_config(
        _args(mode="cloud", device_id="cam1", site_id=SITE), {})
    assert cfg["mode"] == sample.MODE_CLOUD
    assert cfg["cloud_host"] == "https://nxvms.com"
    assert cfg["user"] == "me@x.com"
    assert sample.missing_fields(cfg) == []


def test_missing_fields_reports_what_each_mode_needs(monkeypatch):
    for var in ("NX_SERVER_HOST", "NX_SERVER_USER", "NX_SERVER_PASSWORD",
                "NX_CLOUD_USER", "NX_CLOUD_PASSWORD", "NX_CLOUD_SITE_ID",
                "NX_DEVICE_ID"):
        monkeypatch.delenv(var, raising=False)
    direct = sample.resolve_config(_args(mode="direct"), {})
    assert sorted(sample.missing_fields(direct)) == [
        "device_id", "password", "server_host", "user"]
    cloud = sample.resolve_config(_args(mode="cloud"), {})
    assert sorted(sample.missing_fields(cloud)) == [
        "device_id", "password", "site_id", "user"]


def test_cli_flags_beat_env_vars(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://env:7001")
    cfg = sample.resolve_config(
        _args(mode="direct", server_host="https://flag:7001",
              device_id="cam1", user="u", password="p"), {})
    assert cfg["server_host"] == "https://flag:7001"


def test_env_var_beats_env_file(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://env:7001")
    cfg = sample.resolve_config(
        _args(mode="direct"), {"NX_SERVER_HOST": "https://file:7001"})
    assert cfg["server_host"] == "https://env:7001"


# ---------------------------------------------------------------------------
# login: direct + cloud
# ---------------------------------------------------------------------------

def test_direct_login_posts_to_server_and_stores_token():
    client, session = direct_client(
        lambda call, idx: FakeResponse(json_data={"token": "srv-tok"}))
    tok = client.login()
    assert tok == "srv-tok"
    assert session.calls[0].url == f"{SERVER}/rest/v4/login/sessions"
    assert session.calls[0].json["setCookie"] is False


def test_direct_login_401_raises_autherror():
    client, _ = direct_client(
        lambda call, idx: FakeResponse(status_code=401, text="no"))
    with pytest.raises(sample.AuthError):
        client.login()


def test_cloud_login_sends_scope_and_mfa_stores_access_token():
    client, session = cloud_client(
        lambda call, idx: FakeResponse(json_data={"access_token": "nxcdb-t"}),
        mfa_code="123456")
    tok = client.login()
    assert tok == "nxcdb-t"
    assert session.calls[0].url == "https://nxvms.com/cdb/oauth2/token"
    assert session.calls[0].json["scope"] == f"cloudSystemId={SITE}"
    assert session.calls[0].json["mfaCode"] == "123456"
    assert session.calls[0].json["client_id"] == "3rdParty"


def test_cloud_login_403_raises_autherror():
    client, _ = cloud_client(
        lambda call, idx: FakeResponse(status_code=403, text="no"))
    with pytest.raises(sample.AuthError):
        client.login()


def test_login_response_without_token_raises_apierror():
    client, _ = direct_client(lambda call, idx: FakeResponse(json_data={}))
    with pytest.raises(sample.ApiError):
        client.login()


# ---------------------------------------------------------------------------
# build_media_url: live vs archive, format, encoding, no token leak
# ---------------------------------------------------------------------------

def test_build_media_url_direct_live_omits_position_and_hits_server():
    client, _ = direct_client(lambda call, idx: FakeResponse())
    url = client.build_media_url("cam 1", "webm", duration_ms=10000)
    assert url.startswith(f"{SERVER}/rest/v4/devices/cam%201/media.webm?")
    assert "durationMs=10000" in url
    assert "positionMs" not in url


def test_build_media_url_cloud_archive_includes_position_and_hits_relay():
    client, _ = cloud_client(lambda call, idx: FakeResponse())
    url = client.build_media_url("cam1", "mkv",
                                 position_ms=1700000000000, duration_ms=5000)
    assert url.startswith(
        f"https://{SITE}.relay.vmsproxy.com/rest/v4/devices/cam1/media.mkv?")
    assert "positionMs=1700000000000" in url
    assert "durationMs=5000" in url


def test_build_media_url_never_leaks_the_token():
    client, _ = direct_client(lambda call, idx: FakeResponse())
    client.token = "secret-tok"
    url = client.build_media_url("cam1", "mp4")
    assert "secret-tok" not in url
    assert "auth=" not in url.lower()


def test_build_media_url_requires_device_id():
    client, _ = direct_client(lambda call, idx: FakeResponse())
    with pytest.raises(sample.ApiError):
        client.build_media_url("", "webm")


# ---------------------------------------------------------------------------
# save_clip: streaming, relay 307, error paths
# ---------------------------------------------------------------------------

CHUNKS = [b"\x01\x02\x03\x04", b"\x05\x06"]  # 6 bytes


def counting_sink(chunks):
    """Drain the stream and return the byte count (no disk)."""
    return sum(len(c) for c in chunks)


def test_save_clip_streams_body_to_sink_and_sends_bearer():
    seen = {}

    def handler(call, idx):
        seen["auth"] = call.headers.get("Authorization")
        return FakeResponse(body=CHUNKS)

    client, _ = direct_client(handler)
    client.token = "srv-tok"
    n = client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)
    assert n == 6
    assert seen["auth"] == "Bearer srv-tok"


def test_save_clip_follows_relay_307_and_reattaches_bearer_on_new_host():
    relay = f"https://{SITE}.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm"
    redirected = "https://node-7.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm"

    def handler(call, idx):
        if idx == 0:
            assert call.url.startswith(relay)
            return FakeResponse(status_code=307, headers={"Location": redirected})
        assert call.url.split("?")[0] == redirected
        return FakeResponse(body=CHUNKS)

    client, session = cloud_client(handler)
    client.token = "nxcdb-t"
    n = client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)
    assert n == 6
    # Bearer present on BOTH hops.
    assert session.calls[0].headers["Authorization"] == "Bearer nxcdb-t"
    assert session.calls[1].headers["Authorization"] == "Bearer nxcdb-t"


def test_save_clip_raises_autherror_on_401():
    client, _ = direct_client(lambda call, idx: FakeResponse(status_code=401))
    client.token = "t"
    with pytest.raises(sample.AuthError):
        client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)


def test_save_clip_raises_apierror_on_403():
    client, _ = direct_client(lambda call, idx: FakeResponse(status_code=403))
    client.token = "t"
    with pytest.raises(sample.AuthError):
        client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)


def test_save_clip_raises_apierror_on_non_ok_status():
    client, _ = direct_client(
        lambda call, idx: FakeResponse(status_code=404, text="no such device"))
    client.token = "t"
    with pytest.raises(sample.ApiError):
        client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)


def test_save_clip_raises_apierror_when_no_body():
    client, _ = direct_client(lambda call, idx: FakeResponse(body=None))
    client.token = "t"
    with pytest.raises(sample.ApiError):
        client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)


def test_save_clip_refuses_before_login():
    client, _ = direct_client(lambda call, idx: FakeResponse(body=CHUNKS))
    with pytest.raises(sample.ApiError):
        client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)


def test_too_many_redirects_raises_apierror():
    client, _ = cloud_client(
        lambda call, idx: FakeResponse(status_code=307,
                                       headers={"Location": call.url + "/x"}))
    client.token = "t"
    with pytest.raises(sample.ApiError):
        client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)


def test_save_clip_safety_stop_aborts_endless_stream(monkeypatch):
    # The deadline is computed at t=0; the clock then jumps far past it, so the
    # first wall-clock check inside the chunk loop stops reading.
    clock = {"t": 0}

    def fake_now():
        # First call (deadline calc) sees 0; subsequent calls see the future.
        value = clock["t"]
        clock["t"] = 10**12
        return value

    monkeypatch.setattr(sample, "_now_ms", fake_now)

    def endless():
        while True:
            yield b"x" * 4

    def handler(call, idx):
        resp = FakeResponse(body=None)
        resp.raw = object()
        resp.iter_content = lambda chunk_size=None: endless()
        return resp

    client, _ = direct_client(handler)
    client.token = "t"
    n = client.save_clip(counting_sink, "cam1", "webm", duration_ms=1000)
    assert n == 0  # stopped immediately, never hung


# ---------------------------------------------------------------------------
# file_sink: the real disk path (still offline)
# ---------------------------------------------------------------------------

def test_file_sink_writes_exact_bytes_to_a_file(tmp_path):
    out = tmp_path / "clip.webm"
    client, _ = direct_client(lambda call, idx: FakeResponse(body=CHUNKS))
    client.token = "t"
    n = client.save_clip(sample.file_sink(str(out)), "cam1", "webm",
                         duration_ms=1000)
    assert n == 6
    assert out.read_bytes() == b"\x01\x02\x03\x04\x05\x06"


# ---------------------------------------------------------------------------
# logout
# ---------------------------------------------------------------------------

def test_direct_logout_deletes_the_server_session():
    client, session = direct_client(
        lambda call, idx: FakeResponse(status_code=204))
    client.token = "srv-tok"
    client.logout()
    assert session.calls[0].method == "DELETE"
    assert session.calls[0].url == f"{SERVER}/rest/v4/login/sessions/srv-tok"
    assert client.token is None


def test_cloud_logout_deletes_the_token_on_cloud():
    client, session = cloud_client(
        lambda call, idx: FakeResponse(status_code=204))
    client.token = "nxcdb-t"
    client.logout()
    assert session.calls[0].url == "https://nxvms.com/cdb/oauth2/token/nxcdb-t"
    assert client.token is None


def test_logout_without_token_is_a_noop():
    client, session = direct_client(lambda call, idx: FakeResponse())
    client.logout()
    assert session.calls == []
