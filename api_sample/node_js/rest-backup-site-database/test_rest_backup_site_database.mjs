// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

/**
* Offline tests for rest_backup_site_database.mjs. No network, no account, no
* server: every call goes through an injected fake `fetch`.
*
* The dump is opaque binary. The spec documents no response schema for
* GET /rest/v4/site/database, so these tests assert what the sample does with
* the bytes rather than what shape they have.
*
* Run from this folder:  node --test test_rest_backup_site_database.mjs
*/
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  NxServerClient,
  resolveConfig,
  loadEnvFile,
  parseArgs,
  fileSink,
  streamSink,
  formatSize,
  defaultOutName,
  main as realMain,
  httpUpload,
  AuthError,
  ApiError,
} from "./rest_backup_site_database.mjs";

// ---------------------------------------------------------------------------
// Fake HTTP plumbing

// ---------------------------------------------------------------------------

/** A web ReadableStream over the given byte chunks. */

export function streamOf(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks)
        controller.enqueue(c);
      controller.close();
    },
  });
}

/**
* Build a fake fetch plus the list it records into. Replies are matched by a
* substring of the URL and the method, so a test says what it means rather
* than counting calls.
*/

export function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = (async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: { ...(init.headers ?? {}) },
      body: init.body,
    });
    const match = replies.find(([suffix, m]) => url.includes(suffix) && m === method);
    const reply = match ? match[2] : { status: 200, json: {} };
    if (reply.throws)
      throw reply.throws;
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      body: reply.chunks ? streamOf(reply.chunks) : streamOf([]),
      json: async () => {
        if (reply.json === undefined)
          throw new Error("not json");
        return reply.json;
      },
      text: async () => reply.text ?? "",
      // A site dump can be tens of megabytes. Any implementation that reaches
      // for a buffering accessor instead of the stream fails loudly here.
      arrayBuffer: async () => {
        throw new Error("the dump must be streamed, not buffered");
      },
      blob: async () => {
        throw new Error("the dump must be streamed, not buffered");
      },
    };
  });
  // The restore upload goes through node:http, not fetch; this stands in for
  // it, recording into the same list so a test reads one sequence of calls.
  const uploadImpl = async (url, { headers, source }) => {
    const body = new Uint8Array(fs.readFileSync(source));
    calls.push({ url, method: "POST", headers: { ...headers }, body });
    const match = replies.find(([suffix, m]) => url.includes(suffix) && m === "POST");
    const reply = match ? match[2] : { status: 200 };
    if (reply.throws)
      throw Object.assign(reply.throws, { sent: reply.sent ?? body.length, size: body.length });
    const status = reply.status ?? 200;
    return { status, ok: status >= 200 && status < 300 };
  };
  fetchImpl.uploadImpl = uploadImpl;
  return { fetchImpl, uploadImpl, calls };
}

/**
 * main(), with the fake fetch's upload stand-in passed along, so the tests that
 * give main() a fake fetch keep covering the restore without saying so twice.
 */
const main = (argv, deps = {}) =>
  realMain(argv, {
    uploadImpl: deps.fetchImpl?.uploadImpl,
    ...deps,
  });

const LOGIN_OK = [
  "/login/sessions",
  "POST",
  { status: 200, json: { token: "tok-1" } },
];

export function makeClient(replies) {
  const { fetchImpl, uploadImpl, calls } = fakeFetch(replies);
  const client = new NxServerClient("https://server:7001", "admin", "secret", { fetchImpl, uploadImpl });
  return { client, calls };
}

/** A fresh temp directory, removed by the caller. */

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nx-backup-test-"));
}

// ---------------------------------------------------------------------------
// Login

// ---------------------------------------------------------------------------

test("login posts the credentials and stores the token", async () => {
  const { client, calls } = makeClient([LOGIN_OK]);
  const token = await client.login();
  assert.equal(token, "tok-1");
  assert.equal(client.token, "tok-1");
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/rest/v4/login/sessions"));
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    username: "admin",
    password: "secret",
    setCookie: false,
  });
});

for (const status of [401, 403]) {
  test(`login throws AuthError on ${status}`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", { status }]]);
    await assert.rejects(() => client.login(), AuthError);
  });
}

test("login throws ApiError when the response carries no token", async () => {
  const { client } = makeClient([["/login/sessions", "POST", { status: 200, json: {} }]]);
  await assert.rejects(() => client.login(), ApiError);
});

// ---------------------------------------------------------------------------
// Logout

// ---------------------------------------------------------------------------

test("logout deletes the session and clears the token", async () => {
  const { client, calls } = makeClient([LOGIN_OK]);
  await client.login();
  await client.logout();
  const last = calls[calls.length - 1];
  assert.equal(last.method, "DELETE");
  assert.ok(last.url.endsWith("/rest/v4/login/sessions/tok-1"));
  assert.equal(client.token, null);
});

