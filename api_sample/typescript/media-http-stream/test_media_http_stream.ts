// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for media_http_stream.ts. No network, no account, no live camera.
 * The "video" is a fake byte stream; saveClip writes it through an injected
 * sink (and, in one test, a real temp file).
 *
 * Run from this folder:  node --test test_media_http_stream.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NxMediaClient,
  fileSink,
  parseArgs,
  resolveConfig,
  missingFields,
  normalizeFormat,
  parsePositionMs,
  durationToMs,
  defaultOutName,
  FORMATS,
  MODE_DIRECT,
  MODE_CLOUD,
  DEFAULT_FORMAT,
  AuthError,
  ApiError,
  type ClientOptions,
  type ClipSink,
} from "./media_http_stream.ts";

// ---------------------------------------------------------------------------
// Fake HTTP plumbing
// ---------------------------------------------------------------------------

/** A web ReadableStream over the given byte chunks. */
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

interface FakeResponseSpec {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  body?: Uint8Array[] | null;
}

function makeResponse({
  status = 200,
  json = null,
  text = "",
  headers = {},
  body = null,
}: FakeResponseSpec = {}): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    body: body === null ? null : streamOf(body),
    async json() {
      if (json === null) throw new Error("no json");
      return json;
    },
    async text() {
      return text;
    },
  } as unknown as Response;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: RequestInit["redirect"];
  body: Record<string, unknown> | null;
}

type Handler = (call: RecordedCall, index: number) => Response;
type FakeFetch = typeof globalThis.fetch & { calls: RecordedCall[] };

/** Programmable fake fetch: a handler decides each response from the call. */
function fakeFetch(handler: Handler): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = (async (url: string | URL | Request, options: RequestInit = {}) => {
    const hdrs: Record<string, string> = {};
    const h = options.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) hdrs[k] = v;
    const call: RecordedCall = {
      url: String(url),
      method: (options.method || "GET").toUpperCase(),
      headers: hdrs,
      redirect: options.redirect,
      body: options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : null,
    };
    const idx = calls.length;
    calls.push(call);
    return handler(call, idx);
  }) as FakeFetch;
  impl.calls = calls;
  return impl;
}

const SITE = "11111111-2222-3333-4444-555555555555";
const SERVER = "https://192.168.1.10:7001";

function directClient(handler: Handler, opts: ClientOptions = {}) {
  const f = fakeFetch(handler);
  const client = new NxMediaClient(MODE_DIRECT, "admin", "pw", {
    serverHost: SERVER,
    fetchImpl: f,
    ...opts,
  });
  return { client, f };
}

function cloudClient(handler: Handler, opts: ClientOptions = {}) {
  const f = fakeFetch(handler);
  const client = new NxMediaClient(MODE_CLOUD, "me@x.com", "pw", {
    cloudHost: "https://nxvms.com",
    siteId: SITE,
    fetchImpl: f,
    ...opts,
  });
  return { client, f };
}

// ---------------------------------------------------------------------------
// Pure helpers: format, position, duration
// ---------------------------------------------------------------------------

test("FORMATS matches the v4 spec enum exactly", () => {
  assert.deepEqual(
    [...FORMATS],
    ["webm", "mpegts", "mpjpeg", "mp4", "mkv", "_3gp", "rtp", "flv", "f4v"],
  );
});

test("normalizeFormat accepts every spec format and strips a leading dot", () => {
  for (const fmt of FORMATS) {
    assert.equal(normalizeFormat(fmt), fmt);
    assert.equal(normalizeFormat("." + fmt), fmt);
    assert.equal(normalizeFormat(fmt.toUpperCase()), fmt);
  }
  assert.equal(normalizeFormat(undefined), DEFAULT_FORMAT);
});

test("normalizeFormat rejects an unsupported container", () => {
  assert.throws(() => normalizeFormat("avi"), ApiError);
  assert.throws(() => normalizeFormat("m3u8"), ApiError); // HLS is not on this endpoint
});

