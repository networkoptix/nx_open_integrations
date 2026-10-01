#!/usr/bin/env python3
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
"""
Offline tests for rest_backup_site_database.py.

These run with no VMS server and no network: every HTTP call is served by the
fakes below. That is a hard requirement, a test that needs a live server cannot
run in CI, so it does not get written.

The dump is opaque binary. The spec documents no response schema for
GET /rest/v4/site/database, so these tests assert what the sample does with the
bytes rather than what shape they have.
"""

import argparse
import datetime
import os
import stat

import pytest
import requests

import rest_backup_site_database as sample


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class FakeResponse:
    def __init__(self, status_code=200, payload=None, body=b"", chunks=None):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.content = body
        self._chunks = chunks if chunks is not None else ([body] if body else [])

    def json(self):
        return self._payload

    def iter_content(self, chunk_size=None):
        for chunk in self._chunks:
            yield chunk

    def raise_for_status(self):
        if self.status_code >= 400:
            raise AssertionError("HTTP {}".format(self.status_code))


class FakeSession:
    """Stands in for requests.Session, recording every call it receives."""

    def __init__(self, responses=None):
        self.headers = {}
        self.verify = True
        self.calls = []                      # dicts: method, url, json, data, headers, stream
        self.responses = responses or {}     # (method, url_suffix) -> FakeResponse or callable

    def _respond(self, method, url, **recorded):
        # Snapshot the session headers as they were for THIS call, so a test can
        # assert what actually went on the wire rather than what the client ends
        # up holding afterwards.
        call = {"method": method, "url": url, "sent_headers": dict(self.headers)}
        call.update(recorded)
        self.calls.append(call)
        for (want_method, suffix), response in self.responses.items():
            if method == want_method and url.endswith(suffix):
                if callable(response):
                    return response()
                return response
        return FakeResponse(200, {})

    def post(self, url, json=None, data=None, headers=None, timeout=None,
             allow_redirects=True):
        # A file object body is read here, the way requests would send it, and
        # recorded as bytes; `streamed` says the sample handed over the file.
        # A responder marked before_upload stands for a connection that never
        # got as far as sending the body, so the body is left unread.
        streamed = hasattr(data, "read")
        if streamed and not getattr(self._responder("POST", url), "before_upload", False):
            data = data.read()
        return self._respond("POST", url, json=json, data=data, headers=headers,
                             streamed=streamed, allow_redirects=allow_redirects)

    def _responder(self, method, url):
        for (want_method, suffix), response in self.responses.items():
            if method == want_method and url.endswith(suffix):
                return response
        return None

    def get(self, url, timeout=None, stream=False):
        return self._respond("GET", url, stream=stream)

    def delete(self, url, timeout=None):
        return self._respond("DELETE", url)


def make_client(responses=None):
    client = sample.NxServerClient("https://server:7001")
    client.session = FakeSession(responses)
    return client


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------

def test_login_posts_credentials_and_stores_token():
    client = make_client({("POST", "/login/sessions"): FakeResponse(200, {"token": "tok-1"})})

    token = client.login("admin", "secret")

    assert token == "tok-1"
    assert client.token == "tok-1"
    assert client.session.headers["Authorization"] == "Bearer tok-1"

    call = client.session.calls[0]
    assert call["method"] == "POST"
    assert call["json"] == {"username": "admin", "password": "secret",
                            "setCookie": False}
    assert call["url"].endswith("/rest/v4/login/sessions")


@pytest.mark.parametrize("status", [401, 403])
def test_login_unauthorized_raises_autherror(status):
    client = make_client({("POST", "/login/sessions"): FakeResponse(status)})
    with pytest.raises(sample.AuthError):
        client.login("admin", "wrong")


def test_login_without_token_in_response_raises_apierror():
    client = make_client({("POST", "/login/sessions"): FakeResponse(200, {})})
    with pytest.raises(sample.ApiError):
        client.login("admin", "secret")


# ---------------------------------------------------------------------------
# Logout
# ---------------------------------------------------------------------------

def test_logout_deletes_the_session_and_clears_the_token():
    client = make_client()
    client.token = "tok-1"
    client.session.headers["Authorization"] = "Bearer tok-1"

    client.logout()

    call = client.session.calls[-1]
    assert call["method"] == "DELETE"
    assert call["url"].endswith("/rest/v4/login/sessions/tok-1")
    assert client.token is None
    assert "Authorization" not in client.session.headers


