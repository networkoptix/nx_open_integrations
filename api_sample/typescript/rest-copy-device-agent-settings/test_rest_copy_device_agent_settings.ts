// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for rest_copy_device_agent_settings.ts. No network, no
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
 * Run from this folder:  node --test test_rest_copy_device_agent_settings.ts
 */

import assert from "node:assert/strict";
import test, { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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
  loadSettingsFile,
  saveSettingsFile,
  main,
  AuthError,
  ApiError,
  type DeviceAgentSettings,
} from "./rest_copy_device_agent_settings.ts";

// ---------------------------------------------------------------------------
// Fake HTTP plumbing
// ---------------------------------------------------------------------------

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: RequestInit["redirect"];
}

export interface FakeReply {
  status?: number;
  /** A JSON body. */
  json?: unknown;
  /** A raw body, used instead of `json`. */
  text?: string;
  /** Reject the request with this error instead of answering. */
  throws?: unknown;
  /** Runs when the request arrives, before the answer. */
  onCall?: () => void;
}

/**
 * Build a fake fetch plus the list it records into. Replies are matched by a
 * substring of the URL and the method, so a test says what it means rather
 * than counting calls.
 */
export function fakeFetch(replies: Array<[string, string, FakeReply]>): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      headers: { ...((init.headers ?? {}) as Record<string, string>) },
      body: init.body,
      redirect: init.redirect,
    });
    const match = replies.find(([suffix, m]) => url.includes(suffix) && m === method);
    const reply: FakeReply = match ? match[2] : { status: 200, json: {} };
    reply.onCall?.();
    if (reply.throws !== undefined) throw reply.throws;
    const status = reply.status ?? 200;
    const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch failure the way undici reports one: a TypeError with a coded cause. */
export function fetchFailure(code: string, message = code): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

const LOGIN_OK: [string, string, FakeReply] = [
  "/login/sessions",
  "POST",
  { status: 200, json: { token: "tok-1" } },
];

export function makeClient(
  replies: Array<[string, string, FakeReply]>,
): { client: NxServerClient; calls: RecordedCall[] } {
  const { fetchImpl, calls } = fakeFetch(replies);
  const client = new NxServerClient("https://server:7001", { fetchImpl });
  return { client, calls };
}

/** A fresh temp directory, removed by the caller. */
export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nx-copy-device-agent-settings-test-"));
}

const SETTINGS_URL = "/analytics/engines/engine-1/deviceAgents/device-1/settings";

const BARE_SETTINGS: DeviceAgentSettings = {
  deviceId: "device-1",
  engineId: "engine-1",
  values: { sensitivity: 50 },
  model: { sensitivity: { type: "SpinBox" } },
  _error: { sensitivity: "stale error from the source device" },
  analyzedStream: "primary",
  disableStreamSelection: false,
};

/** A clean PUT answer: the settings back, with an empty error map. */
const APPLIED_REPLY = { ...BARE_SETTINGS, _error: {} };

