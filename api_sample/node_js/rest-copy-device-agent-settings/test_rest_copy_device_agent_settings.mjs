// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

/**
 * Offline tests for rest_copy_device_agent_settings.mjs. No network, no
 * account, no server: every HTTP call goes through an injected fake `fetch`.
 * That is a hard requirement, a test that needs a live server cannot run in
 * CI, so it does not get written.
 *
 * What is worth testing in a sample:
 *   - the auth flow sends what the API expects, and stores the token
 *   - each documented failure mode raises the right error
 *   - response shapes the server really returns are all handled (v4 envelopes!)
 *   - config precedence: CLI > env > .env
 *   - the PUT body keeps only the fields that are really configuration
 *
 * Run from this folder:  node --test test_rest_copy_device_agent_settings.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  NxServerClient,
  resolveConfig,
  loadEnvFile,
  parseArgs,
  buildApplyBody,
  defaultOutputName,
  main,
  saveSettingsFile,
  wasNotSent,
  isTlsFailure,
  AuthError,
  ApiError,
  OutcomeUnknownError,
} from "./rest_copy_device_agent_settings.mjs";

// ---------------------------------------------------------------------------
// Fake HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Build a fake fetch plus the list it records into. Replies are matched by a
 * substring of the URL and the method, so a test says what it means rather
 * than counting calls.
 */
export function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: { ...(init.headers ?? {}) },
      body: init.body,
      redirect: init.redirect,
    });
    const match = replies.find(([suffix, m]) => url.includes(suffix) && m === method);
    const reply = match ? match[2] : { status: 200, json: {} };
    if (reply.throws) throw reply.throws;
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      // `text` is the raw body; `json` is shorthand for a JSON body.
      text: async () => {
        if (reply.bodyThrows) throw reply.bodyThrows;
        if (reply.text !== undefined) return reply.text;
        return reply.json === undefined ? "" : JSON.stringify(reply.json);
      },
    };
  };
  return { fetchImpl, calls };
}

const LOGIN_OK = ["/login/sessions", "POST", { status: 200, json: { token: "tok-1" } }];

export function makeClient(replies) {
  const { fetchImpl, calls } = fakeFetch(replies);
  const client = new NxServerClient("https://server:7001", { fetchImpl });
  return { client, calls };
}

/** A fresh temp directory, removed by the caller. */
export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nx-copy-device-agent-settings-test-"));
}

const SETTINGS_URL = "/analytics/engines/engine-1/deviceAgents/device-1/settings";

const BARE_SETTINGS = {
  deviceId: "device-1",
  engineId: "engine-1",
  values: { sensitivity: 50 },
  model: { sensitivity: { type: "SpinBox" } },
  _error: {},
  analyzedStream: "primary",
  disableStreamSelection: false,
};

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test("login posts credentials and stores the token", async () => {
  const { client, calls } = makeClient([LOGIN_OK]);

  const token = await client.login("admin", "secret");

  assert.equal(token, "tok-1");
  assert.equal(client.token, "tok-1");
  assert.deepEqual(JSON.parse(String(calls[0].body)), { username: "admin", password: "secret" });
  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/rest/v4/login/sessions"));
});

for (const status of [401, 403]) {
  test(`login unauthorized (${status}) throws AuthError`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", { status }]]);
    await assert.rejects(() => client.login("admin", "wrong"), AuthError);
  });
}

test("login without a token in the response throws ApiError", async () => {
  const { client } = makeClient([["/login/sessions", "POST", { status: 200, json: {} }]]);
  await assert.rejects(() => client.login("admin", "secret"), ApiError);
});

// ---------------------------------------------------------------------------
// downloadSettings(): GET .../settings
// ---------------------------------------------------------------------------

test("downloadSettings sends GET to the engine and device path", async () => {
  const { client, calls } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "GET", { status: 200, json: BARE_SETTINGS }],
  ]);
  await client.login("admin", "secret");

  const result = await client.downloadSettings("engine-1", "device-1");

  assert.deepEqual(result, BARE_SETTINGS);
  const last = calls[calls.length - 1];
  assert.equal(last.method, "GET");
  assert.ok(last.url.endsWith(SETTINGS_URL));
  assert.equal(last.headers["Authorization"], "Bearer tok-1");
});

test("downloadSettings unwraps the v4 reply envelope", async () => {
  // v4 can wrap a single object in {"reply": {...}} as it does for arrays.
  const { client } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "GET", { status: 200, json: { reply: BARE_SETTINGS } }],
  ]);
  await client.login("admin", "secret");

  assert.deepEqual(await client.downloadSettings("engine-1", "device-1"), BARE_SETTINGS);
});

test("downloadSettings without login throws ApiError", async () => {
  const { client } = makeClient([]);
  await assert.rejects(() => client.downloadSettings("engine-1", "device-1"), ApiError);
});

// ---------------------------------------------------------------------------
// buildApplyBody(): the PUT request body the spec defines
// ---------------------------------------------------------------------------

test("buildApplyBody drops the URL-identified fields and the source's _error", () => {
  // deviceId/engineId are not even in the spec's PUT request body: the URL
  // already identifies the device and engine. _error is the source device's
  // error report, which must not be echoed onto the target. Everything else
  // (values, model, analyzedStream, disableStreamSelection) is forwarded
  // unchanged.
  const body = buildApplyBody({ ...BARE_SETTINGS, _error: { sensitivity: "too high" } });

  assert.deepEqual(body, {
    values: { sensitivity: 50 },
    model: { sensitivity: { type: "SpinBox" } },
    analyzedStream: "primary",
    disableStreamSelection: false,
  });
  assert.ok(!("deviceId" in body));
  assert.ok(!("engineId" in body));
  assert.ok(!("_error" in body));
});

