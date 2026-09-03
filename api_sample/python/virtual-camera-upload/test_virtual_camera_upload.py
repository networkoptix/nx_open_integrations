# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for virtual_camera_upload.py. No network, no server needed.

Run from this folder:  pytest -v
"""

import argparse
import base64
import hashlib

import pytest

import virtual_camera_upload as sample


# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code=200, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text

    @property
    def ok(self):
        return self.status_code < 400

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class RecordingSession:
    """Records the ordered sequence of calls and serves queued responses.

    Each verb (post/patch/put/delete/get) pops from its own response queue (or
    a single shared default). Every call is appended to `calls` as a dict so a
    test can assert the exact method + URL + body sequence.
    """

    def __init__(self, post=None, patch=None, put=None, delete=None, get=None):
        self.verify = None
        self.calls = []
        self._queues = {
            "post": list(post or []),
            "patch": list(patch or []),
            "put": list(put or []),
            "delete": list(delete or []),
            "get": list(get or []),
        }

    def _next(self, verb):
        queue = self._queues[verb]
        if not queue:
            return FakeResponse(200, {})
        # Reuse the last response if the queue runs dry (handy for many PUTs
        # or many extend polls).
        return queue.pop(0) if len(queue) > 1 else queue[0]

    def post(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"method": "POST", "url": url, "json": json,
                           "headers": headers})
        return self._next("post")

    def patch(self, url, json=None, headers=None, timeout=None):
        self.calls.append({"method": "PATCH", "url": url, "json": json,
                           "headers": headers})
        return self._next("patch")

    def put(self, url, params=None, data=None, headers=None, timeout=None):
        self.calls.append({"method": "PUT", "url": url, "params": params,
                           "data": data, "headers": headers})
        return self._next("put")

    def delete(self, url, headers=None, timeout=None):
        self.calls.append({"method": "DELETE", "url": url, "headers": headers})
        return self._next("delete")

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append({"method": "GET", "url": url, "params": params,
                           "headers": headers})
        return self._next("get")


HOST = "https://srv:7001"


def make_client(session):
    client = sample.NxVirtualCameraClient(HOST, "admin", "pw", session=session)
    client.token = "tok"
    return client


class FakeClock:
    """A controllable stand-in for time.monotonic()/time.sleep() so
    wait_for_consume can be tested without any real waiting."""

    def __init__(self, start=0.0):
        self.now = start
        self.sleeps = []

    def time_fn(self):
        return self.now

    def sleep_fn(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


# ---------------------------------------------------------------------------
# file_md5_base64
# ---------------------------------------------------------------------------

def test_file_md5_base64(tmp_path):
    data = b"hello virtual camera" * 100
    path = tmp_path / "clip.mkv"
    path.write_bytes(data)
    expected = base64.b64encode(hashlib.md5(data).digest()).decode("ascii")
    assert sample.file_md5_base64(str(path)) == expected


def test_file_md5_base64_reads_in_small_blocks(tmp_path):
    # Same digest whether the read size spans the file or not.
    data = b"abcdefghij" * 50
    path = tmp_path / "clip.mp4"
    path.write_bytes(data)
    expected = base64.b64encode(hashlib.md5(data).digest()).decode("ascii")
    assert sample.file_md5_base64(str(path), read_size=7) == expected


# ---------------------------------------------------------------------------
# chunk_plan
# ---------------------------------------------------------------------------

def test_chunk_plan_partial_last_chunk():
    # 2.5 * chunk -> 3 chunks, last one a half-size remainder.
    plan = sample.chunk_plan(total_size=250, chunk_size=100)
    assert plan == [(0, 0, 100), (1, 100, 100), (2, 200, 50)]


def test_chunk_plan_exact_multiple():
    plan = sample.chunk_plan(total_size=300, chunk_size=100)
    assert plan == [(0, 0, 100), (1, 100, 100), (2, 200, 100)]


def test_chunk_plan_smaller_than_one_chunk():
    plan = sample.chunk_plan(total_size=40, chunk_size=100)
    assert plan == [(0, 0, 40)]


def test_chunk_plan_zero_byte_file_is_one_empty_chunk():
    assert sample.chunk_plan(total_size=0, chunk_size=100) == [(0, 0, 0)]


def test_chunk_plan_rejects_nonpositive_chunk_size():
    with pytest.raises(sample.ApiError):
        sample.chunk_plan(total_size=100, chunk_size=0)


def test_iter_file_chunks(tmp_path):
    path = tmp_path / "clip.bin"
    path.write_bytes(bytes(range(256)) * 2)  # 512 bytes
    chunks = list(sample.iter_file_chunks(str(path), chunk_size=200))
    assert [i for i, _ in chunks] == [0, 1, 2]
    assert [len(b) for _, b in chunks] == [200, 200, 112]
    assert b"".join(b for _, b in chunks) == path.read_bytes()


# ---------------------------------------------------------------------------
# parse_start_time_ms
# ---------------------------------------------------------------------------

def test_parse_start_time_epoch_ms():
    assert sample.parse_start_time_ms("1700000000000") == 1700000000000


def test_parse_start_time_iso_utc():
    # 2021-01-01T00:00:00Z == 1609459200000 ms.
    assert sample.parse_start_time_ms("2021-01-01T00:00:00Z") == 1609459200000


def test_parse_start_time_blank_defaults_to_now():
    import datetime as dt
    fixed = dt.datetime(2026, 6, 16, tzinfo=dt.timezone.utc)
    assert sample.parse_start_time_ms("", now=fixed) == int(fixed.timestamp() * 1000)


def test_parse_start_time_bad_value_raises():
    with pytest.raises(sample.ApiError):
        sample.parse_start_time_ms("not-a-time")


# ---------------------------------------------------------------------------
# build_items_payload
# ---------------------------------------------------------------------------

def test_build_items_payload_omits_duration_when_not_provided():
    body = sample.build_items_payload(
        "clip.mkv", size_b=1234, md5_b64="bWQ1", start_time_ms=1700000000000,
        chunk_size_b=1048576)
    assert body == {"items": [{
        "filename": "clip.mkv",
        "sizeB": 1234,
        "md5": "bWQ1",
        "startTimeMs": 1700000000000,
        "chunkSizeB": 1048576,
    }]}


def test_build_items_payload_includes_duration_when_provided():
    body = sample.build_items_payload(
        "clip.mkv", size_b=1234, md5_b64="bWQ1", start_time_ms=1700000000000,
        chunk_size_b=1048576, duration_ms=30000)
    assert body["items"][0]["durationMs"] == 30000


def test_build_items_payload_omits_duration_when_zero_or_negative():
    body = sample.build_items_payload(
        "clip.mkv", size_b=1, md5_b64="bWQ1", start_time_ms=1, chunk_size_b=1024,
        duration_ms=0)
    assert "durationMs" not in body["items"][0]


# ---------------------------------------------------------------------------
# Defensive parsing
# ---------------------------------------------------------------------------

def test_parse_device_id_bare_object():
    assert sample.parse_device_id({"id": "{dev-1}", "name": "x"}) == "{dev-1}"


def test_parse_device_id_reply_envelope():
    assert sample.parse_device_id({"reply": {"id": "{dev-2}"}}) == "{dev-2}"


def test_parse_device_id_single_item_list():
    assert sample.parse_device_id([{"id": "{dev-3}"}]) == "{dev-3}"


def test_parse_device_id_missing_raises():
    with pytest.raises(sample.ApiError):
        sample.parse_device_id({"name": "no id here"})


def test_parse_lock_token():
    # Real v4 shape: the token lives under "lockInfo".
    assert sample.parse_lock_token({"id": "d1", "lockInfo": {"token": "lock-abc"}}) == "lock-abc"
    assert sample.parse_lock_token({"reply": {"lockInfo": {"token": "lock-rep"}}}) == "lock-rep"
    # Fallbacks for a top-level token.
    assert sample.parse_lock_token({"token": "lock-xyz"}) == "lock-xyz"
    assert sample.parse_lock_token({"reply": {"token": "lock-env"}}) == "lock-env"


def test_parse_lock_token_missing_raises():
    with pytest.raises(sample.ApiError):
        sample.parse_lock_token({"nope": 1})


def test_parse_lock_progress_reads_lockinfo():
    data = {"id": "d1", "lockInfo": {"token": "t", "progress": 42}}
    assert sample.parse_lock_progress(data) == 42


def test_parse_lock_progress_missing_uses_default():
    assert sample.parse_lock_progress({"id": "d1"}, default=7) == 7
    assert sample.parse_lock_progress({}, default=0) == 0


def test_parse_lock_progress_non_numeric_uses_default():
    data = {"lockInfo": {"progress": "not-a-number"}}
    assert sample.parse_lock_progress(data, default=5) == 5


def test_parse_upload_item_uses_server_chunk_size():
    data = {"items": [{"uploadId": "clip.mkv", "chunkSizeB": 4096}]}
    upload_id, chunk = sample.parse_upload_item(data, 1048576, "clip.mkv")
    assert upload_id == "clip.mkv"
    assert chunk == 4096


def test_parse_upload_item_falls_back_to_requested_chunk_size():
    # No chunkSizeB and no uploadId echoed -> fall back to filename + requested.
    data = {"items": [{"filename": "clip.mkv"}]}
    upload_id, chunk = sample.parse_upload_item(data, 2048, "clip.mkv")
    assert upload_id == "clip.mkv"
    assert chunk == 2048


def test_parse_upload_item_bare_list_response():
    data = [{"uploadId": "clip.mkv", "chunkSizeB": 512}]
    upload_id, chunk = sample.parse_upload_item(data, 2048, "clip.mkv")
    assert upload_id == "clip.mkv" and chunk == 512


def test_parse_upload_item_invalid_chunk_size_falls_back():
    data = {"items": [{"chunkSizeB": "garbage"}]}
    _, chunk = sample.parse_upload_item(data, 999, "clip.mkv")
    assert chunk == 999


def test_parse_upload_progress_reads_field():
    assert sample.parse_upload_progress({"uploadProgressPercent": 63}) == 63


def test_parse_upload_progress_missing_defaults_to_100():
    # Chunk PUTs are synchronous, so no field present after a clean upload
    # loop is treated as "done", not "unknown".
    assert sample.parse_upload_progress({}) == 100


def test_parse_upload_progress_non_numeric_uses_default():
    data = {"uploadProgressPercent": "oops"}
    assert sample.parse_upload_progress(data, default=11) == 11


# ---------------------------------------------------------------------------
# Client: login
# ---------------------------------------------------------------------------

def test_login_posts_credentials_and_stores_token():
    session = RecordingSession(post=[FakeResponse(200, {"token": "abc123"})])
    client = sample.NxVirtualCameraClient(HOST, "admin", "pw", session=session)

    token = client.login()

    assert token == "abc123"
    assert session.calls[0]["url"] == HOST + "/rest/v4/login/sessions"
    assert session.calls[0]["json"] == {"username": "admin", "password": "pw",
                                        "setCookie": False}


def test_login_unauthorized_raises_autherror():
    session = RecordingSession(post=[FakeResponse(401, text="bad")])
    client = sample.NxVirtualCameraClient(HOST, "admin", "pw", session=session)
    with pytest.raises(sample.AuthError):
        client.login()


# ---------------------------------------------------------------------------
# wait_for_consume (extend-poll loop)
# ---------------------------------------------------------------------------

def test_wait_for_consume_polls_until_100():
    session = RecordingSession(patch=[
        FakeResponse(200, {"lockInfo": {"progress": 30}}),
        FakeResponse(200, {"lockInfo": {"progress": 70}}),
        FakeResponse(200, {"lockInfo": {"progress": 100}}),
    ])
    client = make_client(session)
    clock = FakeClock()
    seen = []

    progress = sample.wait_for_consume(
        client, "{dev-1}", "lock-1", ttl_ms=60000, poll_interval_s=2,
        timeout_s=300, sleep_fn=clock.sleep_fn, time_fn=clock.time_fn,
        on_progress=seen.append)

    assert progress == 100
    assert len(session.calls) == 3
    assert clock.sleeps == [2, 2, 2]
    assert all(c["json"] == {"ttlMs": 60000, "token": "lock-1"}
              for c in session.calls)
    assert seen == ["Consume progress: 30%", "Consume progress: 70%",
                    "Consume progress: 100%"]


def test_wait_for_consume_times_out():
    session = RecordingSession(patch=[FakeResponse(200, {"lockInfo": {"progress": 40}})])
    client = make_client(session)
    clock = FakeClock()

    with pytest.raises(sample.ApiError):
        sample.wait_for_consume(
            client, "{dev-1}", "lock-1", ttl_ms=60000, poll_interval_s=2,
            timeout_s=5, sleep_fn=clock.sleep_fn, time_fn=clock.time_fn)


# ---------------------------------------------------------------------------
# Full happy-path orchestration: exact call sequence
# ---------------------------------------------------------------------------

def test_full_upload_call_sequence(tmp_path):
    # File of 2.5 chunks -> 3 PUTs with chunk=0,1,2.
    chunk = 100
    data = b"x" * 250
    path = tmp_path / "clip.mkv"
    path.write_bytes(data)
    md5_b64 = base64.b64encode(hashlib.md5(data).digest()).decode("ascii")

    session = RecordingSession(
        post=[
            FakeResponse(200, {"id": "{dev-1}"}),                # create virtual
            FakeResponse(200, {"items": [{"uploadId": "clip.mkv",
                                          "chunkSizeB": chunk}]}),  # create upload
        ],
        patch=[
            FakeResponse(200, {"lockInfo": {"token": "lock-1"}}),  # lock
            FakeResponse(200, {"lockInfo": {"token": "lock-1"}}),  # consume
            FakeResponse(200, {"lockInfo": {"progress": 100}}),    # extend (poll)
            FakeResponse(200, {}),                                 # release
        ],
        put=[FakeResponse(200, {})],  # reused for every chunk
        get=[FakeResponse(200, {"uploadProgressPercent": 100})],  # upload status
    )
    client = make_client(session)
    clock = FakeClock()

    result = sample.upload_video(
        client, str(path), name="Cam", start_time_ms=1700000000000,
        ttl_ms=300000, requested_chunk_size=1048576, duration_ms=30000,
        poll_interval_s=2, consume_timeout_s=300,
        sleep_fn=clock.sleep_fn, time_fn=clock.time_fn)

    methods_urls = [(c["method"], c["url"]) for c in session.calls]
    base = HOST + "/rest/v4/devices"
    assert methods_urls == [
        ("POST", base + "/*/virtual"),
        ("POST", base + "/{dev-1}/virtual/uploads"),
        ("PUT", base + "/{dev-1}/virtual/uploads/clip.mkv"),
        ("PUT", base + "/{dev-1}/virtual/uploads/clip.mkv"),
        ("PUT", base + "/{dev-1}/virtual/uploads/clip.mkv"),
        ("GET", base + "/{dev-1}/virtual/uploads/clip.mkv"),
        ("PATCH", base + "/{dev-1}/virtual/lock"),
        ("PATCH", base + "/{dev-1}/virtual/consume"),
        ("PATCH", base + "/{dev-1}/virtual/extend"),
        ("PATCH", base + "/{dev-1}/virtual/release"),
    ]

    create_virtual, create_upload = session.calls[0], session.calls[1]
    assert create_virtual["json"] == {"name": "Cam"}
    assert create_upload["json"] == {"items": [{
        "filename": "clip.mkv", "sizeB": 250, "md5": md5_b64,
        "startTimeMs": 1700000000000, "chunkSizeB": 1048576,
        "durationMs": 30000}]}

    puts = [c for c in session.calls if c["method"] == "PUT"]
    assert [p["params"] for p in puts] == [{"chunk": 0}, {"chunk": 1}, {"chunk": 2}]
    assert [len(p["data"]) for p in puts] == [100, 100, 50]
    assert all(p["headers"]["Content-Type"] == "application/octet-stream"
               for p in puts)

    lock, consume, extend, release = (c for c in session.calls
                                      if c["method"] == "PATCH")
    assert lock["json"] == {"ttlMs": 300000}
    assert consume["json"] == {"token": "lock-1", "uploadId": "clip.mkv",
                               "startTimeMs": 1700000000000}
    assert extend["json"] == {"ttlMs": 300000, "token": "lock-1"}
    assert release["json"] == {"token": "lock-1"}

    # Bearer attached to every authenticated call.
    assert all(c["headers"]["Authorization"] == "Bearer tok" for c in session.calls)

    assert result["device_id"] == "{dev-1}"
    assert result["chunk_count"] == 3
    assert result["chunk_size_b"] == 100
    assert result["consume_progress"] == 100


def test_existing_device_skips_create(tmp_path):
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"y" * 50)

    session = RecordingSession(
        post=[FakeResponse(200, {"items": [{"uploadId": "clip.mp4"}]})],
        patch=[
            FakeResponse(200, {"lockInfo": {"token": "L"}}),      # lock
            FakeResponse(200, {"lockInfo": {"token": "L"}}),      # consume
            FakeResponse(200, {"lockInfo": {"progress": 100}}),   # extend
            FakeResponse(200, {}),                                # release
        ],
        put=[FakeResponse(200, {})],
        get=[FakeResponse(200, {"uploadProgressPercent": 100})],
    )
    client = make_client(session)
    clock = FakeClock()

    sample.upload_video(client, str(path), name="ignored",
                        start_time_ms=1, ttl_ms=1000,
                        requested_chunk_size=1024, device_id="{existing}",
                        sleep_fn=clock.sleep_fn, time_fn=clock.time_fn)

    methods_urls = [(c["method"], c["url"]) for c in session.calls]
    base = HOST + "/rest/v4/devices"
    # No create-virtual POST; first call is create-upload.
    assert methods_urls[0] == ("POST", base + "/{existing}/virtual/uploads")
    assert ("POST", base + "/*/virtual") not in methods_urls


def test_upload_failure_before_lock_cancels_upload_and_skips_release(tmp_path):
    # Upload-status GET fails before any lock is acquired: cancel the upload,
    # but there is no lock token yet so release must NOT be called.
    path = tmp_path / "clip.mkv"
    path.write_bytes(b"z" * 10)

    session = RecordingSession(
        post=[FakeResponse(200, {"id": "{dev-9}"}),
              FakeResponse(200, {"items": [{"uploadId": "clip.mkv"}]})],
        put=[FakeResponse(200, {})],
        get=[FakeResponse(500, text="status boom")],  # status GET FAILS
        delete=[FakeResponse(200, {})],
    )
    client = make_client(session)

    with pytest.raises(sample.ApiError):
        sample.upload_video(client, str(path), name="Cam", start_time_ms=1,
                            ttl_ms=1000, requested_chunk_size=1024)

    methods = [c["method"] for c in session.calls]
    assert "PATCH" not in methods  # lock/consume/extend/release never reached
    delete_calls = [c for c in session.calls if c["method"] == "DELETE"]
    assert len(delete_calls) == 1
    assert delete_calls[0]["url"].endswith("/uploads/clip.mkv")


def test_consume_failure_cancels_upload_and_still_releases(tmp_path):
    # Consume times out after the lock was acquired: expect one cancel-upload
    # DELETE and exactly one release, in that order.
    path = tmp_path / "clip.mkv"
    path.write_bytes(b"z" * 10)

    session = RecordingSession(
        post=[FakeResponse(200, {"id": "{dev-9}"}),
              FakeResponse(200, {"items": [{"uploadId": "clip.mkv"}]})],
        patch=[
            FakeResponse(200, {"lockInfo": {"token": "lock-9"}}),  # lock OK
            FakeResponse(200, {"lockInfo": {"token": "lock-9"}}),  # consume OK
            FakeResponse(200, {"lockInfo": {"progress": 10}}),     # extend: stuck at 10%
            FakeResponse(200, {}),                                 # release
        ],
        put=[FakeResponse(200, {})],
        get=[FakeResponse(200, {"uploadProgressPercent": 100})],
        delete=[FakeResponse(200, {})],
    )
    client = make_client(session)
    clock = FakeClock()

    with pytest.raises(sample.ApiError):
        sample.upload_video(client, str(path), name="Cam", start_time_ms=1,
                            ttl_ms=1000, requested_chunk_size=1024,
                            poll_interval_s=2, consume_timeout_s=5,
                            sleep_fn=clock.sleep_fn, time_fn=clock.time_fn)

    base = HOST + "/rest/v4/devices"
    delete_calls = [c for c in session.calls if c["method"] == "DELETE"]
    assert len(delete_calls) == 1
    assert delete_calls[0]["url"] == base + "/{dev-9}/virtual/uploads/clip.mkv"

    release_calls = [c for c in session.calls
                     if c["method"] == "PATCH" and c["url"].endswith("/release")]
    assert len(release_calls) == 1
    assert release_calls[0]["json"] == {"token": "lock-9"}

    # Cancel happens before release.
    delete_index = session.calls.index(delete_calls[0])
    release_index = session.calls.index(release_calls[0])
    assert delete_index < release_index


def test_incomplete_upload_status_raises_before_locking(tmp_path):
    # Server reports the raw upload itself is not fully received yet: fail
    # fast instead of locking/consuming a partial file.
    path = tmp_path / "clip.mkv"
    path.write_bytes(b"z" * 10)

    session = RecordingSession(
        post=[FakeResponse(200, {"id": "{dev-9}"}),
              FakeResponse(200, {"items": [{"uploadId": "clip.mkv"}]})],
        put=[FakeResponse(200, {})],
        get=[FakeResponse(200, {"uploadProgressPercent": 42})],
        delete=[FakeResponse(200, {})],
    )
    client = make_client(session)

    with pytest.raises(sample.ApiError):
        sample.upload_video(client, str(path), name="Cam", start_time_ms=1,
                            ttl_ms=1000, requested_chunk_size=1024)

    methods = [c["method"] for c in session.calls]
    assert "PATCH" not in methods


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------

def test_config_uses_server_env_vars(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://env:7001")
    args = argparse.Namespace(server_host=None, user=None, password=None)
    config = sample.resolve_config(args, {"NX_SERVER_HOST": "https://file:7001"})
    assert config["host"] == "https://env:7001"  # env beats file


def test_config_cli_beats_env(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://env:7001")
    args = argparse.Namespace(server_host="https://cli:7001", user=None,
                              password=None)
    config = sample.resolve_config(args, {})
    assert config["host"] == "https://cli:7001"