test("logout without a token makes no request", async () => {
  const { client, calls } = makeClient([]);
  await client.logout();
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Configuration

// ---------------------------------------------------------------------------

test("config reads the NX_SERVER_* environment variables", () => {
  const config = resolveConfig({}, {}, {
    NX_SERVER_HOST: "https://from-env:7001",
    NX_SERVER_USER: "envuser",
    NX_SERVER_PASSWORD: "envpass",
  });
  assert.deepEqual(config, {
    host: "https://from-env:7001",
    user: "envuser",
    password: "envpass",
  });
});

test("a CLI flag beats env, which beats the dotenv file", () => {
  const dotenv = { NX_SERVER_USER: "dotenvuser" };
  const env = { NX_SERVER_USER: "envuser" };
  assert.equal(resolveConfig({ user: "cliuser" }, dotenv, env).user, "cliuser");
  assert.equal(resolveConfig({}, dotenv, env).user, "envuser");
  assert.equal(resolveConfig({}, dotenv, {}).user, "dotenvuser");
});

test("a trailing slash is stripped from the host", () => {
  assert.equal(resolveConfig({ host: "https://server:7001/" }, {}, {}).host, "https://server:7001");
});

test("loadEnvFile returns an empty object for a missing file", () => {
  assert.deepEqual(loadEnvFile("/nonexistent/.env"), {});
});

test("--dotenv is the config flag here, not --env-file", () => {
  assert.equal(parseArgs(["backup", "--dotenv", "../../.env"]).envFile, "../../.env");
  assert.throws(() => parseArgs(["backup", "--env-file", "../../.env"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// Backup

// ---------------------------------------------------------------------------

/** A sink that keeps every chunk it was handed, so tests can inspect them. */

export function collectingSink() {
  const chunks = [];
  const sink = async (body) => {
    let total = 0;
    for await (const chunk of body) {
      chunks.push(chunk);
      total += chunk.length;
    }
    return total;
  };
  return { sink, chunks };
}

test("backup gets the site database endpoint", async () => {
  const { client, calls } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, chunks: [new Uint8Array([1, 2])] }],
  ]);
  await client.login();
  await client.backupDatabase(collectingSink().sink);
  const last = calls[calls.length - 1];
  assert.equal(last.method, "GET");
  assert.equal(last.url, "https://server:7001/rest/v4/site/database");
});

test("backup sends the bearer token from login on the dump request", async () => {
  const { client, calls } = makeClient([
    ["/login/sessions", "POST", { status: 200, json: { token: "tok-9" } }],
    ["/site/database", "GET", { status: 200, chunks: [new Uint8Array([1])] }],
  ]);
  await client.login();
  await client.backupDatabase(collectingSink().sink);
  const dump = calls[calls.length - 1];
  assert.ok(dump.url.endsWith("/site/database"));
  assert.equal(dump.headers["Authorization"], "Bearer tok-9");
});

test("backup streams the body instead of buffering it", async () => {
  // The fake throws from arrayBuffer() and blob(), so this passes only if the
  // dump reaches the sink as a stream. Unlike the Python port, where stream=True
  // was an explicit flag that could be left off, `response.body` IS the stream
  // in Node, so this test guards the decision rather than driving it.
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, chunks: [new Uint8Array([7, 8])] }],
  ]);
  await client.login();
  let seen = null;
  const bytes = await client.backupDatabase(async (body) => {
    seen = body;
    let total = 0;
    for await (const c of body)
      total += c.length;
    return total;
  });
  assert.ok(seen instanceof ReadableStream);
  assert.equal(bytes, 2);
});

test("fileSink writes the dump byte for byte", async () => {
  // Opaque binary: bytes that are not valid UTF-8 must survive untouched.
  const dump = new Uint8Array([0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x1a, 0x80, 0x81]);
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, chunks: [dump] }],
  ]);
  await client.login();
  try {
    await client.backupDatabase(fileSink(target));
    assert.deepEqual(new Uint8Array(fs.readFileSync(target)), dump);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup hands the sink every chunk, in order", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", {
        status: 200,
        chunks: [new Uint8Array([1, 1, 1]), new Uint8Array([2, 2]), new Uint8Array([3])],
      }],
  ]);
  await client.login();
  const { sink, chunks } = collectingSink();
  await client.backupDatabase(sink);
  assert.deepEqual(chunks.map((c) => Array.from(c)), [[1, 1, 1], [2, 2], [3]]);
});

test("backup returns the number of bytes written", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", {
        status: 200,
        chunks: [new Uint8Array(3), new Uint8Array(4)],
      }],
  ]);
  await client.login();
  assert.equal(await client.backupDatabase(collectingSink().sink), 7);
});

test("backup rejects an empty dump and leaves no file behind", async () => {
  // A zero byte body is never a valid dump, and half a backup is worse than none.
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, chunks: [] }],
  ]);
  await client.login();
  try {
    await assert.rejects(() => client.backupDatabase(fileSink(target)), ApiError);
    assert.equal(fs.existsSync(target), false);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup throws AuthError on 401", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 401, chunks: [new Uint8Array([1])] }],
  ]);
  await client.login();
  await assert.rejects(() => client.backupDatabase(collectingSink().sink), AuthError);
});

test("backup's 403 names the role and the fresh-session rule", async () => {
  // The spec's permission line is "Administrator with a fresh session", and a
  // 403 here is nearly always one of those two, so the message must say both.
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 403, chunks: [new Uint8Array([1])] }],
  ]);
  await client.login();
  await assert.rejects(() => client.backupDatabase(collectingSink().sink), (err) => {
    assert.ok(err instanceof AuthError);
    const m = err.message.toLowerCase();
    assert.ok(m.includes("administrator"), "message must name the role");
    assert.ok(m.includes("fresh session"), "message must name the fresh-session rule");
    return true;
  });
});

test("backup throws ApiError on a server error", async () => {
  // The body is non-empty on purpose: an error page must be rejected on its
  // status, not incidentally by the empty-dump check.
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", {
        status: 500,
        chunks: [new TextEncoder().encode("<html>Internal Server Error</html>")],
      }],
  ]);
  await client.login();
  await assert.rejects(() => client.backupDatabase(collectingSink().sink), ApiError);
});

// ---------------------------------------------------------------------------
// The default output name