def test_logout_without_a_token_is_a_noop():
    client = make_client()
    client.logout()
    assert client.session.calls == []


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def _args(**overrides):
    defaults = {"host": None, "user": None, "password": None}
    defaults.update(overrides)
    return argparse.Namespace(**defaults)


def test_config_reads_server_env_vars(monkeypatch):
    monkeypatch.setenv("NX_SERVER_HOST", "https://from-env:7001")
    monkeypatch.setenv("NX_SERVER_USER", "envuser")
    monkeypatch.setenv("NX_SERVER_PASSWORD", "envpass")

    config = sample.resolve_config(_args(), {})

    assert config == {"host": "https://from-env:7001",
                      "user": "envuser", "password": "envpass"}


def test_cli_flag_beats_env_which_beats_dotenv(monkeypatch):
    monkeypatch.setenv("NX_SERVER_USER", "envuser")

    config = sample.resolve_config(
        _args(user="cliuser"), {"NX_SERVER_USER": "dotenvuser"})
    assert config["user"] == "cliuser"

    config = sample.resolve_config(_args(), {"NX_SERVER_USER": "dotenvuser"})
    assert config["user"] == "envuser"

    monkeypatch.delenv("NX_SERVER_USER")
    config = sample.resolve_config(_args(), {"NX_SERVER_USER": "dotenvuser"})
    assert config["user"] == "dotenvuser"


def test_trailing_slash_is_stripped_from_host():
    config = sample.resolve_config(_args(host="https://server:7001/"), {})
    assert config["host"] == "https://server:7001"


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------

def test_backup_gets_the_site_database_endpoint(tmp_path):
    client = make_client({("GET", "/site/database"): FakeResponse(200, body=b"dump")})
    client.token = "tok-1"

    client.backup_database(str(tmp_path / "out.db"))

    call = client.session.calls[-1]
    assert call["method"] == "GET"
    assert call["url"] == "https://server:7001/rest/v4/site/database"


def test_backup_sends_the_bearer_token_from_login(tmp_path):
    client = make_client({
        ("POST", "/login/sessions"): FakeResponse(200, {"token": "tok-9"}),
        ("GET", "/site/database"): FakeResponse(200, body=b"dump"),
    })
    client.login("admin", "secret")

    client.backup_database(str(tmp_path / "out.db"))

    dump_call = client.session.calls[-1]
    assert dump_call["url"].endswith("/site/database")
    assert dump_call["sent_headers"]["Authorization"] == "Bearer tok-9"


def test_backup_asks_for_a_streamed_body(tmp_path):
    """A site dump can be tens of megabytes; it must not be buffered whole."""
    client = make_client({("GET", "/site/database"): FakeResponse(200, body=b"dump")})
    client.token = "tok-1"

    client.backup_database(str(tmp_path / "out.db"))

    assert client.session.calls[-1]["stream"] is True


def test_backup_writes_the_bytes_byte_for_byte(tmp_path):
    """The dump is opaque binary, so it must never be decoded as text."""
    dump = bytes([0x00, 0xFF, 0xFE, 0x0D, 0x0A, 0x1A]) + b"\x80\x81not-utf8"
    client = make_client({("GET", "/site/database"): FakeResponse(200, body=dump)})
    client.token = "tok-1"
    target = tmp_path / "out.db"

    client.backup_database(str(target))

    assert target.read_bytes() == dump


def test_backup_writes_every_chunk_in_order(tmp_path):
    """Streaming means the file is assembled from chunks, not from one buffer."""
    client = make_client({("GET", "/site/database"): FakeResponse(
        200, chunks=[b"aaa", b"bbb", b"ccc"])})
    client.token = "tok-1"
    target = tmp_path / "out.db"

    client.backup_database(str(target))

    assert target.read_bytes() == b"aaabbbccc"


def test_backup_returns_the_byte_count(tmp_path):
    client = make_client({("GET", "/site/database"): FakeResponse(
        200, chunks=[b"aaa", b"bbbb"])})
    client.token = "tok-1"

    assert client.backup_database(str(tmp_path / "out.db")) == 7