test("parsePositionMs: blank is live, digits are epoch, ISO parses, junk throws", () => {
  assert.equal(parsePositionMs(""), null);
  assert.equal(parsePositionMs(null), null);
  assert.equal(parsePositionMs("1700000000000"), 1700000000000);
  assert.equal(parsePositionMs("2026-06-15T12:00:00Z"), Date.parse("2026-06-15T12:00:00Z"));
  assert.throws(() => parsePositionMs("not-a-time"), ApiError);
});

test("durationToMs: default, value, and rejection of non-positive", () => {
  assert.equal(durationToMs(null), 10000);
  assert.equal(durationToMs("5"), 5000);
  assert.equal(durationToMs("2.5"), 2500);
  assert.throws(() => durationToMs("0"), ApiError);
  assert.throws(() => durationToMs("-3"), ApiError);
  assert.throws(() => durationToMs("abc"), ApiError);
});

test("defaultOutName is filesystem-safe and ends with the format", () => {
  const name = defaultOutName("cam/01:02", "mp4", new Date("2026-06-15T12:00:00Z"));
  assert.match(name, /^clip-cam_01_02-.*\.mp4$/);
  assert.ok(!name.includes(":"));
});

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

test("parseArgs reads space- and equals-style flags and the boolean", () => {
  const a = parseArgs([
    "--mode", "cloud",
    "--site-id=" + SITE,
    "--device-id", "cam1",
    "--format=mkv",
    "--pos", "2026-06-15T12:00:00Z",
    "--duration", "8",
    "--out=/tmp/clip.mkv",
    "--insecure",
  ]);
  assert.equal(a.mode, "cloud");
  assert.equal(a.siteId, SITE);
  assert.equal(a.deviceId, "cam1");
  assert.equal(a.format, "mkv");
  assert.equal(a.pos, "2026-06-15T12:00:00Z");
  assert.equal(a.duration, "8");
  assert.equal(a.out, "/tmp/clip.mkv");
  assert.equal(a.insecure, true);
});