/** What apply sends for BARE_SETTINGS: no deviceId, engineId or _error. */
const BARE_BODY = {
  values: { sensitivity: 50 },
  model: { sensitivity: { type: "SpinBox" } },
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
  assert.deepEqual(JSON.parse(String(calls[0]!.body)), { username: "admin", password: "secret" });
  assert.equal(calls[0]!.method, "POST");
  assert.ok(calls[0]!.url.endsWith("/rest/v4/login/sessions"));
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
  const last = calls[calls.length - 1]!;
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

test("buildApplyBody drops deviceId, engineId and _error, and nothing else", () => {
  // deviceId/engineId: the URL already identifies the device and engine.
  // _error: the source Engine's error report must not be echoed back.
  const body = buildApplyBody(BARE_SETTINGS);

  assert.deepEqual(body, BARE_BODY);
  assert.ok(!("deviceId" in body));
  assert.ok(!("engineId" in body));
  assert.ok(!("_error" in body));
});

test("buildApplyBody refuses an array, which JSON.parse can hand it", () => {
  assert.throws(() => buildApplyBody([1, 2] as unknown as DeviceAgentSettings), ApiError);
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
    [SETTINGS_URL, "PUT", { status: 200, json: APPLIED_REPLY }],
  ]);
  await client.login("admin", "secret");
  const body = { values: { sensitivity: 50 } };

  await client.applySettings("engine-1", "device-1", body);

  const last = calls[calls.length - 1]!;
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

  const last = calls[calls.length - 1]!;
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
  assert.equal(
    resolveConfig({ host: "https://server:7001/" }, {}, {}).host,
    "https://server:7001",
  );
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
export function memoryStream(): NodeJS.WritableStream & { text: () => string } {
  const chunks: Buffer[] = [];
  const stream = {
    write(chunk: string | Uint8Array): boolean {
      chunks.push(Buffer.from(chunk as Uint8Array | string));
      return true;
    },
    end(): void {},
    on(): void {},
    once(): void {},
    emit(): boolean {
      return false;
    },
    text: () => Buffer.concat(chunks).toString("utf-8"),
  };
  return stream as unknown as NodeJS.WritableStream & { text: () => string };
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

test("download refuses a dangling symlink as --out, before logging in", async () => {
  const dir = tempDir();
  const target = path.join(dir, "link.json");
  fs.symlinkSync(path.join(dir, "nowhere.json"), target);
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["download", "--out", target, ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /link\.json already exists; use --force/);
    assert.deepEqual(calls, []);
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

test("apply without --yes refuses before reading the file", async () => {
  const dir = tempDir();
  const missing = path.join(dir, "missing.json");
  const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", missing, ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /Refusing to apply without --yes/);
    assert.doesNotMatch(stderr.text(), /No such settings file/);
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
    [SETTINGS_URL, "PUT", { status: 200, json: APPLIED_REPLY }],
  ]);
  const stdout = memoryStream();
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", settingsFile, "--yes", ...CREDS], {
      fetchImpl,
      stdout,
      stderr,
    });
    assert.equal(rc, 0);
    const putCalls = calls.filter((c) => c.method === "PUT");
    assert.deepEqual(JSON.parse(String(putCalls[0]!.body)), BARE_BODY);
    assert.match(stdout.text(), /device-1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("apply reports failure when the PUT is rejected", async () => {
  const dir = tempDir();
  const settingsFile = path.join(dir, "settings.json");
  fs.writeFileSync(settingsFile, JSON.stringify(BARE_SETTINGS));
  const { fetchImpl } = fakeFetch([LOGIN_OK, [SETTINGS_URL, "PUT", { status: 403 }]]);
  const stdout = memoryStream();
  const stderr = memoryStream();
  try {
    const rc = await main(["apply", settingsFile, "--yes", ...CREDS], {
      fetchImpl,
      stdout,
      stderr,
    });
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
// Helpers for the behaviour tests below
// ---------------------------------------------------------------------------

/** Write `content` (an object is JSON-encoded) to a settings file in `dir`. */
function writeSettings(dir: string, content: unknown): string {
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

/** Run main() with captured streams, in a fresh temp dir removed afterwards. */
async function run(
  argv: (dir: string) => string[],
  replies: Array<[string, string, FakeReply]>,
  setup: (dir: string) => void = () => {},
): Promise<{ rc: number; out: string; err: string; calls: RecordedCall[]; files: string[] }> {
  const dir = tempDir();
  try {
    setup(dir);
    const { fetchImpl, calls } = fakeFetch(replies);
    const stdout = memoryStream();
    const stderr = memoryStream();
    const rc = await main(argv(dir), { fetchImpl, stdout, stderr });
    return { rc, out: stdout.text(), err: stderr.text(), calls, files: fs.readdirSync(dir).sort() };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const loggedOut = (calls: RecordedCall[]) =>
  calls.some((c) => c.method === "DELETE" && c.url.endsWith("/login/sessions/tok-1"));

// ---------------------------------------------------------------------------
// Redirects and non-2xx answers
// ---------------------------------------------------------------------------

test("every request is sent with redirect: manual", async () => {
  const { calls } = await run(
    (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "GET", { json: BARE_SETTINGS }]],
  );
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.redirect, "manual", call.url);
});

test("a redirected login is a failure, not followed", async () => {
  const { rc, err, calls } = await run(
    () => ["download", ...CREDS],
    [["/login/sessions", "POST", { status: 302 }]],
  );
  assert.equal(rc, 1);
  assert.match(err, /ERROR: Login failed: HTTP 302 \(redirect not followed\)/);
  assert.equal(calls.length, 1);
});

test("a redirected download is a failure, writes nothing, and logs out", async () => {
  const { rc, err, calls, files } = await run(
    (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "GET", { status: 307 }]],
  );
  assert.equal(rc, 1);
  assert.match(err, /HTTP 307 \(redirect not followed\)/);
  assert.deepEqual(files, []);
  assert.ok(loggedOut(calls));
});

test("a redirected apply is a failure and logs out", async () => {
  const { rc, err, out, calls } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { status: 302 }]],
  );
  assert.equal(rc, 1);
  assert.match(err, /HTTP 302 \(redirect not followed\)/);
  assert.doesNotMatch(out, /Applied/);
  assert.ok(loggedOut(calls));
});

for (const [status, message] of [
  [302, "Applying settings failed: HTTP 302 (redirect not followed). The settings were not applied."],
  [
    404,
    "Applying settings failed: HTTP 404. The settings were not applied. " +
      "The target device may not be running this Engine.",
  ],
  [
    500,
    "Applying settings failed: HTTP 500. The server may have applied some of them; " +
      "download the device's settings to check.",
  ],
  [
    504,
    "Applying settings failed: HTTP 504. The server may have applied some of them; " +
      "download the device's settings to check.",
  ],
] as const) {
  test(`a ${status} on apply has its own exact wording`, async () => {
    const { rc, err } = await run(
      (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
      [LOGIN_OK, [SETTINGS_URL, "PUT", { status }]],
    );
    assert.equal(rc, 1);
    assert.equal(err, `ERROR: ${message}\n`);
  });
}

// ---------------------------------------------------------------------------
// The outcome of a 2xx apply
// ---------------------------------------------------------------------------

test("an empty 2xx body on apply is success", async () => {
  const { rc, out } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { status: 204, text: "" }]],
  );
  assert.equal(rc, 0);
  assert.match(out, /Applied Device Agent settings/);
});

test("a non-JSON 2xx body on apply is success", async () => {
  const { rc, out } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { status: 200, text: "OK" }]],
  );
  assert.equal(rc, 0);
  assert.match(out, /Applied/);
});