def test_backup_rejects_an_empty_dump_and_leaves_no_file(tmp_path):
    """A zero byte body is never a valid dump, and half a backup is worse than none."""
    client = make_client({("GET", "/site/database"): FakeResponse(200, chunks=[])})
    client.token = "tok-1"
    target = tmp_path / "out.db"

    with pytest.raises(sample.ApiError):
        client.backup_database(str(target))

    assert not target.exists()


def _chunks_then_drop(*chunks):
    """A body that delivers some chunks and then loses the connection."""
    def generate(chunk_size=None):
        for chunk in chunks:
            yield chunk
        raise requests.exceptions.ChunkedEncodingError("Connection broken")
    return generate


def test_backup_cut_off_midway_leaves_no_file(tmp_path):
    """Half a dump on disk would pass for a backup until the day it is needed."""
    response = FakeResponse(200)
    response.iter_content = _chunks_then_drop(b"first half ")
    client = make_client({("GET", "/site/database"): response})
    client.token = "tok-1"
    target = tmp_path / "out.db"

    with pytest.raises(requests.exceptions.ChunkedEncodingError):
        client.backup_database(str(target))

    assert list(tmp_path.iterdir()) == []


def test_backup_cut_off_midway_keeps_the_previous_backup(tmp_path, monkeypatch):
    """--force replaces the old dump only once the new one is complete."""
    target = tmp_path / "already.db"
    target.write_bytes(b"previous backup")
    response = FakeResponse(200)
    response.iter_content = _chunks_then_drop(b"first half ")
    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = response
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["backup", "--out", str(target), "--force"] + _creds())

    assert rc == 1
    assert target.read_bytes() == b"previous backup"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["already.db"]


def test_backup_raises_autherror_on_401(tmp_path):
    client = make_client({("GET", "/site/database"): FakeResponse(401)})
    client.token = "tok-1"

    with pytest.raises(sample.AuthError):
        client.backup_database(str(tmp_path / "out.db"))


def test_backup_403_names_the_role_and_the_fresh_session_rule(tmp_path):
    """The spec's permission line is "Administrator with a fresh session", and a
    403 here is nearly always one of those two, so the message must say both."""
    client = make_client({("GET", "/site/database"): FakeResponse(403)})
    client.token = "tok-1"

    with pytest.raises(sample.AuthError) as caught:
        client.backup_database(str(tmp_path / "out.db"))

    message = str(caught.value).lower()
    assert "administrator" in message
    assert "fresh session" in message


def test_backup_raises_apierror_on_a_server_error(tmp_path):
    """The body is non-empty on purpose: an error page must be rejected on its
    status, not incidentally by the empty-dump check."""
    client = make_client({("GET", "/site/database"): FakeResponse(
        500, body=b"<html>Internal Server Error</html>")})
    client.token = "tok-1"
    target = tmp_path / "out.db"

    with pytest.raises(sample.ApiError):
        client.backup_database(str(target))

    assert not target.exists()


# ---------------------------------------------------------------------------
# The default output name
# ---------------------------------------------------------------------------

def test_default_output_name_carries_the_host_and_a_utc_timestamp():
    moment = datetime.datetime(2026, 9, 14, 3, 12, 0)

    name = sample.default_output_name("https://192.168.1.10:7001", now=moment)

    assert name == "nx-site-database-192-168-1-10-7001-20260914T031200Z.db"


def test_default_output_name_keeps_the_port_and_drops_the_scheme():
    """A relay address and a plain http host must both survive intact."""
    moment = datetime.datetime(2026, 1, 2, 0, 0, 0)

    assert sample.default_output_name(
        "https://abcd-1234.relay.vmsproxy.com", now=moment
    ) == "nx-site-database-abcd-1234-relay-vmsproxy-com-20260102T000000Z.db"

    assert sample.default_output_name(
        "http://10.0.0.5:7001", now=moment
    ) == "nx-site-database-10-0-0-5-7001-20260102T000000Z.db"


# ---------------------------------------------------------------------------
# main(): the backup subcommand
# ---------------------------------------------------------------------------

def _install_fake_session(monkeypatch, responses=None):
    """Follow the house pattern: hand main() a fake requests.Session."""
    session = FakeSession(responses)
    monkeypatch.setattr(sample.requests, "Session", lambda: session)
    return session