test("buildApplyBody refuses anything but a JSON object", () => {
  // Object.entries([]) is [], so an array would have become an empty body.
  for (const value of [[], [1, 2], null, "x", 3]) {
    assert.throws(() => buildApplyBody(value), TypeError);
  }
});

test("buildApplyBody omits a field absent from the input", () => {
  // A partial settings file must not send a field back as null.
  const body = buildApplyBody({ values: { sensitivity: 50 } });

  assert.deepEqual(body, { values: { sensitivity: 50 } });
  assert.ok(!("analyzedStream" in body));
  assert.ok(!("disableStreamSelection" in body));
  assert.ok(!("model" in body));
  assert.ok(!("_error" in body));
});

// ---------------------------------------------------------------------------
// applySettings(): PUT .../settings
// ---------------------------------------------------------------------------

test("applySettings sends PUT with the body to the engine and device path", async () => {
  const { client, calls } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 200, json: BARE_SETTINGS }],
  ]);
  await client.login("admin", "secret");
  const body = { values: { sensitivity: 50 } };

  await client.applySettings("engine-1", "device-1", body);

  const last = calls[calls.length - 1];
  assert.equal(last.method, "PUT");
  assert.ok(last.url.endsWith(SETTINGS_URL));
  assert.deepEqual(JSON.parse(String(last.body)), body);
  assert.equal(last.headers["Authorization"], "Bearer tok-1");
});

test("applySettings without login throws ApiError", async () => {
  const { client } = makeClient([]);
  await assert.rejects(() => client.applySettings("engine-1", "device-1", {}), ApiError);
});

// ---------------------------------------------------------------------------
// defaultOutputName(): the auto-named download destination
// ---------------------------------------------------------------------------