test("a 2xx with a non-empty _error map reports each error and exits 1", async () => {
  const { rc, out, err, calls } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", {
        json: { ...BARE_SETTINGS, _error: { sensitivity: "out of range", zone: "unknown zone" } },
      }],
    ],
  );
  assert.equal(rc, 1);
  assert.match(err, /The server took the settings but the Engine reported errors:/);
  assert.match(err, /sensitivity: out of range/);
  assert.match(err, /zone: unknown zone/);
  assert.doesNotMatch(out, /Applied/);
  assert.ok(loggedOut(calls));
});

test("a non-string _error value is printed as JSON, not [object Object]", async () => {
  const { rc, err } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { json: { _error: { zone: { code: 7 }, n: 3, s: "plain" } } }]],
  );
  assert.equal(rc, 1);
  assert.match(err, /  zone: \{"code":7\}\n/);
  assert.match(err, /  n: 3\n/);
  assert.match(err, /  s: plain\n/);
  assert.doesNotMatch(err, /object Object/);
});

test("an _error map inside the reply envelope is reported too", async () => {
  const { rc, err } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { json: { reply: { _error: { a: "bad" } } } }]],
  );
  assert.equal(rc, 1);
  assert.match(err, /a: bad/);
});

// ---------------------------------------------------------------------------
// The settings file, checked before logging in
// ---------------------------------------------------------------------------

for (const [label, content, pattern] of [
  ["a list", "[1, 2, 3]", /does not hold a JSON object/],
  ["a number", "42", /does not hold a JSON object/],
  ["null", "null", /does not hold a JSON object/],
  ["not JSON", "{not json", /is not valid JSON: /],
] as const) {
  test(`apply refuses a settings file holding ${label}, before logging in`, async () => {
    const { rc, err, calls } = await run(
      (dir) => ["apply", writeSettings(dir, content), "--yes", ...CREDS],
      [LOGIN_OK],
    );
    assert.equal(rc, 1);
    assert.match(err, /^ERROR: /);
    assert.match(err, pattern);
    assert.deepEqual(calls, []);
  });
}

test("apply refuses a directory as the settings file, before logging in", async () => {
  const { rc, err, calls } = await run((dir) => ["apply", dir, "--yes", ...CREDS], [LOGIN_OK]);
  assert.equal(rc, 1);
  assert.match(err, /is a directory/);
  assert.deepEqual(calls, []);
});

test("a settings file that is not JSON gets the reason and one final period", async () => {
  const { err } = await run(
    (dir) => ["apply", writeSettings(dir, "{not json"), "--yes", ...CREDS],
    [LOGIN_OK],
  );
  assert.match(err, /^ERROR: .* is not valid JSON: [^\n]*[^.]\.\n$/);
});