LOGIN_OK = {("POST", "/login/sessions"): FakeResponse(200, {"token": "tok-1"})}


def _creds(*extra):
    return ["--host", "https://server:7001", "--user", "admin",
            "--password", "secret", "--env-file", "/nonexistent"] + list(extra)


def test_backup_refuses_to_overwrite_without_force(tmp_path, monkeypatch, capsys):
    target = tmp_path / "already.db"
    target.write_bytes(b"previous backup")
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))

    rc = sample.main(["backup", "--out", str(target)] + _creds())

    assert rc == 1
    assert "Refusing to overwrite" in capsys.readouterr().err
    # The guard runs before anything is sent, including the login.
    assert session.calls == []
    assert target.read_bytes() == b"previous backup"


def test_backup_force_overwrites_an_existing_file(tmp_path, monkeypatch):
    target = tmp_path / "already.db"
    target.write_bytes(b"previous backup")
    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = FakeResponse(200, body=b"fresh dump")
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["backup", "--out", str(target), "--force"] + _creds())

    assert rc == 0
    assert target.read_bytes() == b"fresh dump"


def test_backup_to_stdout_writes_bytes_and_keeps_progress_off_stdout(
        tmp_path, monkeypatch, capsysbinary):
    """--out - has to stay pipeable, so nothing but the dump goes to stdout."""
    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = FakeResponse(
        200, chunks=[b"\x00\xff", b"\xfe\x01"])
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["backup", "--out", "-"] + _creds())

    captured = capsysbinary.readouterr()
    assert rc == 0
    assert captured.out == b"\x00\xff\xfe\x01"
    assert b"Logged in" in captured.err


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------

def test_restore_posts_to_the_site_database_endpoint(tmp_path):
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    client = make_client({("POST", "/site/database"): FakeResponse(200)})
    client.token = "tok-1"

    client.restore_database(str(dump))

    call = client.session.calls[-1]
    assert call["method"] == "POST"
    assert call["url"] == "https://server:7001/rest/v4/site/database"


def test_restore_sends_the_octet_stream_content_type(tmp_path):
    """The spec declares the request body as application/octet-stream."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    client = make_client({("POST", "/site/database"): FakeResponse(200)})
    client.token = "tok-1"

    client.restore_database(str(dump))

    assert client.session.calls[-1]["headers"]["Content-Type"] == "application/octet-stream"


def test_restore_sends_the_file_bytes_unchanged(tmp_path):
    """No multipart wrapper, no base64, no text encoding: the raw dump."""
    dump = tmp_path / "in.db"
    payload = bytes([0x00, 0xFF, 0xFE]) + b"\x80\x81binary" + bytes([0x0D, 0x0A])
    dump.write_bytes(payload)
    client = make_client({("POST", "/site/database"): FakeResponse(200)})
    client.token = "tok-1"

    client.restore_database(str(dump))

    assert client.session.calls[-1]["data"] == payload
    assert client.session.calls[-1]["json"] is None


def test_restore_streams_the_file_instead_of_reading_it_whole(tmp_path):
    """A site dump runs to tens of megabytes. Handing requests the open file
    sends it from disk; handing it bytes holds the whole dump in memory."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    client = make_client({("POST", "/site/database"): FakeResponse(200)})
    client.token = "tok-1"

    client.restore_database(str(dump))

    assert client.session.calls[-1]["streamed"] is True


# ---------------------------------------------------------------------------
# main(): the restore subcommand and its guards
# ---------------------------------------------------------------------------

def test_restore_refuses_a_missing_file(tmp_path, monkeypatch, capsys):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))

    rc = sample.main(["restore", str(tmp_path / "nope.db"), "--yes"] + _creds())

    assert rc == 1
    assert "No such dump" in capsys.readouterr().err
    assert session.calls == []


def test_restore_refuses_a_zero_byte_file(tmp_path, monkeypatch, capsys):
    """A zero byte file is not a dump, and finding that out from the server
    would mean having already asked it to replace the site."""
    empty = tmp_path / "empty.db"
    empty.write_bytes(b"")
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))

    rc = sample.main(["restore", str(empty), "--yes"] + _creds())

    assert rc == 1
    assert "empty" in capsys.readouterr().err.lower()
    assert session.calls == []