test("defaultOutputName includes the device id and a UTC timestamp", () => {
  const moment = new Date(Date.UTC(2026, 8, 16, 3, 12, 0));

  const name = defaultOutputName("device-1", moment);

  assert.equal(name, "nx-device-agent-settings-device-1-20260916T031200Z.json");
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test("logout deletes the session and clears the token", async () => {
  const { client, calls } = makeClient([LOGIN_OK]);
  await client.login("admin", "secret");

  await client.logout();

  const last = calls[calls.length - 1];
  assert.equal(last.method, "DELETE");
  assert.ok(last.url.endsWith("/rest/v4/login/sessions/tok-1"));
  assert.equal(client.token, null);
});

test("logout without a token is a no-op", async () => {
  const { client, calls } = makeClient([]);
  await client.logout();
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test("config reads the server and sample env vars", () => {
  const config = resolveConfig({}, {}, {
    NX_SERVER_HOST: "https://from-env:7001",
    NX_SERVER_USER: "envuser",
    NX_SERVER_PASSWORD: "envpass",
    NX_DEVICE_ID: "device-env",
    NX_ANALYTICS_ENGINE_ID: "engine-env",
  });

  assert.deepEqual(config, {
    host: "https://from-env:7001",
    user: "envuser",
    password: "envpass",
    deviceId: "device-env",
    engineId: "engine-env",
  });
});

test("a CLI flag beats env, which beats the dotenv file", () => {
  const env = { NX_ANALYTICS_ENGINE_ID: "engine-env" };
  const dotenv = { NX_ANALYTICS_ENGINE_ID: "engine-dotenv" };

  assert.equal(resolveConfig({ engineId: "engine-cli" }, dotenv, env).engineId, "engine-cli");
  assert.equal(resolveConfig({}, dotenv, env).engineId, "engine-env");
  assert.equal(resolveConfig({}, dotenv, {}).engineId, "engine-dotenv");
});

test("a trailing slash is stripped from the host", () => {
  assert.equal(resolveConfig({ host: "https://server:7001/" }, {}, {}).host, "https://server:7001");
});

test("loadEnvFile returns an empty object for a missing file", () => {
  assert.deepEqual(loadEnvFile("/nonexistent/.env"), {});
});

test("--dotenv is the config flag here, not --env-file", () => {
  assert.equal(parseArgs(["download", "--dotenv", "../../.env"]).envFile, "../../.env");
  assert.throws(() => parseArgs(["download", "--env-file", "../../.env"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// main(): shared CLI behaviour
// ---------------------------------------------------------------------------

/**
 * An in-memory stand-in for process.stdout / process.stderr.
 *
 * Never stub the real streams in a test; inject them instead, or the test
 * runner's own output vanishes along with whatever else was stubbed.
 */
export function memoryStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    text: () => Buffer.concat(chunks).toString("utf-8"),
  };
}

const CREDS = [
  "--host", "https://server:7001",
  "--user", "admin",
  "--password", "secret",
  "--device-id", "device-1",
  "--engine-id", "engine-1",
  "--dotenv", "/nonexistent/.env",
];

test("no subcommand prints usage and exits 2", async () => {
  const stderr = memoryStream();
  const rc = await main([], { stderr });
  assert.equal(rc, 2);
  assert.match(stderr.text(), /download/);
});

// ---------------------------------------------------------------------------
// main(): the download subcommand
// ---------------------------------------------------------------------------

test("download refuses to overwrite without --force", async () => {
  const dir = tempDir();
  const target = path.join(dir, "already.json");
  fs.writeFileSync(target, '{"previous": true}');
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["download", "--out", target, ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /already exists; use --force/);
    // The guard runs before anything is sent, including the login.
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), { previous: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download writes the settings file and succeeds", async () => {
  const dir = tempDir();
  const target = path.join(dir, "settings.json");
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    [SETTINGS_URL, "GET", { status: 200, json: BARE_SETTINGS }],
  ]);
  const stdout = memoryStream();
  try {
    const rc = await main(["download", "--out", target, ...CREDS], { fetchImpl, stdout });
    assert.equal(rc, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), BARE_SETTINGS);
    assert.match(stdout.text(), /device-1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// main(): the apply subcommand
// ---------------------------------------------------------------------------

test("apply refuses without --yes", async () => {
  const dir = tempDir();
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify(BARE_SETTINGS));
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", settingsFile, ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /--yes/);
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("apply succeeds and sends the PUT body the spec defines", async () => {
  const dir = tempDir();
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify(BARE_SETTINGS));
  const { fetchImpl, calls } = fakeFetch([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 200, json: BARE_SETTINGS }],
  ]);
  const stdout = memoryStream();
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", settingsFile, "--yes", ...CREDS], { fetchImpl, stdout, stderr });
    assert.equal(rc, 0);
    const putCalls = calls.filter((c) => c.method === "PUT");
    assert.deepEqual(JSON.parse(String(putCalls[0].body)), {
      values: { sensitivity: 50 },
      model: { sensitivity: { type: "SpinBox" } },
      analyzedStream: "primary",
      disableStreamSelection: false,
    });
    assert.match(stdout.text(), /device-1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("apply reports failure when the PUT is rejected", async () => {
  const dir = tempDir();
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify(BARE_SETTINGS));
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 403 }],
  ]);
  const stdout = memoryStream();
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", settingsFile, "--yes", ...CREDS], { fetchImpl, stdout, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /ERROR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("apply refuses a missing file", async () => {
  const dir = tempDir();
  const missing = path.join(dir, "nope.json");
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", missing, "--yes", ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /No such settings file/);
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Redirects, response shapes, sessions, guards
// ---------------------------------------------------------------------------

/** A settings file in a fresh temp dir; `content` is written as-is if a string. */
function settingsFile(content = BARE_SETTINGS) {
  const dir = tempDir();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return { dir, file };
}

/** Run main() with a fake fetch; returns rc, output and the recorded calls. */
async function run(argv, replies) {
  const { fetchImpl, calls } = fakeFetch(replies);
  const stdout = memoryStream();
  const stderr = memoryStream();
  const rc = await main(argv, { fetchImpl, stdout, stderr });
  return { rc, out: stdout.text(), err: stderr.text(), calls };
}

const deletes = (calls) => calls.filter((c) => c.method === "DELETE").map((c) => c.url);
const LOGOUT_URL = "https://server:7001/rest/v4/login/sessions/tok-1";

test("every request asks fetch not to follow redirects", async () => {
  const { file, dir } = settingsFile();
  try {
    const { calls } = await run(["apply", file, "--yes", ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { status: 200 }],
    ]);
    assert.equal(calls.length, 3);
    for (const call of calls) assert.equal(call.redirect, "manual", call.method);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [method, verb] of [["PUT", "apply"], ["GET", "download"]]) {
  test(`${verb} answered with a redirect fails and still logs out`, async () => {
    const { file, dir } = settingsFile();
    const argv = verb === "apply"
      ? ["apply", file, "--yes", ...CREDS]
      : ["download", "--out", path.join(dir, "out.json"), ...CREDS];
    try {
      const { rc, err, calls } = await run(argv, [
        LOGIN_OK,
        [SETTINGS_URL, method, { status: 302 }],
      ]);
      assert.equal(rc, 1);
      assert.match(err, /HTTP 302 \(redirect not followed\)/);
      assert.deepEqual(deletes(calls), [LOGOUT_URL]);
      assert.ok(!fs.existsSync(path.join(dir, "out.json")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a login answered with a redirect is a login failure", async () => {
  const { rc, err } = await run(["download", ...CREDS, "--out", "/nonexistent/x.json"], [
    ["/login/sessions", "POST", { status: 307 }],
  ]);
  assert.equal(rc, 1);
  assert.match(err, /Login failed: HTTP 307 \(redirect not followed\)\./);
});

/** A loopback server; `onRequest(req, res)` handles everything but login and logout. */
async function loopback(onRequest) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    return onRequest(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address();
  return {
    host: `http://127.0.0.1:${port}`,
    seen,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const loopbackCreds = (host) => [
  "--host", host, "--user", "admin", "--password", "secret",
  "--device-id", "device-1", "--engine-id", "engine-1", "--dotenv", "/nonexistent/.env",
];

test("with the real fetch, a 302 on the PUT is not followed", async () => {
  const srv = await loopback((req, res) => {
    req.resume();
    res.writeHead(302, { location: "/elsewhere" });
    res.end();
  });
  const { file, dir } = settingsFile();
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", file, "--yes", ...loopbackCreds(srv.host)], {
      stdout: memoryStream(),
      stderr,
    });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /HTTP 302 \(redirect not followed\)/);
    assert.ok(!srv.seen.some((s) => s.includes("/elsewhere")), srv.seen.join(", "));
    assert.ok(srv.seen.includes("DELETE /rest/v4/login/sessions/tok-1"));
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("with the real fetch, a connection dropped after the PUT is an unknown outcome", async () => {
  const srv = await loopback((req) => {
    req.resume();
    req.on("end", () => req.socket.destroy());
  });
  const { file, dir } = settingsFile();
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", file, "--yes", ...loopbackCreds(srv.host)], {
      stdout: memoryStream(),
      stderr,
    });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /Outcome unknown: the connection was lost after the settings were sent/);
    assert.doesNotMatch(stderr.text(), /not applied/);
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused connection on apply says the settings were not applied", async () => {
  // Port 1 on loopback: nothing listens there.
  const { file, dir } = settingsFile();
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", file, "--yes", ...loopbackCreds("http://127.0.0.1:1")], {
      stdout: memoryStream(),
      stderr,
    });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /^ERROR: could not reach the server: .*settings were not applied/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const fetchFailed = (code) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

for (const code of ["UND_ERR_SOCKET", "ECONNRESET", "UND_ERR_HEADERS_TIMEOUT"]) {
  test(`a PUT that fails with ${code} has an unknown outcome`, async () => {
    const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { throws: fetchFailed(code) }]]);
    await client.login("admin", "secret");
    await assert.rejects(() => client.applySettings("engine-1", "device-1", {}), OutcomeUnknownError);
  });
}

test("a PUT whose answer body is cut off has an unknown outcome", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 200, bodyThrows: fetchFailed("UND_ERR_SOCKET") }],
  ]);
  await client.login("admin", "secret");
  await assert.rejects(() => client.applySettings("engine-1", "device-1", {}), OutcomeUnknownError);
});

test("a PUT with no answer in time has an unknown outcome", async () => {
  const fetchImpl = (_url, init) =>
    init.method === "PUT"
      ? new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      : Promise.resolve({ status: 200, text: async () => JSON.stringify({ token: "tok-1" }) });
  const client = new NxServerClient("https://server:7001", { fetchImpl, timeout: 50 });
  await client.login("admin", "secret");
  await assert.rejects(() => client.applySettings("engine-1", "device-1", {}), OutcomeUnknownError);
});

test("a request with no answer in time says 'no answer within <n> s'", async () => {
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const client = new NxServerClient("https://server:7001", { fetchImpl, timeout: 50 });
  await assert.rejects(() => client.login("admin", "secret"), (err) => {
    assert.equal(err.code, "TIMEOUT");
    assert.equal(err.message, "no answer within 0.05 s");
    return true;
  });
});

const NEVER_CONNECTED = [
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN",
  "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT",
];
const TLS_FAILURES = [
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "CERT_SIGNATURE_FAILURE", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER", "SOME_CERT_PROBLEM", "SOMETHING_SELF_SIGNED",
];

test("isTlsFailure is true for the TLS codes only", () => {
  for (const code of TLS_FAILURES) assert.equal(isTlsFailure(fetchFailed(code)), true, code);
  for (const code of [...NEVER_CONNECTED, "ECONNRESET", "UND_ERR_SOCKET", "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC"]) {
    assert.equal(isTlsFailure(fetchFailed(code)), false, code);
  }
});

for (const code of [...NEVER_CONNECTED, ...TLS_FAILURES]) {
  test(`a PUT that fails with ${code} was not sent`, async () => {
    assert.equal(wasNotSent(fetchFailed(code)), true);
    const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { throws: fetchFailed(code) }]]);
    await client.login("admin", "secret");
    await assert.rejects(
      () => client.applySettings("engine-1", "device-1", {}),
      (err) => !(err instanceof OutcomeUnknownError),
    );
  });
}