test("loadSettingsFile returns the object it read", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(loadSettingsFile(writeSettings(dir, BARE_SETTINGS)), BARE_SETTINGS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Transport failures on apply
// ---------------------------------------------------------------------------

for (const code of ["ECONNRESET", "UND_ERR_SOCKET"]) {
  test(`a connection lost after the PUT (${code}) says the outcome is unknown`, async () => {
    const { rc, err, calls } = await run(
      (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
      [LOGIN_OK, [SETTINGS_URL, "PUT", { throws: fetchFailure(code) }]],
    );
    assert.equal(rc, 1);
    assert.match(
      err,
      /Outcome unknown: the connection was lost after the settings were sent\. Download the device's settings to check\./,
    );
    assert.doesNotMatch(err, /not applied/);
    assert.ok(loggedOut(calls));
  });
}

test("a PUT with no answer in time says the outcome is unknown", async () => {
  const dir = tempDir();
  try {
    // A fetch that never answers until it is aborted.
    const hanging = ((_url: string, init: RequestInit = {}) =>
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const { fetchImpl } = fakeFetch([LOGIN_OK]);
    const client = new NxServerClient("https://server:7001", { fetchImpl, timeout: 50 });
    await client.login("admin", "secret");
    client.fetchImpl = hanging;
    await assert.rejects(
      () => client.applySettings("engine-1", "device-1", {}),
      /Outcome unknown/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a PUT that could not connect says the settings were not applied", async () => {
  const { rc, err } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { throws: fetchFailure("ECONNREFUSED", "connect ECONNREFUSED") }]],
  );
  assert.equal(rc, 1);
  assert.match(err, /could not reach the server: connect ECONNREFUSED\. The settings were not applied\./);
});

for (const code of ["EADDRNOTAVAIL", "EHOSTDOWN", "UND_ERR_CONNECT_TIMEOUT"]) {
  test(`a PUT that never connected (${code}) says the settings were not applied`, async () => {
    const { rc, err } = await run(
      (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
      [LOGIN_OK, [SETTINGS_URL, "PUT", { throws: fetchFailure(code) }]],
    );
    assert.equal(rc, 1);
    assert.match(err, /could not reach the server: .*The settings were not applied\./);
  });
}

const CONNECT_TIMEOUT_MESSAGE =
  "Connect Timeout Error (attempted address: server:7001, timeout: 10000ms)";

test("fetch's connect timeout on login reads 'no connection within 10 s'", async () => {
  const { rc, err } = await run(
    (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
    [["/login/sessions", "POST", { throws: fetchFailure("UND_ERR_CONNECT_TIMEOUT", CONNECT_TIMEOUT_MESSAGE) }]],
  );
  assert.equal(rc, 1);
  assert.equal(err, "ERROR: could not reach the server: no connection within 10 s.\n");
});

test("fetch's connect timeout on the PUT reads 'no connection within 10 s', not applied", async () => {
  const { rc, err } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { throws: fetchFailure("UND_ERR_CONNECT_TIMEOUT", CONNECT_TIMEOUT_MESSAGE) }]],
  );
  assert.equal(rc, 1);
  assert.equal(
    err,
    "ERROR: could not reach the server: no connection within 10 s. The settings were not applied.\n",
  );
});

// ---------------------------------------------------------------------------
// TLS failures: the certificate message, on every request
// ---------------------------------------------------------------------------

const CERT_ERROR =
  "ERROR: certificate verification failed. Local servers use a self-signed certificate, add --insecure.";

for (const code of [
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "SOME_NEW_CERT_FAILURE",
]) {
  test(`a TLS failure (${code}) on apply prints the certificate message`, async () => {
    const { rc, err } = await run(
      (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
      [LOGIN_OK, [SETTINGS_URL, "PUT", { throws: fetchFailure(code) }]],
    );
    assert.equal(rc, 1);
    assert.equal(err, `${CERT_ERROR} The settings were not applied.\n`);
  });
}

test("a TLS failure on login prints the certificate message", async () => {
  const { rc, err } = await run(
    () => ["download", ...CREDS],
    [["/login/sessions", "POST", { throws: fetchFailure("SELF_SIGNED_CERT_IN_CHAIN") }]],
  );
  assert.equal(rc, 1);
  assert.equal(err, `${CERT_ERROR}\n`);
});

test("a TLS failure on download prints the certificate message", async () => {
  const { rc, err, files } = await run(
    (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "GET", { throws: fetchFailure("CERT_UNTRUSTED") }]],
  );
  assert.equal(rc, 1);
  assert.equal(err, `${CERT_ERROR}\n`);
  assert.deepEqual(files, []);
});

test("a TLS failure on logout names the certificate in the warning", async () => {
  const { rc, err } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { json: APPLIED_REPLY }],
      ["/login/sessions/tok-1", "DELETE", { throws: fetchFailure("CERT_HAS_EXPIRED") }],
    ],
  );
  assert.equal(rc, 0);
  assert.equal(
    err,
    "WARNING: could not log out: certificate verification failed. Local servers use a " +
      "self-signed certificate, add --insecure.\n",
  );
});

test("a login that cannot connect is 'could not reach the server', without a stack trace", async () => {
  const { rc, err } = await run(
    () => ["download", ...CREDS],
    [["/login/sessions", "POST", { throws: fetchFailure("ENOTFOUND", "getaddrinfo ENOTFOUND server") }]],
  );
  assert.equal(rc, 1);
  assert.equal(err, "ERROR: could not reach the server: getaddrinfo ENOTFOUND server.\n");
});

test("a refused login on apply says the settings were not applied", async () => {
  const { rc, err, calls } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [["/login/sessions", "POST", { throws: fetchFailure("ECONNREFUSED", "connect ECONNREFUSED") }]],
  );
  assert.equal(rc, 1);
  assert.equal(
    err,
    "ERROR: could not reach the server: connect ECONNREFUSED. The settings were not applied.\n",
  );
  assert.ok(!calls.some((call) => call.method === "PUT"));
});

test("a TLS failure on login during apply says the settings were not applied", async () => {
  const { rc, err } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [["/login/sessions", "POST", { throws: fetchFailure("DEPTH_ZERO_SELF_SIGNED_CERT") }]],
  );
  assert.equal(rc, 1);
  assert.equal(err, `${CERT_ERROR} The settings were not applied.\n`);
});

test("an SSL error mid-stream after the PUT says the outcome is unknown", async () => {
  const { rc, err } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { throws: fetchFailure("ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC") }],
    ],
  );
  assert.equal(rc, 1);
  assert.match(err, /Outcome unknown/);
  assert.doesNotMatch(err, /certificate|not applied/);
});