def test_restore_refuses_without_yes(tmp_path, monkeypatch, capsys):
    """Loading a dump replaces the whole site and restarts the server, so it
    never happens by accident."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))

    rc = sample.main(["restore", str(dump)] + _creds())

    assert rc == 1
    assert "--yes" in capsys.readouterr().err
    assert session.calls == []


@pytest.mark.parametrize("status", [401, 403])
def test_restore_unauthorized_raises_autherror(status, tmp_path):
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    client = make_client({("POST", "/site/database"): FakeResponse(status)})
    client.token = "tok-1"

    with pytest.raises(sample.AuthError) as caught:
        client.restore_database(str(dump))

    message = str(caught.value).lower()
    assert "administrator" in message and "fresh session" in message


@pytest.mark.parametrize("status", [400, 500])
def test_restore_error_status_raises_apierror(status, tmp_path):
    """A rejected dump (wrong version, corrupt file) is a failure, not a restart."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    client = make_client({("POST", "/site/database"): FakeResponse(status)})
    client.token = "tok-1"

    with pytest.raises(sample.ApiError) as caught:
        client.restore_database(str(dump))

    assert "not applied" in str(caught.value)


def test_restore_error_status_exits_1_and_never_says_accepted(
        tmp_path, monkeypatch, capsys):
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    responses = dict(LOGIN_OK)
    responses[("POST", "/site/database")] = FakeResponse(500)
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["restore", str(dump), "--yes"] + _creds())

    captured = capsys.readouterr()
    assert rc == 1
    assert "Accepted" not in captured.out
    assert "HTTP 500" in captured.err


def test_restore_treats_a_dropped_connection_as_success(tmp_path):
    """The spec says the server restarts after loading, so it can cut the
    connection before answering. That is the success path, not a failure."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")

    def drop():
        raise requests.exceptions.ConnectionError("connection reset by peer")

    client = make_client({("POST", "/site/database"): drop})
    client.token = "tok-1"

    client.restore_database(str(dump))          # must not raise


def test_restore_without_an_answer_says_the_outcome_is_unknown(tmp_path):
    """No answer after the upload is neither the restart nor a refusal. Reporting
    success could hide a failed load; reporting failure invites a second load
    into a server that is already restarting with the first."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")

    def silent():
        raise requests.exceptions.ReadTimeout("read timed out")

    client = make_client({("POST", "/site/database"): silent})
    client.token = "tok-1"

    with pytest.raises(sample.ApiError) as caught:
        client.restore_database(str(dump))

    message = str(caught.value)
    assert "may have loaded it" in message and "Check the server" in message


def test_restore_that_never_connects_is_not_mistaken_for_the_restart(tmp_path):
    """ConnectTimeout is a ConnectionError too, but nothing was sent."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")

    def unreachable():
        raise requests.exceptions.ConnectTimeout("connect timed out")
    unreachable.before_upload = True

    client = make_client({("POST", "/site/database"): unreachable})
    client.token = "tok-1"

    with pytest.raises(sample.ApiError) as caught:
        client.restore_database(str(dump))

    assert "after 0 of 6 bytes" in str(caught.value)
    assert "not loaded" in str(caught.value)


def test_restore_does_not_log_out_afterwards(tmp_path, monkeypatch, capsys):
    """The restart ends the session by itself; a DELETE would only produce a
    confusing connection error after a successful restore."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    responses = dict(LOGIN_OK)
    responses[("POST", "/site/database")] = FakeResponse(200)
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["restore", str(dump), "--yes"] + _creds())

    assert rc == 0
    assert [c for c in session.calls if c["method"] == "DELETE"] == []
    assert "restarting" in capsys.readouterr().out


# ---------------------------------------------------------------------------
# Session handling
# ---------------------------------------------------------------------------