// ---------------------------------------------------------------------------

test("the default output name carries the host and a UTC timestamp", () => {
  const moment = new Date(Date.UTC(2026, 8, 14, 3, 12, 0));
  assert.equal(defaultOutName("https://192.168.1.10:7001", moment), "nx-site-database-192-168-1-10-7001-20260914T031200Z.db");
});

test("the default output name keeps the port and drops the scheme", () => {
  // A relay address and a plain http host must both survive intact.
  const moment = new Date(Date.UTC(2026, 0, 2, 0, 0, 0));
  assert.equal(defaultOutName("https://abcd-1234.relay.vmsproxy.com", moment), "nx-site-database-abcd-1234-relay-vmsproxy-com-20260102T000000Z.db");
  assert.equal(defaultOutName("http://10.0.0.5:7001", moment), "nx-site-database-10-0-0-5-7001-20260102T000000Z.db");
});

// ---------------------------------------------------------------------------
// main(): the backup subcommand
//
// No TypeScript sample in this house tests main(), so there was no injection
// seam to copy. main() takes an optional deps argument purely so these tests
// can hand it a fake fetch; the CLI itself is unchanged.

// ---------------------------------------------------------------------------

/**
* An in-memory stand-in for process.stdout / process.stderr.
*
* An earlier version of this helper replaced `process.stdout.write` globally.
* That also swallowed the test runner's OWN output: seven passing tests
* vanished from the report and the suite still said green. Never stub the real
* streams in a test; inject them instead.
*/

export function memoryStream() {
  const chunks = [];
  const stream = {
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    end() { },
    on() { },
    once() { },
    emit() {
      return false;
    },
    text: () => Buffer.concat(chunks).toString("utf-8"),
    bytes: () => new Uint8Array(Buffer.concat(chunks)),
  };
  return stream;
}

const CREDS = [
  "--host", "https://server:7001",
  "--user", "admin",
  "--password", "secret",
  "--dotenv", "/nonexistent/.env",
];

test("backup refuses to overwrite without --force", async () => {
  const dir = tempDir();
  const target = path.join(dir, "already.db");
  fs.writeFileSync(target, "previous backup");
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["backup", "--out", target, ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /Refusing to overwrite/);
    // The guard runs before anything is sent, including the login.
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(target, "utf-8"), "previous backup");
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--force overwrites an existing file", async () => {
  const dir = tempDir();
  const target = path.join(dir, "already.db");
  fs.writeFileSync(target, "previous backup");
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "GET", {
        status: 200,
        chunks: [new TextEncoder().encode("fresh dump")],
      }],
  ]);
  const stdout = memoryStream();
  try {
    const rc = await main(["backup", "--out", target, "--force", ...CREDS], { fetchImpl, stdout });
    assert.equal(rc, 0);
    assert.equal(fs.readFileSync(target, "utf-8"), "fresh dump");
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--out - writes the dump to stdout and keeps progress off it", async () => {
  // --out - has to stay pipeable, so nothing but the dump goes to stdout.
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "GET", {
        status: 200,
        chunks: [new Uint8Array([0x00, 0xff]), new Uint8Array([0xfe, 0x01])],
      }],
  ]);
  const stdout = memoryStream();
  const stderr = memoryStream();
  const rc = await main(["backup", "--out", "-", ...CREDS], { fetchImpl, stdout, stderr });
  assert.equal(rc, 0);
  assert.deepEqual(Array.from(stdout.bytes()), [0x00, 0xff, 0xfe, 0x01]);
  assert.match(stderr.text(), /Logged in/);
});

// ---------------------------------------------------------------------------
// Restore

// ---------------------------------------------------------------------------

/** Write a dump file into a fresh temp dir and hand back both paths. */

export function dumpFile(bytes) {
  const dir = tempDir();
  const file = path.join(dir, "in.db");
  fs.writeFileSync(file, bytes);
  return { dir, file };
}