for (const [label, reply] of [
  ["an empty body", { status: 200, text: "" }],
  ["a 204", { status: 204, text: "" }],
  ["a non-JSON body", { status: 200, text: "OK" }],
  ["JSON with an empty _error", { status: 200, json: { ...BARE_SETTINGS, _error: {} } }],
]) {
  test(`apply answered with ${label} succeeds and logs out`, async () => {
    const { file, dir } = settingsFile();
    try {
      const { rc, out, calls } = await run(["apply", file, "--yes", ...CREDS], [
        LOGIN_OK,
        [SETTINGS_URL, "PUT", reply],
      ]);
      assert.equal(rc, 0);
      assert.match(out, /Applied Device Agent settings/);
      assert.deepEqual(deletes(calls), [LOGOUT_URL]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("apply reports the Engine's _error map as a failure", async () => {
  const { file, dir } = settingsFile();
  try {
    const { rc, out, err, calls } = await run(["apply", file, "--yes", ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", {
        status: 200,
        json: { ...BARE_SETTINGS, _error: { sensitivity: "out of range", mode: "unknown" } },
      }],
    ]);
    assert.equal(rc, 1);
    assert.match(err, /The server took the settings but the Engine reported errors:/);
    assert.match(err, /sensitivity: out of range/);
    assert.match(err, /mode: unknown/);
    assert.doesNotMatch(out, /Applied/);
    assert.deepEqual(deletes(calls), [LOGOUT_URL]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const status of [400, 403, 500]) {
  test(`apply refused with ${status} still logs out`, async () => {
    const { file, dir } = settingsFile();
    try {
      const { rc, calls } = await run(["apply", file, "--yes", ...CREDS], [
        LOGIN_OK,
        [SETTINGS_URL, "PUT", { status }],
      ]);
      assert.equal(rc, 1);
      assert.deepEqual(deletes(calls), [LOGOUT_URL]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a failed logout after a successful apply is only a warning", async () => {
  const { file, dir } = settingsFile();
  try {
    const { rc, out, err } = await run(["apply", file, "--yes", ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { status: 200 }],
      ["/login/sessions/tok-1", "DELETE", { throws: fetchFailed("ECONNRESET") }],
    ]);
    assert.equal(rc, 0);
    assert.match(out, /Applied Device Agent settings/);
    assert.match(err, /^WARNING: could not log out/);
    assert.doesNotMatch(err, /ERROR/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed logout after a successful download is only a warning", async () => {
  const dir = tempDir();
  const target = path.join(dir, "out.json");
  try {
    const { rc, err } = await run(["download", "--out", target, ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { status: 200, json: BARE_SETTINGS }],
      ["/login/sessions/tok-1", "DELETE", { status: 500 }],
    ]);
    assert.equal(rc, 0);
    assert.match(err, /WARNING: could not log out: Logout failed: HTTP 500\.\n/);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), BARE_SETTINGS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, content, message] of [
  ["a list", "[1, 2]", /does not hold a JSON object\.\n/],
  ["a scalar", "42", /does not hold a JSON object\.\n/],
  ["null", "null", /does not hold a JSON object\.\n/],
  ["broken JSON", "{not json", /is not valid JSON: [^\n]*[^.]\.\n/],
]) {
  test(`apply refuses a settings file holding ${label}, before logging in`, async () => {
    const { file, dir } = settingsFile(content);
    try {
      const { rc, err, calls } = await run(["apply", file, "--yes", ...CREDS], [LOGIN_OK]);
      assert.equal(rc, 1);
      assert.match(err, /^ERROR: /);
      assert.match(err, message);
      assert.deepEqual(calls, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("apply refuses a directory as the settings file, before logging in", async () => {
  const dir = tempDir();
  try {
    const { rc, err, calls } = await run(["apply", dir, "--yes", ...CREDS], [LOGIN_OK]);
    assert.equal(rc, 1);
    assert.match(err, /is a directory/);
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download refuses a directory as --out, before logging in", async () => {
  const dir = tempDir();
  try {
    const { rc, err, calls } = await run(["download", "--out", dir, "--force", ...CREDS], [LOGIN_OK]);
    assert.equal(rc, 1);
    assert.match(err, /is a directory\. Give --out a file path\./);
    assert.deepEqual(calls, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const [label, json, text] of [
  ["a list", [BARE_SETTINGS], undefined],
  ["a non-JSON body", undefined, "<html>"],
]) {
  test(`download of ${label} fails, writes nothing and logs out`, async () => {
    const dir = tempDir();
    const target = path.join(dir, "out.json");
    try {
      const { rc, err, calls } = await run(["download", "--out", target, ...CREDS], [
        LOGIN_OK,
        [SETTINGS_URL, "GET", { status: 200, json, text }],
      ]);
      assert.equal(rc, 1);
      assert.match(err, /the server did not return a JSON object/);
      assert.deepEqual(fs.readdirSync(dir), []);
      assert.deepEqual(deletes(calls), [LOGOUT_URL]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("saveSettingsFile without overwrite keeps a file that appeared meanwhile", () => {
  const dir = tempDir();
  const target = path.join(dir, "out.json");
  fs.writeFileSync(target, "someone else's file");
  try {
    assert.throws(() => saveSettingsFile(target, BARE_SETTINGS), /already exists; use --force/);
    assert.equal(fs.readFileSync(target, "utf-8"), "someone else's file");
    // The side file is gone too.
    assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveSettingsFile with overwrite replaces the file, owner-only, no side file left", () => {
  const dir = tempDir();
  const target = path.join(dir, "out.json");
  fs.writeFileSync(target, "old");
  try {
    saveSettingsFile(target, BARE_SETTINGS, { overwrite: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), BARE_SETTINGS);
    assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
    if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveSettingsFile removes the side file when the move fails", () => {
  const dir = tempDir();
  // A directory in the way: the side file is written, renaming it onto the
  // directory fails, and the side file must not stay behind.
  const target = path.join(dir, "taken");
  fs.mkdirSync(target);
  try {
    assert.throws(() => saveSettingsFile(target, BARE_SETTINGS, { overwrite: true }));
    assert.deepEqual(fs.readdirSync(dir), ["taken"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** fetch stand-in whose settings GET creates `target` first, as a racing run would. */
function racingFetch(target) {
  const { fetchImpl, calls } = fakeFetch([
    LOGIN_OK,
    [SETTINGS_URL, "GET", { status: 200, json: BARE_SETTINGS }],
  ]);
  const racing = async (url, init = {}) => {
    if (String(url).includes(SETTINGS_URL)) fs.writeFileSync(target(), "someone else's file");
    return fetchImpl(url, init);
  };
  return { fetchImpl: racing, calls };
}

test("download without --force keeps a file that appeared during the download", async () => {
  const dir = tempDir();
  const target = path.join(dir, "out.json");
  const { fetchImpl, calls } = racingFetch(() => target);
  const stderr = memoryStream();
  try {
    const rc = await main(["download", "--out", target, ...CREDS], { fetchImpl, stderr, stdout: memoryStream() });
    assert.equal(rc, 1);
    assert.ok(stderr.text().includes(`ERROR: ${target} already exists; use --force`), stderr.text());
    assert.equal(fs.readFileSync(target, "utf-8"), "someone else's file");
    assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
    assert.deepEqual(deletes(calls), [LOGOUT_URL]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download to the auto-generated name does not clobber one that appeared meanwhile", async () => {
  const dir = tempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  // The auto name is only known once the download starts; whatever name it
  // picks, a racing run creates it first.
  // Same second as the name main() computed, almost always.
  const { fetchImpl } = racingFetch(() => path.join(dir, defaultOutputName("device-1")));
  const stderr = memoryStream();
  try {
    const rc = await main(["download", ...CREDS], { fetchImpl, stderr, stdout: memoryStream() });
    const files = fs.readdirSync(dir);
    if (rc === 1) {
      assert.match(stderr.text(), /already exists; use --force/);
      assert.equal(files.length, 1);
      assert.equal(fs.readFileSync(path.join(dir, files[0]), "utf-8"), "someone else's file");
    } else {
      // The clock ticked over between the two names: both files exist, intact.
      assert.equal(files.length, 2);
    }
    assert.ok(!files.some((f) => f.endsWith(".partial")));
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Login wording
// ---------------------------------------------------------------------------

for (const [label, reply, message] of [
  ["HTTP 500", { status: 500 }, /^Login failed: HTTP 500\.$/],
  ["a non-JSON body", { status: 200, text: "<html>" }, /^Login failed: the response was not valid JSON\.$/],
  ["JSON without a token", { status: 200, json: {} }, /^Login failed: the response did not contain a token\.$/],
  ["a JSON list", { status: 200, json: [{ token: "x" }] }, /^Login failed: the response did not contain a token\.$/],
  ["a non-string token", { status: 200, json: { token: 42 } }, /^Login failed: the response did not contain a token\.$/],
]) {
  test(`login answered with ${label} says so`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", reply]]);
    await assert.rejects(() => client.login("admin", "secret"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, message);
      return true;
    });
  });
}

test("a login failure is never reported as an unreachable server", async () => {
  const { rc, err } = await run(["download", "--out", "/nonexistent/x.json", ...CREDS], [
    ["/login/sessions", "POST", { status: 200, text: "<html>" }],
  ]);
  assert.equal(rc, 1);
  assert.match(err, /ERROR: Login failed: the response was not valid JSON\.\n/);
  assert.doesNotMatch(err, /could not reach/);
});

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

test("a boolean flag given a value is an error, so --yes=no is not yes", async () => {
  for (const flag of ["--yes=no", "--yes=false", "--force=no", "--insecure=false"]) {
    assert.throws(() => parseArgs(["apply", "x.json", flag]), /takes no value/);
  }
  assert.equal(parseArgs(["apply", "x.json", "--yes"]).yes, true);
  const { rc, err, calls } = await run(["apply", "x.json", "--yes=no", ...CREDS], [LOGIN_OK]);
  assert.equal(rc, 2);
  assert.equal(err, "ERROR: --yes takes no value\n");
  assert.deepEqual(calls, []);
});

test("a value flag without a value is an error, not undefined", async () => {
  assert.throws(() => parseArgs(["download", "--out"]), /: Missing value for --out$/);
  assert.throws(() => parseArgs(["download", "--out", "--force"]), /: Missing value for --out$/);
  assert.throws(() => parseArgs(["download", "--host="]), /: Missing value for --host$/);
  assert.equal(parseArgs(["download", "--password=--odd"]).password, "--odd");
  const { rc, err, calls } = await run(["download", ...CREDS, "--out"], [LOGIN_OK]);
  assert.equal(rc, 2);
  assert.equal(err, "ERROR: Missing value for --out\n");
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Ctrl-C
// ---------------------------------------------------------------------------

test("Ctrl-C mid-apply logs out, says Interrupted. and exits 130", { skip: process.platform === "win32" }, async () => {
  let putSeen;
  const putArrived = new Promise((resolve) => (putSeen = resolve));
  const srv = await loopback((req) => {
    req.resume();
    putSeen(); // ...and never answer
  });
  const { file, dir } = settingsFile();
  try {
    const script = fileURLToPath(new URL("./rest_copy_device_agent_settings.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, "apply", file, "--yes", ...loopbackCreds(srv.host)], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    await putArrived;
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.equal(code, 130);
    assert.match(stderr, /Interrupted\. Outcome unknown/);
    assert.ok(srv.seen.includes("DELETE /rest/v4/login/sessions/tok-1"), srv.seen.join(", "));
  } finally {
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 2: apply wording per status class, TLS on every request, link
// fallback, Ctrl-C after the run finished
// ---------------------------------------------------------------------------

for (const [status, expected] of [
  [302, "ERROR: Applying settings failed: HTTP 302 (redirect not followed). The settings were not applied.\n"],
  [404, "ERROR: Applying settings failed: HTTP 404. The settings were not applied. The target device may not be running this Engine.\n"],
  [500, "ERROR: Applying settings failed: HTTP 500. The server may have applied some of them; download the device's settings to check.\n"],
]) {
  test(`apply answered with ${status} prints the wording for its status class`, async () => {
    const { file, dir } = settingsFile();
    try {
      const { rc, err } = await run(["apply", file, "--yes", ...CREDS], [
        LOGIN_OK,
        [SETTINGS_URL, "PUT", { status }],
      ]);
      assert.equal(rc, 1);
      assert.equal(err, expected);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

const CERT_ERROR =
  "ERROR: certificate verification failed. Local servers use a self-signed certificate, add --insecure.";

for (const [label, method, url] of [
  ["login", "POST", "/login/sessions"],
  ["download", "GET", SETTINGS_URL],
]) {
  test(`a TLS failure on the ${label} request prints the certificate message`, async () => {
    const dir = tempDir();
    try {
      const { rc, err } = await run(["download", "--out", path.join(dir, "out.json"), ...CREDS], [
        ...(method === "POST" ? [] : [LOGIN_OK]),
        [url, method, { throws: fetchFailed("SELF_SIGNED_CERT_IN_CHAIN") }],
      ]);
      assert.equal(rc, 1);
      assert.equal(err, `${CERT_ERROR}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("a TLS failure on the apply request prints the certificate message, not applied", async () => {
  const { file, dir } = settingsFile();
  try {
    const { rc, err } = await run(["apply", file, "--yes", ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { throws: fetchFailed("ERR_SSL_WRONG_VERSION_NUMBER") }],
    ]);
    assert.equal(rc, 1);
    assert.equal(err, `${CERT_ERROR} The settings were not applied.\n`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a TLS failure on logout gives the certificate message in the warning", async () => {
  const { file, dir } = settingsFile();
  try {
    const { rc, err } = await run(["apply", file, "--yes", ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { status: 200 }],
      ["/login/sessions/tok-1", "DELETE", { throws: fetchFailed("CERT_HAS_EXPIRED") }],
    ]);
    assert.equal(rc, 0);
    assert.equal(
      err,
      "WARNING: could not log out: certificate verification failed. Local servers use a " +
        "self-signed certificate, add --insecure.\n",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const noLink = (code) => () => {
  throw Object.assign(new Error(`link failed: ${code}`), { code });
};

for (const code of ["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV", "ENOSYS", "EMLINK"]) {
  test(`saveSettingsFile without hard links (${code}) renames the side file into place`, () => {
    const dir = tempDir();
    const target = path.join(dir, "out.json");
    try {
      saveSettingsFile(target, BARE_SETTINGS, { link: noLink(code) });
      assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), BARE_SETTINGS);
      assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("saveSettingsFile without hard links still keeps an existing file", () => {
  const dir = tempDir();
  const target = path.join(dir, "out.json");
  fs.writeFileSync(target, "someone else's file");
  try {
    assert.throws(
      () => saveSettingsFile(target, BARE_SETTINGS, { link: noLink("ENOTSUP") }),
      (err) => err instanceof ApiError && err.message === `${target} already exists; use --force`,
    );
    assert.equal(fs.readFileSync(target, "utf-8"), "someone else's file");
    assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Ctrl-C after the run finished keeps the run's result, not 130", { skip: process.platform === "win32" }, async () => {
  // The PUT is held until the SIGINT handler's logout arrives; then the PUT
  // succeeds, and the logout is held a while longer, so main() finishes and
  // prints its result while the handler is still waiting on the logout.
  let putSeen;
  const putArrived = new Promise((resolve) => (putSeen = resolve));
  let pendingPut = null;
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.url.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.method === "PUT") {
      pendingPut = res;
      return putSeen();
    }
    if (req.method === "DELETE") {
      pendingPut?.writeHead(204);
      pendingPut?.end();
      setTimeout(() => {
        res.writeHead(204);
        res.end();
      }, 500);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const host = `http://127.0.0.1:${server.address().port}`;
  const { file, dir } = settingsFile();
  try {
    const script = fileURLToPath(new URL("./rest_copy_device_agent_settings.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, "apply", file, "--yes", ...loopbackCreds(host)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    await putArrived;
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Applied Device Agent settings/);
    assert.doesNotMatch(stderr, /Interrupted\./);
    assert.ok(seen.includes("DELETE /rest/v4/login/sessions/tok-1"), seen.join(", "));
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 3: Ctrl-C during the final logout, mid-stream TLS errors, dangling
// symlinks
// ---------------------------------------------------------------------------

test("Ctrl-C during the final logout keeps the result, warns, exits 0", { skip: process.platform === "win32" }, async () => {
  // The PUT succeeds; the DELETE is held, and the SIGINT is sent while it is.
  let deleteSeen;
  const deleteArrived = new Promise((resolve) => (deleteSeen = resolve));
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    if (req.url.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.method === "PUT") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "DELETE") return deleteSeen(); // ...and never answer
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const host = `http://127.0.0.1:${server.address().port}`;
  const { file, dir } = settingsFile();
  try {
    const script = fileURLToPath(new URL("./rest_copy_device_agent_settings.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, "apply", file, "--yes", ...loopbackCreds(host)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    await deleteArrived;
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Applied Device Agent settings/);
    assert.equal(stderr, "WARNING: could not log out: interrupted.\n");
    assert.ok(seen.includes("DELETE /rest/v4/login/sessions/tok-1"), seen.join(", "));
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a mid-stream SSL error on apply is Outcome unknown, not 'not applied'", async () => {
  const code = "ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC";
  assert.equal(wasNotSent(fetchFailed(code)), false);
  const { file, dir } = settingsFile();
  try {
    const { rc, err, calls } = await run(["apply", file, "--yes", ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { throws: fetchFailed(code) }],
    ]);
    assert.equal(rc, 1);
    assert.match(err, /^ERROR: Outcome unknown: /);
    assert.doesNotMatch(err, /not applied|certificate/);
    assert.deepEqual(deletes(calls), [LOGOUT_URL]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download refuses a dangling symlink at --out without --force", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const target = path.join(dir, "link.json");
  fs.symlinkSync(path.join(dir, "missing.json"), target);
  try {
    const { rc, err, calls } = await run(["download", "--out", target, ...CREDS], [LOGIN_OK]);
    assert.equal(rc, 1);
    assert.equal(err, `ERROR: ${target} already exists; use --force\n`);
    assert.deepEqual(calls, []);
    assert.ok(fs.lstatSync(target).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(dir, "missing.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveSettingsFile without hard links refuses a dangling symlink too", { skip: process.platform === "win32" }, () => {
  const dir = tempDir();
  const target = path.join(dir, "link.json");
  fs.symlinkSync(path.join(dir, "missing.json"), target);
  try {
    assert.throws(
      () => saveSettingsFile(target, BARE_SETTINGS, { link: noLink("ENOTSUP") }),
      (err) => err instanceof ApiError && err.message === `${target} already exists; use --force`,
    );
    assert.ok(fs.lstatSync(target).isSymbolicLink());
    assert.deepEqual(fs.readdirSync(dir), ["link.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 5: one rule for a failing final logout, one final period per reason
// ---------------------------------------------------------------------------

const ENGINE_ERRORS = { ...BARE_SETTINGS, _error: { sensitivity: "out of range" } };

test("Engine errors, then a failed logout: the errors, a warning, exit 1", async () => {
  const { file, dir } = settingsFile();
  try {
    const { rc, err } = await run(["apply", file, "--yes", ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { status: 200, json: ENGINE_ERRORS }],
      ["/login/sessions/tok-1", "DELETE", { status: 500 }],
    ]);
    assert.equal(rc, 1);
    assert.equal(
      err,
      "ERROR: The server took the settings but the Engine reported errors:\n" +
        "  sensitivity: out of range\n" +
        "WARNING: could not log out: Logout failed: HTTP 500.\n",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed GET, then a failed logout: only the GET error", async () => {
  const dir = tempDir();
  try {
    const { rc, err, calls } = await run(["download", "--out", path.join(dir, "out.json"), ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { status: 500 }],
      ["/login/sessions/tok-1", "DELETE", { status: 500 }],
    ]);
    assert.equal(rc, 1);
    assert.equal(err, "ERROR: Reading settings failed: HTTP 500.\n");
    assert.deepEqual(deletes(calls), [LOGOUT_URL]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreachable server, then a failed logout: only the reach error", async () => {
  const dir = tempDir();
  try {
    const { rc, err } = await run(["download", "--out", path.join(dir, "out.json"), ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { throws: fetchFailed("ECONNREFUSED") }],
      ["/login/sessions/tok-1", "DELETE", { throws: fetchFailed("ECONNREFUSED") }],
    ]);
    assert.equal(rc, 1);
    assert.equal(err, "ERROR: could not reach the server: ECONNREFUSED.\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a logout with no answer in time warns 'no answer within <n> s.' with one period", async () => {
  const dir = tempDir();
  try {
    const { rc, err } = await run(["download", "--out", path.join(dir, "out.json"), ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { status: 200, json: BARE_SETTINGS }],
      ["/login/sessions/tok-1", "DELETE", { throws: new Error("no answer within 30 s") }],
    ]);
    assert.equal(rc, 0);
    assert.equal(err, "WARNING: could not log out: no answer within 30 s.\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a reason that already ends in a period does not get a second one", async () => {
  const dir = tempDir();
  try {
    const { err } = await run(["download", "--out", path.join(dir, "out.json"), ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { throws: new TypeError("fetch failed", { cause: new Error("socket hang up.") }) }],
    ]);
    assert.equal(err, "ERROR: could not reach the server: socket hang up.\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the client's own logout timeout reads 'no answer within <n> s'", async () => {
  const fetchImpl = (_url, init) =>
    init.method === "DELETE"
      ? new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))
      : Promise.resolve({ status: 200, text: async () => JSON.stringify({ token: "tok-1" }) });
  const client = new NxServerClient("https://server:7001", { fetchImpl, timeout: 50 });
  await client.login("admin", "secret");
  await assert.rejects(() => client.logout(), (err) => err.message === "no answer within 0.05 s");
});

test("Ctrl-C during the logout after Engine errors: errors, warning, exit 1", { skip: process.platform === "win32" }, async () => {
  let deleteSeen;
  const deleteArrived = new Promise((resolve) => (deleteSeen = resolve));
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.method === "PUT") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ENGINE_ERRORS));
    }
    if (req.method === "DELETE") return deleteSeen(); // ...and never answer
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const host = `http://127.0.0.1:${server.address().port}`;
  const { file, dir } = settingsFile();
  try {
    const script = fileURLToPath(new URL("./rest_copy_device_agent_settings.mjs", import.meta.url));
    const child = spawn(process.execPath, [script, "apply", file, "--yes", ...loopbackCreds(host)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    await deleteArrived;
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.equal(code, 1, stderr);
    assert.equal(
      stderr,
      "ERROR: The server took the settings but the Engine reported errors:\n" +
        "  sensitivity: out of range\n" +
        "WARNING: could not log out: interrupted.\n",
    );
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a download to a missing folder names the --out path, not the side file", async () => {
  const dir = tempDir();
  const out = path.join(dir, "missing", "x.json");
  try {
    const { rc, err, calls } = await run(["download", "--out", out, ...CREDS], [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { status: 200, json: BARE_SETTINGS }],
    ]);
    assert.equal(rc, 1);
    assert.equal(err, `ERROR: could not use ${out}: No such file or directory.\n`);
    assert.doesNotMatch(err, /partial|ENOENT/);
    assert.deepEqual(deletes(calls), [LOGOUT_URL]);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const connectTimeout = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(
      new Error("Connect Timeout Error (attempted address: server:7001, timeout: 10000ms)"),
      { code: "UND_ERR_CONNECT_TIMEOUT" },
    ),
  });

test("fetch's connect timeout reads 'no connection within 10 s'", async () => {
  const { rc, err } = await run(["download", "--out", "/nonexistent/out.json", ...CREDS], [
    ["/login/sessions", "POST", { throws: connectTimeout() }],
  ]);
  assert.equal(rc, 1);
  assert.equal(err, "ERROR: could not reach the server: no connection within 10 s.\n");
});

test("fetch's connect timeout on apply adds 'The settings were not applied.'", async () => {
  const { file, dir } = settingsFile();
  try {
    const { rc, err } = await run(["apply", file, "--yes", ...CREDS], [
      ["/login/sessions", "POST", { throws: connectTimeout() }],
    ]);
    assert.equal(rc, 1);
    assert.equal(
      err,
      "ERROR: could not reach the server: no connection within 10 s. The settings were not applied.\n",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