def test_every_run_logs_in_immediately_before_its_own_call(
        tmp_path, monkeypatch):
    """"Administrator with a fresh session" is the spec's own permission line,
    so the login must be the call right before the database call, and there
    must be no way to hand the sample a token minted earlier."""
    backup_responses = dict(LOGIN_OK)
    backup_responses[("GET", "/site/database")] = FakeResponse(200, body=b"dump")
    session = _install_fake_session(monkeypatch, backup_responses)

    sample.main(["backup", "--out", str(tmp_path / "out.db")] + _creds())

    steps = [(c["method"], c["url"].rsplit("/rest/v4", 1)[-1]) for c in session.calls]
    assert steps[0] == ("POST", "/login/sessions")
    assert steps[1] == ("GET", "/site/database")

    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    restore_responses = dict(LOGIN_OK)
    restore_responses[("POST", "/site/database")] = FakeResponse(200)
    session = _install_fake_session(monkeypatch, restore_responses)

    sample.main(["restore", str(dump), "--yes"] + _creds())

    steps = [(c["method"], c["url"].rsplit("/rest/v4", 1)[-1]) for c in session.calls]
    assert steps[0] == ("POST", "/login/sessions")
    assert steps[1] == ("POST", "/site/database")

    # No token can be supplied: not by flag on either subcommand, and not by
    # config. Check the SUBPARSERS, since the top-level help never lists their
    # flags and asserting against it would prove nothing.
    for command in ("backup", "restore"):
        with pytest.raises(SystemExit):
            sample.build_arg_parser().parse_args(
                [command, "x", "--token", "stale-token"])
    assert "token" not in sample.resolve_config(
        _args(), {"NX_SERVER_TOKEN": "stale-token"})


def test_backup_logs_out_and_survives_a_failing_logout(tmp_path, monkeypatch):
    """The dump is already safely on disk, so a logout that cannot be delivered
    must not turn a successful backup into a failure."""
    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = FakeResponse(200, body=b"dump")
    session = _install_fake_session(monkeypatch, responses)
    target = tmp_path / "out.db"

    rc = sample.main(["backup", "--out", str(target)] + _creds())

    assert rc == 0
    assert [c["url"] for c in session.calls if c["method"] == "DELETE"] == [
        "https://server:7001/rest/v4/login/sessions/tok-1"]

    def drop():
        raise requests.exceptions.ConnectionError("connection reset by peer")

    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = FakeResponse(200, body=b"dump")
    responses[("DELETE", "/login/sessions/tok-1")] = drop
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["backup", "--out", str(target), "--force"] + _creds())

    assert rc == 0
    assert target.read_bytes() == b"dump"


def test_a_failed_backup_still_logs_out(tmp_path, monkeypatch, capsys):
    """The session is an administrator's. A dump that fails is no reason to
    leave it valid on the server."""
    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = FakeResponse(500, body=b"oops")
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["backup", "--out", str(tmp_path / "out.db")] + _creds())

    assert rc == 1
    assert "HTTP 500" in capsys.readouterr().err
    assert [c["url"] for c in session.calls if c["method"] == "DELETE"] == [
        "https://server:7001/rest/v4/login/sessions/tok-1"]


# ---------------------------------------------------------------------------
# Additions beyond the approved 26: the CLI error paths the plan implied with
# "exit 1 when the call failed" but never named a test for.
# ---------------------------------------------------------------------------

def test_no_subcommand_prints_help_and_exits_2(capsys):
    rc = sample.main([])

    assert rc == 2
    assert "backup" in capsys.readouterr().err


def test_auth_failure_exits_1_without_a_traceback(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = FakeResponse(403)
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["backup", "--out", str(tmp_path / "out.db")] + _creds())

    assert rc == 1
    assert "ERROR:" in capsys.readouterr().err


def test_a_tls_failure_points_at_insecure(tmp_path, monkeypatch, capsys):
    def bad_cert():
        raise requests.exceptions.SSLError("certificate verify failed")

    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = bad_cert
    _install_fake_session(monkeypatch, responses)

    rc = sample.main(["backup", "--out", str(tmp_path / "out.db")] + _creds())

    assert rc == 1
    assert "--insecure" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# Parity and polish
# ---------------------------------------------------------------------------

def test_dotenv_values_lose_matching_quotes(tmp_path):
    """The other ports strip them, so the same .env must mean the same password."""
    env = tmp_path / ".env"
    env.write_text('NX_SERVER_PASSWORD="se cret"\nNX_SERVER_USER=\'admin\'\n'
                   'NX_SERVER_HOST="https://server:7001\n', encoding="utf-8")

    values = sample.load_env_file(str(env))

    assert values["NX_SERVER_PASSWORD"] == "se cret"
    assert values["NX_SERVER_USER"] == "admin"
    # Unmatched quotes are left alone: that is a value, not a quoted value.
    assert values["NX_SERVER_HOST"] == '"https://server:7001'