test("parseArgs uses --dotenv (NOT --env-file) and rejects unknown flags", () => {
  assert.equal(parseArgs(["--dotenv", "x.env"]).envFile, "x.env");
  assert.throws(() => parseArgs(["--env-file", "x.env"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// resolveConfig + missingFields (mode-aware env var selection)
// ---------------------------------------------------------------------------

test("resolveConfig picks SERVER vars in direct mode", () => {
  const cfg = resolveConfig(
    { mode: "direct", deviceId: "cam1" },
    {},
    {
      NX_SERVER_HOST: SERVER,
      NX_SERVER_USER: "admin",
      NX_SERVER_PASSWORD: "pw",
      NX_CLOUD_USER: "should-not-win",
    } as NodeJS.ProcessEnv,
  );
  assert.equal(cfg.mode, MODE_DIRECT);
  assert.equal(cfg.serverHost, SERVER);
  assert.equal(cfg.user, "admin");
  assert.equal(cfg.format, DEFAULT_FORMAT);
  assert.equal(cfg.positionMs, null); // live
  assert.equal(cfg.durationMs, 10000); // default
  assert.deepEqual(missingFields(cfg), []);
});

test("resolveConfig picks CLOUD vars in cloud mode and defaults cloudHost", () => {
  const cfg = resolveConfig(
    { mode: "cloud", deviceId: "cam1", siteId: SITE },
    {},
    { NX_CLOUD_USER: "me@x.com", NX_CLOUD_PASSWORD: "pw" } as NodeJS.ProcessEnv,
  );
  assert.equal(cfg.mode, MODE_CLOUD);
  assert.equal(cfg.cloudHost, "https://nxvms.com");
  assert.equal(cfg.user, "me@x.com");
  assert.deepEqual(missingFields(cfg), []);
});

test("missingFields reports what each mode needs", () => {
  const direct = resolveConfig({ mode: "direct" }, {}, {} as NodeJS.ProcessEnv);
  assert.deepEqual(missingFields(direct).sort(), ["deviceId", "password", "serverHost", "user"]);
  const cloud = resolveConfig({ mode: "cloud" }, {}, {} as NodeJS.ProcessEnv);
  assert.deepEqual(missingFields(cloud).sort(), ["deviceId", "password", "siteId", "user"]);
});

test("CLI flags beat env vars", () => {
  const cfg = resolveConfig(
    { mode: "direct", serverHost: "https://flag:7001", deviceId: "cam1", user: "u", password: "p" },
    {},
    { NX_SERVER_HOST: "https://env:7001" } as NodeJS.ProcessEnv,
  );
  assert.equal(cfg.serverHost, "https://flag:7001");
});

// ---------------------------------------------------------------------------
// login: direct + cloud
// ---------------------------------------------------------------------------

test("direct login posts to the server and stores the token", async () => {
  const { client, f } = directClient(() => makeResponse({ json: { token: "srv-tok" } }));
  const tok = await client.login();
  assert.equal(tok, "srv-tok");
  assert.equal(f.calls[0]!.url, `${SERVER}/rest/v4/login/sessions`);
  assert.equal(f.calls[0]!.body!.setCookie, false);
});

test("direct login 401 raises AuthError", async () => {
  const { client } = directClient(() => makeResponse({ status: 401, text: "no" }));
  await assert.rejects(() => client.login(), AuthError);
});

test("cloud login sends the cloudSystemId scope and mfa, stores access_token", async () => {
  const { client, f } = cloudClient(() => makeResponse({ json: { access_token: "nxcdb-t" } }), {
    mfaCode: "123456",
  });
  const tok = await client.login();
  assert.equal(tok, "nxcdb-t");
  assert.equal(f.calls[0]!.url, "https://nxvms.com/cdb/oauth2/token");
  assert.equal(f.calls[0]!.body!.scope, `cloudSystemId=${SITE}`);
  assert.equal(f.calls[0]!.body!.mfaCode, "123456");
  assert.equal(f.calls[0]!.body!.client_id, "3rdParty");
});

test("cloud login 403 raises AuthError", async () => {
  const { client } = cloudClient(() => makeResponse({ status: 403, text: "no" }));
  await assert.rejects(() => client.login(), AuthError);
});

// ---------------------------------------------------------------------------
// buildMediaUrl: live vs archive, format, encoding
// ---------------------------------------------------------------------------

test("buildMediaUrl (direct, live) omits positionMs and hits the server host", () => {
  const { client } = directClient(() => makeResponse());
  const url = client.buildMediaUrl({ deviceId: "cam 1", format: "webm", durationMs: 10000 });
  assert.ok(url.startsWith(`${SERVER}/rest/v4/devices/cam%201/media.webm?`));
  assert.ok(url.includes("durationMs=10000"));
  assert.ok(!url.includes("positionMs"));
});

test("buildMediaUrl (cloud, archive) includes positionMs and hits the relay", () => {
  const { client } = cloudClient(() => makeResponse());
  const url = client.buildMediaUrl({ deviceId: "cam1", format: "mkv", positionMs: 1700000000000, durationMs: 5000 });
  assert.ok(url.startsWith(`https://${SITE}.relay.vmsproxy.com/rest/v4/devices/cam1/media.mkv?`));
  assert.ok(url.includes("positionMs=1700000000000"));
  assert.ok(url.includes("durationMs=5000"));
});

test("buildMediaUrl never leaks the token into the URL", () => {
  const { client } = directClient(() => makeResponse());
  client.token = "secret-tok";
  const url = client.buildMediaUrl({ deviceId: "cam1", format: "mp4" });
  assert.ok(!url.includes("secret-tok"));
  assert.ok(!url.toLowerCase().includes("auth="));
});

// ---------------------------------------------------------------------------
// saveClip: streaming, relay 307, error paths
// ---------------------------------------------------------------------------

const CHUNKS = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]; // 6 bytes

/** A sink that drains the stream and returns the byte count (no disk). */
const countingSink: ClipSink = async (body) => {
  let n = 0;
  const reader = body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) n += value.byteLength;
  }
  return n;
};

test("saveClip streams the body to the sink and sends the bearer header", async () => {
  const { client, f } = directClient((call) => {
    assert.equal(call.headers.Authorization, "Bearer srv-tok");
    return makeResponse({ body: CHUNKS });
  });
  client.token = "srv-tok";
  const bytes = await client.saveClip(countingSink, { deviceId: "cam1", format: "webm", durationMs: 1000 });
  assert.equal(bytes, 6);
  assert.equal(f.calls[0]!.redirect, "manual");
});

test("saveClip follows the relay 307 and RE-ATTACHES the bearer on the new host", async () => {
  const relayUrl = `https://${SITE}.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm`;
  const redirected = "https://node-7.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm";
  const { client, f } = cloudClient((call, idx) => {
    if (idx === 0) {
      assert.ok(call.url.startsWith(relayUrl));
      return makeResponse({ status: 307, headers: { Location: redirected } });
    }
    assert.equal(call.url.split("?")[0], redirected);
    return makeResponse({ body: CHUNKS });
  });
  client.token = "nxcdb-t";
  const bytes = await client.saveClip(countingSink, { deviceId: "cam1", format: "webm", durationMs: 1000 });
  assert.equal(bytes, 6);
  // Bearer present on BOTH hops.
  assert.equal(f.calls[0]!.headers.Authorization, "Bearer nxcdb-t");
  assert.equal(f.calls[1]!.headers.Authorization, "Bearer nxcdb-t");
});

test("saveClip raises AuthError on 401 from the media endpoint", async () => {
  const { client } = directClient(() => makeResponse({ status: 401 }));
  client.token = "t";
  await assert.rejects(
    () => client.saveClip(countingSink, { deviceId: "cam1", format: "webm", durationMs: 1000 }),
    AuthError,
  );
});

test("saveClip raises ApiError on a non-OK status", async () => {
  const { client } = directClient(() => makeResponse({ status: 404, text: "no such device" }));
  client.token = "t";
  await assert.rejects(
    () => client.saveClip(countingSink, { deviceId: "cam1", format: "webm", durationMs: 1000 }),
    ApiError,
  );
});

test("saveClip raises ApiError when the response has no body", async () => {
  const { client } = directClient(() => makeResponse({ body: null }));
  client.token = "t";
  await assert.rejects(
    () => client.saveClip(countingSink, { deviceId: "cam1", format: "webm", durationMs: 1000 }),
    ApiError,
  );
});

test("saveClip refuses to run before login", async () => {
  const { client } = directClient(() => makeResponse({ body: CHUNKS }));
  await assert.rejects(
    () => client.saveClip(countingSink, { deviceId: "cam1", format: "webm", durationMs: 1000 }),
    ApiError,
  );
});

test("too many redirects raises ApiError", async () => {
  const { client } = cloudClient((call) =>
    makeResponse({ status: 307, headers: { Location: call.url + "/x" } }),
  );
  client.token = "t";
  await assert.rejects(
    () => client.saveClip(countingSink, { deviceId: "cam1", format: "webm", durationMs: 1000 }),
    /Too many redirects/,
  );
});

// ---------------------------------------------------------------------------
// fileSink: the real disk path (still offline)
// ---------------------------------------------------------------------------

test("fileSink writes the exact bytes to a file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-clip-"));
  const out = path.join(dir, "clip.webm");
  try {
    const { client } = directClient(() => makeResponse({ body: CHUNKS }));
    client.token = "t";
    const bytes = await client.saveClip(fileSink(out), { deviceId: "cam1", format: "webm", durationMs: 1000 });
    assert.equal(bytes, 6);
    assert.deepEqual([...fs.readFileSync(out)], [1, 2, 3, 4, 5, 6]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

test("direct logout DELETEs the server session", async () => {
  const { client, f } = directClient(() => makeResponse({ status: 204 }));
  client.token = "srv-tok";
  await client.logout();
  assert.equal(f.calls[0]!.method, "DELETE");
  assert.equal(f.calls[0]!.url, `${SERVER}/rest/v4/login/sessions/srv-tok`);
  assert.equal(client.token, null);
});

test("cloud logout DELETEs the token on the cloud", async () => {
  const { client, f } = cloudClient(() => makeResponse({ status: 204 }));
  client.token = "nxcdb-t";
  await client.logout();
  assert.equal(f.calls[0]!.url, "https://nxvms.com/cdb/oauth2/token/nxcdb-t");
  assert.equal(client.token, null);
});