// ---------------------------------------------------------------------------
// Logout, always
// ---------------------------------------------------------------------------

test("a refused apply still logs out", async () => {
  const { rc, calls } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { status: 403 }]],
  );
  assert.equal(rc, 1);
  assert.ok(loggedOut(calls));
});

test("a failed download still logs out", async () => {
  const { rc, calls } = await run(
    (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "GET", { status: 500 }]],
  );
  assert.equal(rc, 1);
  assert.ok(loggedOut(calls));
});

for (const [label, reply] of [
  ["throws", { throws: fetchFailure("ECONNRESET") }],
  ["answers 500", { status: 500 }],
] as const) {
  test(`a logout that ${label} after a successful apply is only a warning`, async () => {
    const { rc, out, err } = await run(
      (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
      [LOGIN_OK, [SETTINGS_URL, "PUT", { json: APPLIED_REPLY }], ["/login/sessions/tok-1", "DELETE", reply]],
    );
    assert.equal(rc, 0);
    assert.match(out, /Applied Device Agent settings to device device-1/);
    assert.match(err, /^WARNING: could not log out/);
    assert.doesNotMatch(err, /ERROR/);
  });
}

test("a logout that fails after a successful download is only a warning", async () => {
  const { rc, out, err, files } = await run(
    (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
    [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { json: BARE_SETTINGS }],
      ["/login/sessions/tok-1", "DELETE", { throws: fetchFailure("ECONNRESET") }],
    ],
  );
  assert.equal(rc, 0);
  assert.match(out, /Downloaded/);
  assert.match(err, /WARNING/);
  assert.deepEqual(files, ["s.json"]);
});

// ---------------------------------------------------------------------------
// Login error wording
// ---------------------------------------------------------------------------

for (const [label, reply, message] of [
  ["a 500", { status: 500 }, "ERROR: Login failed: HTTP 500.\n"],
  ["a non-JSON body", { text: "<html>" }, "ERROR: Login failed: the response was not valid JSON.\n"],
  ["JSON without a token", { json: { id: "x" } }, "ERROR: Login failed: the response did not contain a token.\n"],
  ["a JSON list", { json: [{ token: "tok-1" }] }, "ERROR: Login failed: the response did not contain a token.\n"],
  ["a non-string token", { json: { token: 7 } }, "ERROR: Login failed: the response did not contain a token.\n"],
] as const) {
  test(`login answered with ${label} has its own message`, async () => {
    const { rc, err } = await run(() => ["download", ...CREDS], [["/login/sessions", "POST", reply]]);
    assert.equal(rc, 1);
    assert.equal(err, message);
    assert.doesNotMatch(err, /could not reach/);
  });
}

// ---------------------------------------------------------------------------
// Download: JSON object check, directory, no-clobber, side file
// ---------------------------------------------------------------------------

for (const [label, reply] of [
  ["a list", { json: [1, 2] }],
  ["not JSON", { text: "<html>" }],
  ["an empty body", { text: "" }],
] as const) {
  test(`download refuses ${label} from the server and writes nothing`, async () => {
    const { rc, err, files, calls } = await run(
      (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
      [LOGIN_OK, [SETTINGS_URL, "GET", reply]],
    );
    assert.equal(rc, 1);
    assert.match(err, /the server did not return a JSON object/);
    assert.deepEqual(files, []);
    assert.ok(loggedOut(calls));
  });
}

test("download refuses a directory as --out, before logging in", async () => {
  const { rc, err, calls } = await run((dir) => ["download", "--out", dir, ...CREDS], [LOGIN_OK]);
  assert.equal(rc, 1);
  assert.match(err, /is a directory/);
  assert.deepEqual(calls, []);
});

test("without --force a file that appears during the download is kept", async () => {
  let target = "";
  const { rc, err, files } = await run(
    (dir) => {
      target = path.join(dir, "s.json");
      return ["download", "--out", target, ...CREDS];
    },
    [
      LOGIN_OK,
      [SETTINGS_URL, "GET", {
        json: BARE_SETTINGS,
        onCall: () => fs.writeFileSync(target, "someone else's file"),
      }],
    ],
    () => {},
  );
  assert.equal(rc, 1);
  assert.match(err, /ERROR: .*s\.json already exists; use --force/);
  // Only the other file: no side file left, nothing overwritten.
  assert.deepEqual(files, ["s.json"]);
});

test("without --force an auto-named file that appears during the download is kept", async () => {
  const dir = tempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    // The name has a one-second timestamp, so cover this second and the next.
    const now = Date.now();
    const names = [defaultOutputName("device-1", new Date(now)), defaultOutputName("device-1", new Date(now + 1000))];
    const { fetchImpl } = fakeFetch([
      LOGIN_OK,
      [SETTINGS_URL, "GET", {
        json: BARE_SETTINGS,
        onCall: () => names.forEach((n) => fs.writeFileSync(n, "someone else's file")),
      }],
    ]);
    const stderr = memoryStream();
    const rc = await main(["download", ...CREDS], { fetchImpl, stderr, stdout: memoryStream() });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /already exists; use --force/);
    assert.deepEqual(fs.readdirSync(dir).sort(), [...names].sort());
    for (const n of names) assert.equal(fs.readFileSync(n, "utf-8"), "someone else's file");
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("download refuses an existing auto-named file before logging in", async () => {
  const dir = tempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const now = Date.now();
    const names = [defaultOutputName("device-1", new Date(now)), defaultOutputName("device-1", new Date(now + 1000))];
    for (const n of names) fs.writeFileSync(n, "old");
    const { fetchImpl, calls } = fakeFetch([LOGIN_OK]);
    const stderr = memoryStream();
    const rc = await main(["download", ...CREDS], { fetchImpl, stderr });
    assert.equal(rc, 1);
    assert.match(stderr.text(), /already exists; use --force/);
    assert.deepEqual(calls, []);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--force replaces an existing file", async () => {
  let target = "";
  const { rc, files } = await run(
    (dir) => {
      target = path.join(dir, "s.json");
      return ["download", "--out", target, "--force", ...CREDS];
    },
    [LOGIN_OK, [SETTINGS_URL, "GET", {
      json: BARE_SETTINGS,
      onCall: () => assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), { old: true }),
    }]],
    (dir) => fs.writeFileSync(path.join(dir, "s.json"), '{"old": true}'),
  );
  assert.equal(rc, 0);
  assert.deepEqual(files, ["s.json"]);
});

test("the downloaded file is readable by its owner only", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, "s.json");
    saveSettingsFile(target, BARE_SETTINGS);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ["s.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a move into place that fails leaves no side file behind", async () => {
  const dir = tempDir();
  try {
    // --force renames onto the destination; a non-empty directory there fails.
    const target = path.join(dir, "taken");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "x"), "x");
    assert.throws(() => saveSettingsFile(target, BARE_SETTINGS, { overwrite: true }));
    assert.deepEqual(fs.readdirSync(dir), ["taken"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Make every fs.linkSync fail with `code`, as on a filesystem without hard links. */
function withoutHardLinks(code: string, body: () => void): void {
  const linkMock = mock.method(fs, "linkSync", () => {
    throw Object.assign(new Error(`${code}: operation not supported, link`), { code });
  });
  try {
    body();
  } finally {
    linkMock.mock.restore();
  }
}

for (const code of ["ENOTSUP", "EPERM", "EXDEV"]) {
  test(`without hard links (${code}) the file is renamed into place`, () => {
    const dir = tempDir();
    try {
      const target = path.join(dir, "s.json");
      withoutHardLinks(code, () => saveSettingsFile(target, BARE_SETTINGS));
      assert.deepEqual(fs.readdirSync(dir), ["s.json"]);
      assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), BARE_SETTINGS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("without hard links an existing file is still kept, and no side file stays", () => {
  const dir = tempDir();
  try {
    const target = path.join(dir, "s.json");
    fs.writeFileSync(target, "someone else's file");
    withoutHardLinks("EOPNOTSUPP", () => {
      assert.throws(() => saveSettingsFile(target, BARE_SETTINGS), /s\.json already exists; use --force$/);
    });
    assert.deepEqual(fs.readdirSync(dir), ["s.json"]);
    assert.equal(fs.readFileSync(target, "utf-8"), "someone else's file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unwritable --out exits 1 and names the --out path, not the side file", async () => {
  let out = "";
  const { rc, err, calls, files } = await run(
    (dir) => ["download", "--out", (out = path.join(dir, "missing-folder", "s.json")), ...CREDS],
    [LOGIN_OK, [SETTINGS_URL, "GET", { json: BARE_SETTINGS }]],
  );
  assert.equal(rc, 1);
  assert.equal(err, `ERROR: could not use ${out}: No such file or directory.\n`);
  assert.doesNotMatch(err, /partial|ENOENT|could not reach/);
  assert.ok(loggedOut(calls));
  assert.deepEqual(files, []);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test("a boolean flag given a value is an error, so --yes=no is not yes", async () => {
  for (const flag of ["--yes=no", "--force=false", "--insecure=0"]) {
    assert.throws(() => parseArgs(["apply", "f.json", flag]), /takes no value/, flag);
  }
  const { rc, err, calls } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes=no", ...CREDS],
    [LOGIN_OK],
  );
  assert.equal(rc, 2);
  assert.match(err, /ERROR: --yes takes no value/);
  assert.deepEqual(calls, []);
});

test("a value flag with nothing after it is an error, not a silent default", async () => {
  assert.throws(() => parseArgs(["download", "--out"]), /Missing value for --out/);
  const stderr = memoryStream();
  assert.equal(await main(["download", "--host"], { stderr }), 2);
  assert.match(stderr.text(), /ERROR: Missing value for --host/);
});

test("a value flag followed by another flag is missing its value: --out --force", async () => {
  assert.throws(() => parseArgs(["download", "--out", "--force"]), /Missing value for --out/);
  const { rc, err, calls, files } = await run(() => ["download", "--out", "--force", ...CREDS], [LOGIN_OK]);
  assert.equal(rc, 2);
  assert.match(err, /^ERROR: Missing value for --out\n/);
  assert.deepEqual(calls, []);
  assert.deepEqual(files, []);
});

test("an empty inline value is missing too: --out=", async () => {
  assert.throws(() => parseArgs(["download", "--out="]), /Missing value for --out/);
  const { rc, err, calls } = await run(() => ["download", "--out=", ...CREDS], [LOGIN_OK]);
  assert.equal(rc, 2);
  assert.match(err, /^ERROR: Missing value for --out\n/);
  assert.deepEqual(calls, []);
});

test("a value flag takes the next argument, or an inline value", () => {
  const args = parseArgs(["download", "--out", "a.json", "--host=https://h:7001"]);
  assert.equal(args.out, "a.json");
  assert.equal(args.host, "https://h:7001");
});

test("Ctrl-C mid-download logs out, says Interrupted. and exits 130", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  const seen: string[] = [];
  let reached: () => void = () => {};
  const getReached = new Promise<void>((resolve) => (reached = resolve));
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url?.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.url?.endsWith("/settings")) {
      reached();
      return; // ...and never answer
    }
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const script = fileURLToPath(new URL("./rest_copy_device_agent_settings.ts", import.meta.url));
    const child = spawn(process.execPath, [
      script, "download", "--out", path.join(dir, "s.json"),
      "--host", `http://127.0.0.1:${port}`, "--user", "admin", "--password", "secret",
      "--device-id", "device-1", "--engine-id", "engine-1", "--dotenv", "/nonexistent/.env",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderrText = "";
    child.stderr.on("data", (chunk) => (stderrText += String(chunk)));
    await getReached;
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.equal(code, 130);
    assert.match(stderrText, /Interrupted\./);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.ok(seen.includes("DELETE /rest/v4/login/sessions/tok-1"), seen.join(", "));
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Ctrl-C after which the apply still finishes keeps the run's own result", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  let reached: () => void = () => {};
  const putReached = new Promise<void>((resolve) => (reached = resolve));
  let answerPut: () => void = () => {};
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.url?.endsWith("/settings")) {
      answerPut = () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      };
      reached();
      return; // held until the Ctrl-C cleanup logs out
    }
    // The cleanup's logout: let the PUT answer first, and the run finish,
    // while this DELETE is still pending.
    answerPut();
    setTimeout(() => {
      res.writeHead(204);
      res.end();
    }, 500);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const settingsFile = writeSettings(dir, BARE_SETTINGS);
    const script = fileURLToPath(new URL("./rest_copy_device_agent_settings.ts", import.meta.url));
    const child = spawn(process.execPath, [
      script, "apply", settingsFile, "--yes",
      "--host", `http://127.0.0.1:${port}`, "--user", "admin", "--password", "secret",
      "--device-id", "device-1", "--engine-id", "engine-1", "--dotenv", "/nonexistent/.env",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutText = "";
    let stderrText = "";
    child.stdout.on("data", (chunk) => (stdoutText += String(chunk)));
    child.stderr.on("data", (chunk) => (stderrText += String(chunk)));
    await putReached;
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.match(stdoutText, /Applied Device Agent settings to device device-1/);
    assert.equal(code, 0, stderrText);
    assert.doesNotMatch(stderrText, /Interrupted/);
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Ctrl-C during the final logout keeps the result, warns and exits 0", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  let reached: () => void = () => {};
  const deleteReached = new Promise<void>((resolve) => (reached = resolve));
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.url?.endsWith("/settings")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end("{}");
    }
    reached();
    // The final DELETE: held, never answered.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const settingsFile = writeSettings(dir, BARE_SETTINGS);
    const script = fileURLToPath(new URL("./rest_copy_device_agent_settings.ts", import.meta.url));
    const child = spawn(process.execPath, [
      script, "apply", settingsFile, "--yes",
      "--host", `http://127.0.0.1:${port}`, "--user", "admin", "--password", "secret",
      "--device-id", "device-1", "--engine-id", "engine-1", "--dotenv", "/nonexistent/.env",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdoutText = "";
    let stderrText = "";
    child.stdout.on("data", (chunk) => (stdoutText += String(chunk)));
    child.stderr.on("data", (chunk) => (stderrText += String(chunk)));
    await deleteReached;
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.match(stdoutText, /Applied Device Agent settings to device device-1/);
    assert.equal(stderrText, "WARNING: could not log out: interrupted.\n");
    assert.equal(code, 0);
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round 5: one rule for a failing final logout, one final period per reason,
// argument errors without the usage block
// ---------------------------------------------------------------------------

const ENGINE_ERRORS = { ...BARE_SETTINGS, _error: { sensitivity: "out of range" } };

test("Engine errors, then a failed logout: the errors, a warning, exit 1", async () => {
  const { rc, err } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS],
    [
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { json: ENGINE_ERRORS }],
      ["/login/sessions/tok-1", "DELETE", { status: 500 }],
    ],
  );
  assert.equal(rc, 1);
  assert.equal(
    err,
    "ERROR: The server took the settings but the Engine reported errors:\n" +
      "  sensitivity: out of range\n" +
      "WARNING: could not log out: Logout failed: HTTP 500.\n",
  );
});

test("a failed GET, then a failed logout: only the GET error", async () => {
  const { rc, err, calls } = await run(
    (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
    [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { status: 500 }],
      ["/login/sessions/tok-1", "DELETE", { status: 500 }],
    ],
  );
  assert.equal(rc, 1);
  assert.equal(err, "ERROR: Reading settings failed: HTTP 500.\n");
  assert.ok(loggedOut(calls));
});

test("a logout with no answer in time warns 'no answer within <n> s.' with one period", async () => {
  const { rc, err } = await run(
    (dir) => ["download", "--out", path.join(dir, "s.json"), ...CREDS],
    [
      LOGIN_OK,
      [SETTINGS_URL, "GET", { json: BARE_SETTINGS }],
      ["/login/sessions/tok-1", "DELETE", { throws: new Error("no answer within 30 s") }],
    ],
  );
  assert.equal(rc, 0);
  assert.equal(err, "WARNING: could not log out: no answer within 30 s.\n");
});

test("a reason that already ends in periods ends in exactly one", async () => {
  const { err } = await run(
    () => ["download", ...CREDS],
    [["/login/sessions", "POST", { throws: fetchFailure("ECONNRESET", "socket hang up..") }]],
  );
  assert.equal(err, "ERROR: could not reach the server: socket hang up.\n");
});

test("an argument error prints only the ERROR line, not the usage block", async () => {
  const stdout = memoryStream();
  const stderr = memoryStream();
  assert.equal(await main(["download", "--bogus"], { stdout, stderr }), 2);
  assert.equal(stderr.text(), "ERROR: Unknown argument: --bogus\n");
  assert.equal(stdout.text(), "");
});

for (const flag of ["--help", "-h"]) {
  test(`${flag} prints the usage and exits 0`, async () => {
    const stdout = memoryStream();
    const stderr = memoryStream();
    assert.equal(await main([flag], { stdout, stderr }), 0);
    assert.match(stdout.text(), /^Usage:\n/);
    assert.match(stdout.text(), /--help, -h/);
    assert.equal(stderr.text(), "");
  });

  test(`${flag} after the subcommand prints the usage too`, async () => {
    const stdout = memoryStream();
    assert.equal(await main(["apply", "f.json", flag], { stdout, stderr: memoryStream() }), 0);
    assert.match(stdout.text(), /^Usage:\n/);
  });
}

test("-h as a flag's value is that value, not help", () => {
  const args = parseArgs(["apply", "f", "--yes", "--password", "-h"]);
  assert.equal(args.help, false);
  assert.equal(args.password, "-h");
});

test("apply with --password -h does not print the usage", async () => {
  const { rc, out, err, calls } = await run(
    (dir) => ["apply", writeSettings(dir, BARE_SETTINGS), "--yes", ...CREDS, "--password", "-h"],
    [LOGIN_OK, [SETTINGS_URL, "PUT", { json: {} }]],
  );
  assert.equal(rc, 0, err);
  assert.doesNotMatch(out, /Usage:/);
  assert.equal(JSON.parse(String(calls[0]?.body)).password, "-h");
});

test("Ctrl-C during the logout after Engine errors: errors, warning, exit 1", { skip: process.platform === "win32" }, async () => {
  const dir = tempDir();
  let reached: () => void = () => {};
  const deleteReached = new Promise<void>((resolve) => (reached = resolve));
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url?.endsWith("/login/sessions") && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ token: "tok-1" }));
    }
    if (req.url?.endsWith("/settings")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(ENGINE_ERRORS));
    }
    reached();
    // The final DELETE: held, never answered.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const settingsFile = writeSettings(dir, BARE_SETTINGS);
    const script = fileURLToPath(new URL("./rest_copy_device_agent_settings.ts", import.meta.url));
    const child = spawn(process.execPath, [
      script, "apply", settingsFile, "--yes",
      "--host", `http://127.0.0.1:${port}`, "--user", "admin", "--password", "secret",
      "--device-id", "device-1", "--engine-id", "engine-1", "--dotenv", "/nonexistent/.env",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderrText = "";
    child.stderr.on("data", (chunk) => (stderrText += String(chunk)));
    await deleteReached;
    child.kill("SIGINT");
    const [code] = await once(child, "close");
    assert.equal(
      stderrText,
      "ERROR: The server took the settings but the Engine reported errors:\n" +
        "  sensitivity: out of range\n" +
        "WARNING: could not log out: interrupted.\n",
    );
    assert.equal(code, 1);
  } finally {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