def test_an_unwritable_out_exits_1_without_a_traceback(tmp_path, monkeypatch, capsys):
    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = FakeResponse(200, body=b"dump")
    _install_fake_session(monkeypatch, responses)
    target = tmp_path / "no-such-folder" / "out.db"

    rc = sample.main(["backup", "--out", str(target)] + _creds())

    err = capsys.readouterr().err
    assert rc == 1
    assert "could not use" in err and "No such file or directory" in err
    assert "could not reach the server" not in err


def test_backup_refuses_to_write_the_dump_to_a_terminal(monkeypatch, capsys):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))
    monkeypatch.setattr(sample.sys.stdout, "isatty", lambda: True, raising=False)

    rc = sample.main(["backup", "--out", "-"] + _creds())

    assert rc == 1
    assert "terminal" in capsys.readouterr().err
    assert session.calls == []


def test_default_output_name_drops_ipv6_brackets():
    moment = datetime.datetime(2026, 10, 1, 8, 9, 10, tzinfo=datetime.timezone.utc)

    name = sample.default_output_name("https://[fe80::1]:7001", moment)

    assert name == "nx-site-database-fe80--1-7001-20261001T080910Z.db"


def test_format_size_uses_binary_units():
    """The divisor is 1024, so the honest unit names are KiB and MiB."""
    assert sample.format_size(512) == "512 bytes"
    assert sample.format_size(1536) == "1.500 KiB"
    assert sample.format_size(3 * 1024 * 1024) == "3.000 MiB"


# ---------------------------------------------------------------------------
# Where the dump lands: permissions, directories, a failed rename
# ---------------------------------------------------------------------------

@pytest.mark.skipif(os.name == "nt", reason="POSIX file modes")
def test_the_dump_is_readable_by_its_owner_only(tmp_path):
    """It holds password hashes and server auth keys. Under the usual umask a
    plain open() would make it -rw-r--r--, readable by every local user."""
    target = tmp_path / "out.db"
    # A stale side file with a loose mode must not lend the dump its mode.
    stale = tmp_path / "out.db.partial"
    stale.write_bytes(b"old")
    os.chmod(stale, 0o644)
    client = make_client({("GET", "/site/database"): FakeResponse(200, body=b"dump")})
    client.token = "tok-1"

    client.backup_database(str(target))

    assert stat.S_IMODE(os.stat(target).st_mode) == 0o600
    assert target.read_bytes() == b"dump"


def test_backup_refuses_a_directory_as_out(tmp_path, monkeypatch, capsys):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))
    folder = tmp_path / "adir"
    folder.mkdir()

    rc = sample.main(["backup", "--out", str(folder), "--force"] + _creds())

    assert rc == 1
    assert "is a directory" in capsys.readouterr().err
    # Refused before anything is sent, and nothing left next to it.
    assert session.calls == []
    assert sorted(p.name for p in tmp_path.iterdir()) == ["adir"]


def test_a_failed_rename_leaves_no_partial_and_names_the_destination(
        tmp_path, monkeypatch, capsys):
    """The whole dump is in the side file by then, hashes and all."""
    responses = dict(LOGIN_OK)
    responses[("GET", "/site/database")] = FakeResponse(200, body=b"dump")
    _install_fake_session(monkeypatch, responses)
    target = tmp_path / "out.db"

    def refuse(src, dst):
        raise PermissionError(13, "Permission denied", src, None, dst)

    # Without --force the dump is moved into place with link(), not replace().
    monkeypatch.setattr(sample.os, "link", refuse)

    rc = sample.main(["backup", "--out", str(target)] + _creds())

    err = capsys.readouterr().err
    assert rc == 1
    assert list(tmp_path.iterdir()) == []
    assert "could not use {}".format(target) in err


# ---------------------------------------------------------------------------
# Restore outcomes, overlapping runs, and the login's own failures
# ---------------------------------------------------------------------------