test("restore posts to the site database endpoint", async () => {
  const { dir, file } = dumpFile("a dump");
  const { client, calls } = makeClient([
    LOGIN_OK,
    ["/site/database", "POST", { status: 200 }],
  ]);
  await client.login();
  try {
    await client.restoreDatabase(file);
    const last = calls[calls.length - 1];
    assert.equal(last.method, "POST");
    assert.equal(last.url, "https://server:7001/rest/v4/site/database");
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore sends the octet-stream content type", async () => {
  // The spec declares the request body as application/octet-stream.
  const { dir, file } = dumpFile("a dump");
  const { client, calls } = makeClient([
    LOGIN_OK,
    ["/site/database", "POST", { status: 200 }],
  ]);
  await client.login();
  try {
    await client.restoreDatabase(file);
    assert.equal(calls[calls.length - 1].headers["Content-Type"], "application/octet-stream");
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore sends the file bytes unchanged", async () => {
  // No multipart wrapper, no base64, no text encoding: the raw dump.
  const payload = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x81, 0x0d, 0x0a]);
  const { dir, file } = dumpFile(payload);
  const { client, calls } = makeClient([
    LOGIN_OK,
    ["/site/database", "POST", { status: 200 }],
  ]);
  await client.login();
  try {
    await client.restoreDatabase(file);
    const body = calls[calls.length - 1].body;
    // A Blob backed by the file (Node 19.8+) or the raw bytes (older Node).
    const sent = body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body;
    assert.ok(sent instanceof Uint8Array, "the body must be raw bytes");
    assert.deepEqual(Array.from(sent), Array.from(payload));
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// main(): the restore subcommand and its guards

// ---------------------------------------------------------------------------

test("restore refuses a missing file", async () => {
  const dir = tempDir();
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["restore", path.join(dir, "nope.db"), "--yes", ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /No such dump/);
    assert.deepEqual(calls, []);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses a zero byte file", async () => {
  // A zero byte file is not a dump, and finding that out from the server would
  // mean having already asked it to replace the site.
  const { dir, file } = dumpFile("");
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["restore", file, "--yes", ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /empty/i);
    assert.deepEqual(calls, []);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses without --yes", async () => {
  // Loading a dump replaces the whole site and restarts the server, so it
  // never happens by accident.
  const { dir, file } = dumpFile("a dump");
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["restore", file, ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /--yes/);
    assert.deepEqual(calls, []);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const status of [401, 403]) {
  test(`restore throws AuthError on ${status}`, async () => {
    const { dir, file } = dumpFile("a dump");
    const { client } = makeClient([
      LOGIN_OK,
      ["/site/database", "POST", { status }],
    ]);
    await client.login();
    try {
      await assert.rejects(() => client.restoreDatabase(file), (err) => {
        assert.ok(err instanceof AuthError);
        const m = err.message.toLowerCase();
        assert.ok(m.includes("administrator") && m.includes("fresh session"));
        return true;
      });
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("restore treats a dropped connection as success", async () => {
  // The spec says the server restarts after loading, so it can cut the
  // connection before answering. That is the success path, not a failure.
  //
  // This is the one place the Python port could not be copied literally.
  // There, requests raises ConnectionError. Node's fetch rejects with a
  // TypeError whose `cause` carries the socket-level code, so the detection
  // is on cause.code rather than on the exception class.
  const { dir, file } = dumpFile("a dump");
  const dropped = new TypeError("fetch failed");
  dropped.cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "POST", { throws: dropped }],
  ]);
  await client.login();
  try {
    await client.restoreDatabase(file); // must not reject
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("restore does not log out afterwards", async () => {
  // The restart ends the session by itself; a DELETE would only produce a
  // confusing connection error after a successful restore.
  const { dir, file } = dumpFile("a dump");
  const { fetchImpl, calls } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "POST", { status: 200 }],
  ]);
  const stdout = memoryStream();
  try {
    const rc = await main(["restore", file, "--yes", ...CREDS], { fetchImpl, stdout });
    assert.equal(rc, 0);
    assert.deepEqual(calls.filter((c) => c.method === "DELETE"), []);
    assert.match(stdout.text(), /restarting/);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Session handling

// ---------------------------------------------------------------------------

test("every run logs in immediately before its own call", async () => {
  // "Administrator with a fresh session" is the spec's own permission line, so
  // the login must be the call right before the database call, and there must
  // be no way to hand the sample a token minted earlier.
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  const backup = fakeFetch([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, chunks: [new Uint8Array([1])] }],
  ]);
  const restore = fakeFetch([LOGIN_OK, ["/site/database", "POST", { status: 200 }]]);
  const file = path.join(dir, "in.db");
  fs.writeFileSync(file, "a dump");
  try {
    await main(["backup", "--out", target, ...CREDS], {
      fetchImpl: backup.fetchImpl,
      stdout: memoryStream(),
    });
    const backupSteps = backup.calls.map((c) => [c.method, c.url.split("/rest/v4").pop()]);
    assert.deepEqual(backupSteps[0], ["POST", "/login/sessions"]);
    assert.deepEqual(backupSteps[1], ["GET", "/site/database"]);
    await main(["restore", file, "--yes", ...CREDS], {
      fetchImpl: restore.fetchImpl,
      stdout: memoryStream(),
    });
    const restoreSteps = restore.calls.map((c) => [c.method, c.url.split("/rest/v4").pop()]);
    assert.deepEqual(restoreSteps[0], ["POST", "/login/sessions"]);
    assert.deepEqual(restoreSteps[1], ["POST", "/site/database"]);
    // No token can be supplied: not by flag on either subcommand, and not by
    // config. Check both subcommands, not just the parser in general.
    for (const command of ["backup", "restore"]) {
      assert.throws(() => parseArgs([command, "x", "--token", "stale-token"]), /Unknown argument/);
    }
    assert.equal("token" in resolveConfig({}, { NX_SERVER_TOKEN: "stale-token" }, {}), false);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup logs out, and survives a logout that fails", async () => {
  // The dump is already safely on disk, so a logout that cannot be delivered
  // must not turn a successful backup into a failure.
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  const ok = fakeFetch([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, chunks: [new TextEncoder().encode("dump")] }],
  ]);
  try {
    const rc = await main(["backup", "--out", target, ...CREDS], {
      fetchImpl: ok.fetchImpl,
      stdout: memoryStream(),
    });
    assert.equal(rc, 0);
    assert.deepEqual(ok.calls.filter((c) => c.method === "DELETE").map((c) => c.url), ["https://server:7001/rest/v4/login/sessions/tok-1"]);
    const broken = fakeFetch([
      LOGIN_OK,
      ["/site/database", "GET", { status: 200, chunks: [new TextEncoder().encode("dump")] }],
      ["/login/sessions/tok-1", "DELETE", { throws: new TypeError("fetch failed") }],
    ]);
    const rc2 = await main(["backup", "--out", target, "--force", ...CREDS], {
      fetchImpl: broken.fetchImpl,
      stdout: memoryStream(),
    });
    assert.equal(rc2, 0);
    assert.equal(fs.readFileSync(target, "utf-8"), "dump");
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI error paths

// ---------------------------------------------------------------------------

test("no subcommand prints usage and exits 2", async () => {
  const stderr = memoryStream();
  const rc = await main([], { stderr });
  assert.equal(rc, 2);
  assert.match(stderr.text(), /backup/);
  assert.match(stderr.text(), /restore/);
});

test("an auth failure exits 1 without a stack trace", async () => {
  const dir = tempDir();
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "GET", { status: 403, chunks: [new Uint8Array([1])] }],
  ]);
  const stderr = memoryStream();
  try {
    const rc = await main(["backup", "--out", path.join(dir, "out.db"), ...CREDS], { fetchImpl, stdout: memoryStream(), stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /ERROR:/);
    assert.doesNotMatch(stderr.text(), /at .*\(/); // no stack frames
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a TLS rejection exits 1 and points at --insecure", async () => {
  const dir = tempDir();
  const selfSigned = new TypeError("fetch failed");
  selfSigned.cause = Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
  const { fetchImpl } = fakeFetch([["/login/sessions", "POST", { throws: selfSigned }]]);
  const stderr = memoryStream();
  try {
    const rc = await main(["backup", "--out", path.join(dir, "out.db"), ...CREDS], { fetchImpl, stdout: memoryStream(), stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /--insecure/);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Failures midway: a rejected load, a cut transfer, a slow pipe
// ---------------------------------------------------------------------------

/** A web ReadableStream that delivers some chunks, then loses the connection. */
export function streamThenDrop(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.error(new TypeError("terminated"));
    },
  });
}

for (const status of [400, 500]) {
  test(`restore throws ApiError on ${status}, so a rejected dump is not reported as applied`, async () => {
    const { dir, file } = dumpFile("a dump");
    const { client } = makeClient([
      LOGIN_OK,
      ["/site/database", "POST", { status }],
    ]);
    await client.login();
    try {
      await assert.rejects(() => client.restoreDatabase(file), (err) => {
        assert.ok(err instanceof ApiError);
        assert.match(err.message, /not applied/);
        return true;
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a rejected restore exits 1 and never says Accepted", async () => {
  const { dir, file } = dumpFile("a dump");
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "POST", { status: 500 }],
  ]);
  const stdout = memoryStream();
  const stderr = memoryStream();
  try {
    const rc = await main(["restore", file, "--yes", ...CREDS], { fetchImpl, stdout, stderr });
    assert.equal(rc, 1);
    assert.doesNotMatch(stdout.text(), /Accepted/);
    assert.match(stderr.text(), /HTTP 500/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a backup cut off midway leaves no file behind", async () => {
  // Half a dump on disk would pass for a backup until the day it is needed.
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  try {
    await assert.rejects(() =>
      fileSink(target)(streamThenDrop([new TextEncoder().encode("first half ")])),
    );
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a backup cut off midway keeps the previous backup under --force", async () => {
  const dir = tempDir();
  const target = path.join(dir, "already.db");
  fs.writeFileSync(target, "previous backup");
  const { fetchImpl: base } = fakeFetch([LOGIN_OK]);
  // The shared fake only builds clean streams, so wrap it for the dump call.
  const fetchImpl = (async (input, init = {}) => {
    if (String(input).includes("/site/database")) {
      return { status: 200, ok: true, body: streamThenDrop([new TextEncoder().encode("half")]) };
    }
    return base(input, init);
  });
  try {
    const rc = await main(["backup", "--out", target, "--force", ...CREDS], {
      fetchImpl,
      stdout: memoryStream(),
      stderr: memoryStream(),
    });
    assert.equal(rc, 1);
    assert.equal(fs.readFileSync(target, "utf-8"), "previous backup");
    assert.deepEqual(fs.readdirSync(dir), ["already.db"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("streamSink waits for drain when the output pushes back", async () => {
  // Ignoring write()'s false is what let the whole dump pile up in memory.
  const out = new EventEmitter();
  let writes = 0;
  let full = false;
  out.write = () => {
    // A write while the last one is still waiting for drain is the bug.
    assert.equal(full, false, "wrote again before the output drained");
    writes += 1;
    full = true;
    setImmediate(() => {
      full = false;
      out.emit("drain");
    });
    return false;
  };
  const sink = streamSink(out);
  const written = await sink(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]));
  assert.equal(written, 3);
  assert.equal(writes, 2);
});

test("--out - piped to a slow reader delivers every byte", async () => {
  // The one test here that runs the real script: the bug lived in how the
  // process exits, which an in-process call to main() cannot see. The server
  // is a loopback fake on an ephemeral port, still nothing leaves the machine.
  const size = 8 * 1024 * 1024;
  const server = http.createServer((req, res) => {
    if (req.url.endsWith("/login/sessions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "tok-1" }));
    } else if (req.url.endsWith("/site/database")) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(size, 7));
    } else {
      res.writeHead(200);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address();
  try {
    const script = fileURLToPath(new URL("./rest_backup_site_database.mjs", import.meta.url));
    const child = spawn(process.execPath, [
      script, "backup", "--out", "-",
      "--host", `http://127.0.0.1:${port}`, "--user", "admin", "--password", "secret",
      "--dotenv", "/nonexistent/.env",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    // Read slowly at first, so the child has output queued when it finishes.
    child.stdout.pause();
    setTimeout(() => child.stdout.resume(), 300);
    let received = 0;
    child.stdout.on("data", (chunk) => {
      received += chunk.length;
    });
    const [code] = await once(child, "close");
    assert.equal(code, 0);
    assert.equal(received, size);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Timeouts, and the session left behind by a failure
// ---------------------------------------------------------------------------

/** A fetch whose dump body is whatever `makeBody` builds; login answers as usual. */
function fetchWithDumpBody(makeBody) {
  const { fetchImpl: base, calls } = fakeFetch([LOGIN_OK]);
  const fetchImpl = (async (input, init = {}) => {
    if (String(input).includes("/site/database")) {
      return { status: 200, ok: true, body: makeBody() };
    }
    return base(input, init);
  });
  return { fetchImpl, calls };
}

test("a dump that goes silent is stopped, with a message that says so", async () => {
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  // One chunk, then nothing, forever.
  const { fetchImpl } = fetchWithDumpBody(() => new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
    },
  }));
  const client = new NxServerClient("https://server:7001", "admin", "secret", {
    fetchImpl,
    timeout: 50,
  });
  await client.login();
  try {
    await assert.rejects(() => client.backupDatabase(fileSink(target)), (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /stopped sending/);
      return true;
    });
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a dump that keeps arriving may take longer than the timeout", async () => {
  // The limit is on silence, not on the whole transfer: six chunks 20 ms apart
  // take well over the 50 ms limit and must still succeed.
  const { fetchImpl } = fetchWithDumpBody(() => {
    let sent = 0;
    return new ReadableStream({
      async pull(c) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (sent === 6) {
          c.close();
          return;
        }
        sent += 1;
        c.enqueue(new Uint8Array([sent]));
      },
    });
  });
  const client = new NxServerClient("https://server:7001", "admin", "secret", {
    fetchImpl,
    timeout: 50,
  });
  await client.login();
  let total = 0;
  const written = await client.backupDatabase(async (body) => {
    for await (const c of body) total += c.length;
    return total;
  });
  assert.equal(written, 6);
});

test("a restore with no answer in time says the outcome is unknown", async () => {
  // Not the restart (that drops the connection) and not a refusal (that
  // answers). Calling it success could hide a failed load; calling it failure
  // invites a second load into a server already restarting with the first.
  const { dir, file } = dumpFile("a dump");
  const silent = Object.assign(new Error("nothing moved"), { code: "IDLE_TIMEOUT" });
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "POST", { throws: silent }],
  ]);
  await client.login();
  try {
    await assert.rejects(() => client.restoreDatabase(file), (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /may have loaded it/);
      assert.match(err.message, /Check the server/);
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed backup still logs out", async () => {
  // The session is an administrator's. A dump that fails is no reason to leave
  // it valid on the server.
  const dir = tempDir();
  const { fetchImpl, calls } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "GET", { status: 500 }],
  ]);
  try {
    const rc = await main(["backup", "--out", path.join(dir, "out.db"), ...CREDS], {
      fetchImpl,
      stdout: memoryStream(),
      stderr: memoryStream(),
    });
    assert.equal(rc, 1);
    assert.deepEqual(
      calls.filter((c) => c.method === "DELETE").map((c) => c.url),
      ["https://server:7001/rest/v4/login/sessions/tok-1"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Parity and polish
// ---------------------------------------------------------------------------

test("restore uploads with node:http by default, not fetch", () => {
  // fetch holds a whole request body in memory; httpUpload streams it.
  const client = new NxServerClient("https://server:7001", "admin", "secret");
  assert.equal(client.uploadImpl, httpUpload);
});

test("an empty CLI flag falls through to the environment, as in the other ports", () => {
  const config = resolveConfig(
    { host: "", user: "", password: "" },
    {},
    { NX_SERVER_HOST: "https://env:7001", NX_SERVER_USER: "u", NX_SERVER_PASSWORD: "p" },
  );
  assert.equal(config.host, "https://env:7001");
  assert.equal(config.user, "u");
});

test("a value flag with nothing after it is an error, not a silent default", () => {
  assert.throws(() => parseArgs(["backup", "--out"]), /Missing value for --out/);
  assert.throws(() => parseArgs(["backup", "--host"]), /Missing value for --host/);
  assert.equal(parseArgs(["backup", "--out="]).out, "");
});

test("an unwritable --out exits 1 and blames the file, not the server", async () => {
  const dir = tempDir();
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, chunks: [new Uint8Array([1])] }],
  ]);
  const stderr = memoryStream();
  try {
    const rc = await main(
      ["backup", "--out", path.join(dir, "no-such-folder", "out.db"), ...CREDS],
      { fetchImpl, stdout: memoryStream(), stderr },
    );
    assert.equal(rc, 1);
    assert.match(stderr.text(), /could not use .*no-such-folder/);
    assert.doesNotMatch(stderr.text(), /could not reach the server/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup refuses to write the dump to a terminal", async () => {
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stdout = Object.assign(memoryStream(), { isTTY: true });
  const stderr = memoryStream();
  const rc = await main(["backup", "--out", "-", ...CREDS], { fetchImpl, stdout, stderr });
  assert.equal(rc, 1);
  assert.match(stderr.text(), /terminal/);
  assert.deepEqual(calls, []);
});

test("the default output name drops IPv6 brackets", () => {
  assert.equal(
    defaultOutName("https://[fe80::1]:7001", new Date("2026-10-01T08:09:10Z")),
    "nx-site-database-fe80--1-7001-20261001T080910Z.db",
  );
});

test("formatSize uses binary units", () => {
  // The divisor is 1024, so the honest unit names are KiB and MiB.
  assert.equal(formatSize(512), "512 bytes");
  assert.equal(formatSize(1536), "1.500 KiB");
  assert.equal(formatSize(3 * 1024 * 1024), "3.000 MiB");
});

test("the script runs when started through a symlink, as npm's bin link does", async () => {
  const dir = tempDir();
  const link = path.join(dir, "rest-backup-site-database");
  const script = fileURLToPath(new URL("./rest_backup_site_database.mjs", import.meta.url));
  fs.symlinkSync(script, link);
  try {
    const child = spawn(process.execPath, [link], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (c) => {
      err += c;
    });
    const [code] = await once(child, "close");
    // No subcommand: usage and exit 2. Before, the guard never matched through
    // the link, so the process exited 0 having done nothing at all.
    assert.equal(code, 2);
    assert.match(err, /Usage/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Where the dump lands: permissions, directories, a failed rename, a slow sink
// ---------------------------------------------------------------------------

test("the dump is readable by its owner only", { skip: process.platform === "win32" }, async () => {
  // It holds password hashes and server auth keys. Under the usual umask a
  // plain createWriteStream would make it -rw-r--r--, readable by every user.
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  // A stale side file with a loose mode must not lend the dump its mode.
  fs.writeFileSync(`${target}.partial`, "old", { mode: 0o644 });
  try {
    await fileSink(target)(streamOf([new TextEncoder().encode("dump")]));
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(target, "utf-8"), "dump");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty --out= writes the auto-named file, as in the Python port", async () => {
  const dir = tempDir();
  const before = process.cwd();
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, chunks: [new Uint8Array([1, 2])] }],
  ]);
  process.chdir(dir);
  try {
    const rc = await main(["backup", "--out=", ...CREDS], {
      fetchImpl,
      stdout: memoryStream(),
      stderr: memoryStream(),
    });
    assert.equal(rc, 0);
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^nx-site-database-server-7001-\d{8}T\d{6}Z\.db$/);
  } finally {
    process.chdir(before);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backup refuses a directory as --out, before logging in", async () => {
  const dir = tempDir();
  const folder = path.join(dir, "adir");
  fs.mkdirSync(folder);
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["backup", "--out", folder, "--force", ...CREDS], {
      fetchImpl,
      stdout: memoryStream(),
      stderr,
    });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /is a directory/);
    assert.deepEqual(calls, []);
    assert.deepEqual(fs.readdirSync(dir), ["adir"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a rename that fails leaves no partial behind", async () => {
  // The whole dump is in the side file by then, hashes and all.
  const dir = tempDir();
  const folder = path.join(dir, "adir");
  fs.mkdirSync(folder); // renaming a file onto a directory fails
  try {
    await assert.rejects(() => fileSink(folder)(streamOf([new TextEncoder().encode("dump")])));
    assert.deepEqual(fs.readdirSync(dir), ["adir"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a slow sink is not mistaken for a server that stopped sending", async () => {
  // The server has the whole dump ready at once; only the consumer is slow.
  // The timeout covers waits on the server, not the sink's own writing time.
  const { fetchImpl } = fetchWithDumpBody(() => streamOf([
    new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3]),
  ]));
  const client = new NxServerClient("https://server:7001", "admin", "secret", {
    fetchImpl,
    timeout: 50,
  });
  await client.login();
  const written = await client.backupDatabase(async (body) => {
    let total = 0;
    for await (const c of body) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      total += c.length;
    }
    return total;
  });
  assert.equal(written, 3);
});

// ---------------------------------------------------------------------------
// The real upload against a loopback server, and the remaining guards
// ---------------------------------------------------------------------------

/** A loopback server for the restore POST; `onLoad(req, res)` decides what it does. */
async function loadServer(onLoad) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url.endsWith("/site/database") && req.method === "POST") return onLoad(req, res);
    res.writeHead(200);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/rest/v4/site/database`, seen, close: () => server.close() };
}

/** Upload `bytes` with the real httpUpload, through a fresh dump file. */
async function upload(url, bytes, timeout = 5000) {
  const { dir, file } = dumpFile(bytes);
  try {
    return await httpUpload(url, { headers: { "Content-Type": "application/octet-stream" }, source: file, timeout });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Run the restore through a client on the real upload, against `url`. */
async function restoreTo(url, bytes, timeout = 5000) {
  const { dir, file } = dumpFile(bytes);
  const client = new NxServerClient(url.replace(/\/rest\/v4.*$/, ""), "admin", "secret", { timeout });
  client.token = "tok-1";
  try {
    return await client.restoreDatabase(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BIG = new Uint8Array(4 * 1024 * 1024).fill(7);

test("httpUpload sends the file with a Content-Length, unchunked and unchanged", async () => {
  let received = [];
  let headers = {};
  const srv = await loadServer((req, res) => {
    headers = req.headers;
    req.on("data", (c) => received.push(c));
    req.on("end", () => {
      res.writeHead(200);
      res.end();
    });
  });
  try {
    const bytes = new Uint8Array([0, 0xff, 0xfe, 0x80, 0x0d, 0x0a]);
    assert.deepEqual(await upload(srv.url, bytes), { status: 200, ok: true });
    assert.equal(headers["content-length"], "6");
    assert.equal(headers["transfer-encoding"], undefined);
    assert.deepEqual(Array.from(Buffer.concat(received)), Array.from(bytes));
  } finally {
    srv.close();
  }
});

test("a restore answered with a redirect is a failure, and the redirect is not followed", async () => {
  // Followed, a 302 turns the POST into a GET of the dump, which answers 200.
  const srv = await loadServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(302, { location: "/rest/v4/site/database" });
      res.end();
    });
  });
  try {
    await assert.rejects(() => restoreTo(srv.url, BIG), /HTTP 302/);
    assert.deepEqual(srv.seen, ["POST /rest/v4/site/database"]);
  } finally {
    srv.close();
  }
});

test("a connection cut partway through the upload is not success", async () => {
  const srv = await loadServer((req) => {
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n >= 128 * 1024) req.socket.destroy();
    });
  });
  try {
    await assert.rejects(() => restoreTo(srv.url, BIG), (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /lost after \d+ of 4194304 bytes/);
      assert.match(err.message, /not loaded/);
      return true;
    });
  } finally {
    srv.close();
  }
});

test("a connection dropped after the whole dump arrived is the restart, so success", async () => {
  const srv = await loadServer((req) => {
    req.resume();
    req.on("end", () => req.socket.destroy());
  });
  try {
    await restoreTo(srv.url, BIG); // must not reject
  } finally {
    srv.close();
  }
});

test("a server that stops reading the upload is reported as not loaded", async () => {
  const srv = await loadServer((req) => {
    req.once("data", () => req.pause()); // read a little, then nothing
  });
  try {
    await assert.rejects(() => restoreTo(srv.url, BIG, 300), /stopped reading the dump after/);
  } finally {
    srv.close();
  }
});

test("a slow but steady upload is not cut off by the timeout", async () => {
  // The limit is on silence: every chunk the server reads restarts it.
  const srv = await loadServer((req, res) => {
    req.on("data", () => {
      req.pause();
      setTimeout(() => req.resume(), 5);
    });
    req.on("end", () => {
      res.writeHead(200);
      res.end();
    });
  });
  try {
    const started = Date.now();
    await restoreTo(srv.url, BIG, 200);
    assert.ok(Date.now() - started > 200, "the whole upload took longer than the timeout");
  } finally {
    srv.close();
  }
});

test("the whole dump sent and no answer means the outcome is unknown", async () => {
  const srv = await loadServer((req) => req.resume()); // reads it all, never answers
  try {
    await assert.rejects(() => restoreTo(srv.url, BIG, 300), /may have loaded it/);
  } finally {
    srv.close();
  }
});

test("a boolean flag given a value is an error, so --yes=no is not yes", () => {
  for (const flag of ["--yes=no", "--yes=false", "--force=no", "--insecure=false"]) {
    assert.throws(() => parseArgs(["restore", "x.db", flag]), /takes no value/);
  }
  assert.equal(parseArgs(["restore", "x.db", "--yes"]).yes, true);
});

for (const status of [400, 500]) {
  test(`a restore refused with ${status} logs out`, async () => {
    // No restart follows a refused load, so the session would stay valid.
    const { dir, file } = dumpFile("a dump");
    const { fetchImpl, calls } = fakeFetch([LOGIN_OK, ["/site/database", "POST", { status }]]);
    try {
      const rc = await main(["restore", file, "--yes", ...CREDS], {
        fetchImpl,
        stdout: memoryStream(),
        stderr: memoryStream(),
      });
      assert.equal(rc, 1);
      assert.deepEqual(
        calls.filter((c) => c.method === "DELETE").map((c) => c.url),
        ["https://server:7001/rest/v4/login/sessions/tok-1"],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("restore refuses a directory before logging in", async () => {
  const dir = tempDir();
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["restore", dir, "--yes", ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /is a directory/);
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two backups to one --out never write into each other's side file", async () => {
  // A fixed <out>.partial let the second run delete the first's file, and the
  // first then renamed the second's half-written dump into place.
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  const slowly = (byte, n) => {
    let sent = 0;
    return new ReadableStream({
      async pull(c) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (sent === n) return c.close();
        sent += 1;
        c.enqueue(new Uint8Array(1000).fill(byte));
      },
    });
  };
  try {
    const [a, b] = await Promise.all([
      fileSink(target, { overwrite: true })(slowly(1, 20)),
      fileSink(target, { overwrite: true })(slowly(2, 10)),
    ]);
    assert.equal(a, 20000);
    assert.equal(b, 10000);
    // Whichever finished last is there whole; nothing else is left behind.
    const final = fs.readFileSync(target);
    assert.ok(final.equals(Buffer.alloc(20000, 1)) || final.equals(Buffer.alloc(10000, 2)));
    assert.deepEqual(fs.readdirSync(dir), ["out.db"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without --force a file that appears during the download is kept", async () => {
  const dir = tempDir();
  const target = path.join(dir, "out.db");
  const appearing = new ReadableStream({
    start(c) {
      fs.writeFileSync(target, "someone else's file");
      c.enqueue(new TextEncoder().encode("dump"));
      c.close();
    },
  });
  try {
    await assert.rejects(() => fileSink(target)(appearing), /Refusing to overwrite/);
    assert.equal(fs.readFileSync(target, "utf-8"), "someone else's file");
    assert.deepEqual(fs.readdirSync(dir), ["out.db"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Ctrl-C mid-backup removes the side file and logs out", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.url.endsWith("/site/database")) {
      res.writeHead(200);
      return res.write(Buffer.alloc(100000, 7)); // ...and then never finish
    }
    res.writeHead(200);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address();
  try {
    const script = fileURLToPath(new URL("./rest_backup_site_database.mjs", import.meta.url));
    const child = spawn(process.execPath, [
      script, "backup", "--out", path.join(dir, "out.db"),
      "--host", `http://127.0.0.1:${port}`, "--user", "admin", "--password", "secret",
      "--dotenv", "/nonexistent/.env",
    ], { stdio: ["ignore", "pipe", "ignore"] });
    // Wait until the dump is under way, then interrupt.
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (fs.readdirSync(dir).some((f) => f.endsWith(".partial"))) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.equal(code, 130);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.ok(seen.includes("DELETE /rest/v4/login/sessions/tok-1"), seen.join(", "));
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