def test_a_connection_lost_partway_through_the_upload_is_not_success(tmp_path):
    """A reset after part of the dump, or a refused connection, means the server
    never had the whole dump, so it cannot have loaded it."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump that is cut off")

    def cut_off():
        raise requests.exceptions.ConnectionError("connection reset by peer")
    cut_off.before_upload = True

    client = make_client({("POST", "/site/database"): cut_off})
    client.token = "tok-1"

    with pytest.raises(sample.ApiError) as caught:
        client.restore_database(str(dump))

    assert "not loaded" in str(caught.value)


def test_restore_follows_no_redirect_and_a_3xx_is_a_failure(tmp_path):
    """Followed, a 302 turns the POST into a GET of the dump, which answers 200."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    client = make_client({("POST", "/site/database"): FakeResponse(302)})
    client.token = "tok-1"

    with pytest.raises(sample.ApiError) as caught:
        client.restore_database(str(dump))

    assert "HTTP 302" in str(caught.value)
    assert client.session.calls[-1]["allow_redirects"] is False


@pytest.mark.parametrize("status", [400, 500])
def test_a_failed_restore_logs_out(status, tmp_path, monkeypatch):
    """No restart follows a refused load, so the session would stay valid."""
    dump = tmp_path / "in.db"
    dump.write_bytes(b"a dump")
    responses = dict(LOGIN_OK)
    responses[("POST", "/site/database")] = FakeResponse(status)
    session = _install_fake_session(monkeypatch, responses)

    rc = sample.main(["restore", str(dump), "--yes"] + _creds())

    assert rc == 1
    assert [c["url"] for c in session.calls if c["method"] == "DELETE"] == [
        "https://server:7001/rest/v4/login/sessions/tok-1"]


def test_restore_refuses_a_directory_before_logging_in(tmp_path, monkeypatch, capsys):
    session = _install_fake_session(monkeypatch, dict(LOGIN_OK))
    folder = tmp_path / "adir"
    folder.mkdir()

    rc = sample.main(["restore", str(folder), "--yes"] + _creds())

    assert rc == 1
    assert "is a directory" in capsys.readouterr().err
    assert session.calls == []


def test_overlapping_backups_to_one_out_never_share_a_side_file(tmp_path):
    """A fixed <out>.partial let one run delete and rename the other's file."""
    target = str(tmp_path / "out.db")
    first, first_handle = sample._open_private_beside(target)
    second, second_handle = sample._open_private_beside(target)
    first_handle.close()
    second_handle.close()

    assert first != second
    assert os.path.dirname(first) == str(tmp_path)


def test_without_force_a_file_that_appears_during_the_download_is_kept(tmp_path):
    target = tmp_path / "out.db"

    def appear_then_send(chunk_size=None):
        target.write_bytes(b"someone else's file")
        yield b"dump"

    response = FakeResponse(200)
    response.iter_content = appear_then_send
    client = make_client({("GET", "/site/database"): response})
    client.token = "tok-1"

    with pytest.raises(sample.ApiError) as caught:
        client.backup_database(str(target))

    assert "Refusing to overwrite" in str(caught.value)
    assert target.read_bytes() == b"someone else's file"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["out.db"]


@pytest.mark.parametrize("status", [500, 503])
def test_a_login_error_status_is_not_called_unreachable(status, monkeypatch, capsys):
    _install_fake_session(monkeypatch, {
        ("POST", "/login/sessions"): FakeResponse(status)})

    rc = sample.main(["backup", "--out", "-"] + _creds())

    err = capsys.readouterr().err
    assert rc == 1
    assert "Login failed: HTTP {}".format(status) in err
    assert "could not reach the server" not in err


@pytest.mark.parametrize("payload", [ValueError("not json"), [1, 2], "a string"])
def test_a_login_body_that_is_not_a_json_object_is_reported(payload, monkeypatch, capsys):
    response = FakeResponse(200)
    if isinstance(payload, Exception):
        def broken():
            raise payload
        response.json = broken
    else:
        response.json = lambda: payload
    _install_fake_session(monkeypatch, {("POST", "/login/sessions"): response})

    rc = sample.main(["backup", "--out", "-"] + _creds())

    err = capsys.readouterr().err
    assert rc == 1
    assert "Login response" in err
    assert "Traceback" not in err
