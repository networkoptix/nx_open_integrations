// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for virtual_camera_upload.ts. No network, no server needed.
 *
 * Run from this folder:  node --test test_virtual_camera_upload.ts
 *
 * Node 22 strips the TypeScript types and runs the file directly — there is no
 * build step. These tests inject a fake fetch (the FetchImpl seam), write small
 * temp files for the hashing/chunking paths, and assert the exact request
 * sequence. They confirm the corrected v4 flow: the file is uploaded BEFORE any
 * lock, then lock -> consume -> extend(poll) -> release drives the import, and a
 * failure after the upload exists cancels it (DELETE) before releasing.
 *
 * A fake clock stands in for sleeping, so the extend-poll loop never really
 * waits.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NxVirtualCameraClient,
  uploadVideo,
  waitForConsume,
  parseStartTimeMs,
  fileMd5Base64,
  chunkPlan,
  buildItemsPayload,
  parseDeviceId,
  parseLockToken,
  parseLockProgress,
  parseUploadItem,
  parseUploadProgress,
  resolveConfig,
  AuthError,
  ApiError,
} from "./virtual_camera_upload.ts";

import type { FetchImpl } from "../nx-types.ts";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

interface MakeResponseOptions {
  status?: number;
  json?: unknown;
  text?: string;
}

function makeResponse({ status = 200, json = null, text = "" }: MakeResponseOptions = {}): Response {
  return {
    status,
    ok: status < 400,
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
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string> | undefined;
}

interface QueuedResponses {
  post?: Response[];
  patch?: Response[];
  put?: Response[];
  get?: Response[];
  delete?: Response[];
}

type RecordingFetch = FetchImpl & { calls: RecordedCall[] };

/**
 * A fake fetch that records the ordered sequence of calls and serves queued
 * responses per verb. When a queue has more than one entry it pops; with one
 * entry it reuses that response (handy for many PUTs or many extend polls).
 */
function recordingFetch(queues: QueuedResponses = {}): RecordingFetch {
  const calls: RecordedCall[] = [];
  const q: Required<QueuedResponses> = {
    post: [...(queues.post ?? [])],
    patch: [...(queues.patch ?? [])],
    put: [...(queues.put ?? [])],
    get: [...(queues.get ?? [])],
    delete: [...(queues.delete ?? [])],
  };
  const nextOf = (verb: keyof QueuedResponses): Response => {
    const queue = q[verb];
    if (!queue.length) return makeResponse({ json: {} });
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  };
  const impl = async (
    url: string | URL | Request,
    options: RequestInit = {},
  ): Promise<Response> => {
    const method = (options.method || "GET").toUpperCase();
    const headers = options.headers as Record<string, string> | undefined;
    let body: unknown = null;
    if (typeof options.body === "string") {
      try {
        body = JSON.parse(options.body);
      } catch {
        body = options.body;
      }
    } else if (options.body != null) {
      body = options.body; // raw bytes (PUT)
    }
    calls.push({ method, url: String(url), body, headers });
    if (method === "POST") return nextOf("post");
    if (method === "PATCH") return nextOf("patch");
    if (method === "PUT") return nextOf("put");
    if (method === "DELETE") return nextOf("delete");
    return nextOf("get");
  };
  const fake = impl as unknown as RecordingFetch;
  fake.calls = calls;
  return fake;
}

const HOST = "https://srv:7001";

function makeClient(fetchImpl: FetchImpl, token: string | null = "tok"): NxVirtualCameraClient {
  const client = new NxVirtualCameraClient(HOST, "admin", "pw", { fetchImpl });
  client.token = token;
  return client;
}

function tmpFile(name: string, data: Buffer | string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vcu-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return p;
}

/**
 * A controllable stand-in for the clock/sleep pair, so waitForConsume can be
 * tested without any real waiting. Times are in seconds.
 */
class FakeClock {
  now: number;
  sleeps: number[];

  constructor(start = 0) {
    this.now = start;
    this.sleeps = [];
  }

  nowFn = (): number => this.now;

  sleepFn = async (seconds: number): Promise<void> => {
    this.sleeps.push(seconds);
    this.now += seconds;
  };
}

// ---------------------------------------------------------------------------
// fileMd5Base64
// ---------------------------------------------------------------------------

test("fileMd5Base64 matches a known digest", () => {
  const data = Buffer.from("hello virtual camera".repeat(100));
  const p = tmpFile("clip.mkv", data);
  const expected = crypto.createHash("md5").update(data).digest("base64");
  assert.equal(fileMd5Base64(p), expected);
});

// ---------------------------------------------------------------------------
// chunkPlan
// ---------------------------------------------------------------------------

test("chunkPlan partial last chunk", () => {
  assert.deepEqual(chunkPlan(250, 100), [
    { index: 0, offset: 0, length: 100 },
    { index: 1, offset: 100, length: 100 },
    { index: 2, offset: 200, length: 50 },
  ]);
});

test("chunkPlan exact multiple", () => {
  assert.deepEqual(chunkPlan(300, 100), [
    { index: 0, offset: 0, length: 100 },
    { index: 1, offset: 100, length: 100 },
    { index: 2, offset: 200, length: 100 },
  ]);
});

test("chunkPlan smaller than one chunk", () => {
  assert.deepEqual(chunkPlan(40, 100), [{ index: 0, offset: 0, length: 40 }]);
});

test("chunkPlan zero-byte file is one empty chunk", () => {
  assert.deepEqual(chunkPlan(0, 100), [{ index: 0, offset: 0, length: 0 }]);
});

test("chunkPlan rejects non-positive chunk size", () => {
  assert.throws(() => chunkPlan(100, 0), ApiError);
});

// ---------------------------------------------------------------------------
// parseStartTimeMs
// ---------------------------------------------------------------------------

test("parseStartTimeMs accepts epoch ms", () => {
  assert.equal(parseStartTimeMs("1700000000000"), 1700000000000);
});

test("parseStartTimeMs parses ISO UTC", () => {
  // 2021-01-01T00:00:00Z == 1609459200000 ms.
  assert.equal(parseStartTimeMs("2021-01-01T00:00:00Z"), 1609459200000);
});

test("parseStartTimeMs treats naive time as UTC", () => {
  assert.equal(parseStartTimeMs("2021-01-01T00:00:00"), 1609459200000);
});

test("parseStartTimeMs blank defaults to now", () => {
  const fixed = new Date(Date.UTC(2026, 5, 16));
  assert.equal(parseStartTimeMs("", fixed), fixed.getTime());
  assert.equal(parseStartTimeMs(null, fixed), fixed.getTime());
});

test("parseStartTimeMs bad value raises", () => {
  assert.throws(() => parseStartTimeMs("not-a-time"), ApiError);
});

// ---------------------------------------------------------------------------
// buildItemsPayload — durationMs optional
// ---------------------------------------------------------------------------

test("buildItemsPayload declares startTimeMs and omits durationMs when not provided", () => {
  const body = buildItemsPayload("clip.mkv", 1234, "bWQ1", 1700000000000, 1048576);
  assert.deepEqual(body, {
    items: [
      {
        filename: "clip.mkv",
        sizeB: 1234,
        md5: "bWQ1",
        startTimeMs: 1700000000000,
        chunkSizeB: 1048576,
      },
    ],
  });
  assert.ok(!("durationMs" in body.items[0]!), "durationMs must NOT be present when omitted");
});

test("buildItemsPayload includes durationMs when provided", () => {
  const body = buildItemsPayload("clip.mkv", 1234, "bWQ1", 1700000000000, 1048576, 30000);
  assert.equal(body.items[0]!.durationMs, 30000);
});

test("buildItemsPayload omits durationMs when zero or negative", () => {
  const body = buildItemsPayload("clip.mkv", 1, "bWQ1", 1, 1024, 0);
  assert.ok(!("durationMs" in body.items[0]!));
});

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

test("parseDeviceId handles bare object, envelope, and single-item list", () => {
  assert.equal(parseDeviceId({ id: "{dev-1}", name: "x" }), "{dev-1}");
  assert.equal(parseDeviceId({ reply: { id: "{dev-2}" } }), "{dev-2}");
  assert.equal(parseDeviceId([{ id: "{dev-3}" }]), "{dev-3}");
});

test("parseDeviceId missing id raises", () => {
  assert.throws(() => parseDeviceId({ name: "no id here" }), ApiError);
});

test("parseLockToken reads lockInfo.token (and top-level fallbacks)", () => {
  assert.equal(parseLockToken({ id: "d1", lockInfo: { token: "lock-abc" } }), "lock-abc");
  assert.equal(parseLockToken({ reply: { lockInfo: { token: "lock-rep" } } }), "lock-rep");
  assert.equal(parseLockToken({ token: "lock-xyz" }), "lock-xyz");
  assert.equal(parseLockToken({ reply: { token: "lock-env" } }), "lock-env");
});

test("parseLockToken missing token raises", () => {
  assert.throws(() => parseLockToken({ nope: 1 }), ApiError);
});

test("parseLockProgress reads lockInfo.progress", () => {
  assert.equal(parseLockProgress({ id: "d1", lockInfo: { token: "t", progress: 42 } }), 42);
  assert.equal(parseLockProgress({ reply: { lockInfo: { progress: 100 } } }), 100);
});

test("parseLockProgress missing uses the default", () => {
  assert.equal(parseLockProgress({ id: "d1" }, 7), 7);
  assert.equal(parseLockProgress({}, 0), 0);
  assert.equal(parseLockProgress({ lockInfo: { token: "t" } }, 3), 3);
});

test("parseLockProgress non-numeric uses the default", () => {
  assert.equal(parseLockProgress({ lockInfo: { progress: "not-a-number" } }, 5), 5);
});

test("parseUploadItem uses server chunkSizeB and uploadId", () => {
  const info = parseUploadItem(
    { items: [{ uploadId: "clip.mkv", chunkSizeB: 4096 }] },
    1048576,
    "clip.mkv",
  );
  assert.equal(info.uploadId, "clip.mkv");
  assert.equal(info.chunkSizeB, 4096);
});

test("parseUploadItem falls back to requested chunk size and filename", () => {
  const info = parseUploadItem({ items: [{ filename: "clip.mkv" }] }, 2048, "clip.mkv");
  assert.equal(info.uploadId, "clip.mkv");
  assert.equal(info.chunkSizeB, 2048);
});

test("parseUploadItem accepts a bare list response", () => {
  const info = parseUploadItem([{ uploadId: "clip.mkv", chunkSizeB: 512 }], 2048, "clip.mkv");
  assert.equal(info.uploadId, "clip.mkv");
  assert.equal(info.chunkSizeB, 512);
});

test("parseUploadItem ignores a garbage chunk size", () => {
  const info = parseUploadItem({ items: [{ chunkSizeB: "garbage" }] }, 999, "clip.mkv");
  assert.equal(info.chunkSizeB, 999);
});

test("parseUploadProgress reads uploadProgressPercent", () => {
  assert.equal(parseUploadProgress({ uploadProgressPercent: 63 }), 63);
});

test("parseUploadProgress missing defaults to 100", () => {
  // Chunk PUTs are synchronous, so no field present after a clean upload loop
  // is treated as "done", not "unknown".
  assert.equal(parseUploadProgress({}), 100);
  assert.equal(parseUploadProgress({}, 11), 100);
});

test("parseUploadProgress non-numeric uses the default", () => {
  assert.equal(parseUploadProgress({ uploadProgressPercent: "oops" }, 11), 11);
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

test("login posts credentials and stores the token", async () => {
  const f = recordingFetch({ post: [makeResponse({ json: { token: "abc123" } })] });
  const client = new NxVirtualCameraClient(HOST, "admin", "pw", { fetchImpl: f });
  const token = await client.login();
  assert.equal(token, "abc123");
  assert.equal(f.calls[0]!.url, HOST + "/rest/v4/login/sessions");
  assert.deepEqual(f.calls[0]!.body, { username: "admin", password: "pw", setCookie: false });
});

test("login unauthorized raises AuthError", async () => {
  const f = recordingFetch({ post: [makeResponse({ status: 401, text: "bad" })] });
  const client = new NxVirtualCameraClient(HOST, "admin", "pw", { fetchImpl: f });
  await assert.rejects(() => client.login(), AuthError);
});

// ---------------------------------------------------------------------------
// waitForConsume (extend-poll loop)
// ---------------------------------------------------------------------------

test("waitForConsume polls extend until progress reaches 100", async () => {
  const f = recordingFetch({
    patch: [
      makeResponse({ json: { lockInfo: { progress: 30 } } }),
      makeResponse({ json: { lockInfo: { progress: 70 } } }),
      makeResponse({ json: { lockInfo: { progress: 100 } } }),
    ],
  });
  const client = makeClient(f);
  const clock = new FakeClock();
  const seen: string[] = [];

  const progress = await waitForConsume(client, "{dev-1}", "lock-1", 60000, 2, 300, {
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    onProgress: (m) => seen.push(m),
  });

  assert.equal(progress, 100);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((c) => c.method === "PATCH" && c.url.endsWith("/virtual/extend")));
  assert.deepEqual(clock.sleeps, [2, 2, 2]);
  assert.ok(f.calls.every((c) => JSON.stringify(c.body) === JSON.stringify({ ttlMs: 60000, token: "lock-1" })));
  assert.deepEqual(seen, [
    "Consume progress: 30%",
    "Consume progress: 70%",
    "Consume progress: 100%",
  ]);
});

test("waitForConsume times out when progress never reaches 100", async () => {
  const f = recordingFetch({ patch: [makeResponse({ json: { lockInfo: { progress: 40 } } })] });
  const client = makeClient(f);
  const clock = new FakeClock();

  await assert.rejects(
    () =>
      waitForConsume(client, "{dev-1}", "lock-1", 60000, 2, 5, {
        sleepFn: clock.sleepFn,
        nowFn: clock.nowFn,
      }),
    ApiError,
  );
});

// ---------------------------------------------------------------------------
// Full happy-path orchestration: exact call sequence
// ---------------------------------------------------------------------------

test("full upload call sequence: create -> uploads -> PUT chunks -> GET status -> lock -> consume -> extend -> release", async () => {
  // File of 2.5 chunks -> 3 PUTs with chunk=0,1,2.
  const data = Buffer.alloc(250, 0x78); // "x"
  const p = tmpFile("clip.mkv", data);
  const md5B64 = crypto.createHash("md5").update(data).digest("base64");

  const f = recordingFetch({
    post: [
      makeResponse({ json: { id: "{dev-1}" } }), // create virtual
      makeResponse({ json: { items: [{ uploadId: "clip.mkv", chunkSizeB: 100 }] } }), // create upload
    ],
    patch: [
      makeResponse({ json: { lockInfo: { token: "lock-1" } } }), // lock
      makeResponse({ json: { lockInfo: { token: "lock-1" } } }), // consume
      makeResponse({ json: { lockInfo: { progress: 100 } } }), // extend (poll)
      makeResponse({ json: {} }), // release
    ],
    put: [makeResponse({ json: {} })], // reused for every chunk
    get: [makeResponse({ json: { uploadProgressPercent: 100 } })], // upload status
  });
  const client = makeClient(f);
  const clock = new FakeClock();

  const result = await uploadVideo(client, {
    filePath: p,
    name: "Cam",
    startTimeMs: 1700000000000,
    ttlMs: 300000,
    requestedChunkSize: 1048576,
    durationMs: 30000,
    pollIntervalS: 2,
    consumeTimeoutS: 300,
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
  });

  const base = HOST + "/rest/v4/devices";
  const methodsUrls = f.calls.map((c) => [c.method, c.url]);
  // The file is uploaded BEFORE any lock; the lock only covers the import.
  assert.deepEqual(methodsUrls, [
    ["POST", base + "/*/virtual"],
    ["POST", base + "/{dev-1}/virtual/uploads"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv?chunk=0"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv?chunk=1"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv?chunk=2"],
    ["GET", base + "/{dev-1}/virtual/uploads/clip.mkv"],
    ["PATCH", base + "/{dev-1}/virtual/lock"],
    ["PATCH", base + "/{dev-1}/virtual/consume"],
    ["PATCH", base + "/{dev-1}/virtual/extend"],
    ["PATCH", base + "/{dev-1}/virtual/release"],
  ]);

  // Nothing was cancelled on a clean run.
  assert.ok(!f.calls.some((c) => c.method === "DELETE"));

  // Bodies on the way through.
  assert.deepEqual(f.calls[0]!.body, { name: "Cam" });
  assert.deepEqual(f.calls[1]!.body, {
    items: [
      {
        filename: "clip.mkv", sizeB: 250, md5: md5B64, startTimeMs: 1700000000000,
        chunkSizeB: 1048576, durationMs: 30000,
      },
    ],
  });

  // PUT chunks: octet-stream, ?chunk=n, expected byte lengths.
  const puts = f.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(
    puts.map((c) => c.url.slice(c.url.indexOf("?"))),
    ["?chunk=0", "?chunk=1", "?chunk=2"],
  );
  assert.deepEqual(
    puts.map((c) => (c.body as Uint8Array).byteLength),
    [100, 100, 50],
  );
  assert.ok(puts.every((c) => c.headers!["Content-Type"] === "application/octet-stream"));

  // lock / consume / extend / release bodies.
  const [lock, consume, extend, release] = f.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(lock!.body, { ttlMs: 300000 });
  assert.deepEqual(consume!.body, {
    token: "lock-1",
    uploadId: "clip.mkv",
    startTimeMs: 1700000000000,
  });
  assert.deepEqual(extend!.body, { ttlMs: 300000, token: "lock-1" });
  assert.deepEqual(release!.body, { token: "lock-1" });

  // Bearer attached to every authenticated call.
  assert.ok(f.calls.every((c) => c.headers!.Authorization === "Bearer tok"));

  assert.equal(result.deviceId, "{dev-1}");
  assert.equal(result.chunkCount, 3);
  assert.equal(result.chunkSizeB, 100);
  assert.equal(result.consumeProgress, 100);
});

test("existing device id skips the create step", async () => {
  const p = tmpFile("clip.mp4", Buffer.alloc(50, 0x79));
  const f = recordingFetch({
    post: [makeResponse({ json: { items: [{ uploadId: "clip.mp4" }] } })],
    patch: [
      makeResponse({ json: { lockInfo: { token: "L" } } }), // lock
      makeResponse({ json: { lockInfo: { token: "L" } } }), // consume
      makeResponse({ json: { lockInfo: { progress: 100 } } }), // extend
      makeResponse({ json: {} }), // release
    ],
    put: [makeResponse({ json: {} })],
    get: [makeResponse({ json: { uploadProgressPercent: 100 } })],
  });
  const client = makeClient(f);
  const clock = new FakeClock();

  await uploadVideo(client, {
    filePath: p,
    name: "ignored",
    startTimeMs: 1,
    ttlMs: 1000,
    requestedChunkSize: 1024,
    deviceId: "{existing}",
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
  });

  const base = HOST + "/rest/v4/devices";
  const methodsUrls = f.calls.map((c) => `${c.method} ${c.url}`);
  // No create-virtual POST; first call is the create-upload POST.
  assert.equal(f.calls[0]!.method, "POST");
  assert.equal(f.calls[0]!.url, base + "/{existing}/virtual/uploads");
  assert.ok(!methodsUrls.includes("POST " + base + "/*/virtual"));
});

// ---------------------------------------------------------------------------
// Failure paths: cancel the upload, release only a lock we actually hold
// ---------------------------------------------------------------------------

test("failure before the lock cancels the upload and never locks", async () => {
  // Upload-status GET fails before any lock is acquired: cancel the upload,
  // but there is no lock token yet so release must NOT be called.
  const p = tmpFile("clip.mkv", Buffer.alloc(10, 0x7a));
  const f = recordingFetch({
    post: [
      makeResponse({ json: { id: "{dev-9}" } }),
      makeResponse({ json: { items: [{ uploadId: "clip.mkv" }] } }),
    ],
    put: [makeResponse({ json: {} })],
    get: [makeResponse({ status: 500, text: "status boom" })], // status GET FAILS
    delete: [makeResponse({ json: {} })],
  });
  const client = makeClient(f);

  await assert.rejects(
    () =>
      uploadVideo(client, {
        filePath: p,
        name: "Cam",
        startTimeMs: 1,
        ttlMs: 1000,
        requestedChunkSize: 1024,
      }),
    ApiError,
  );

  // lock/consume/extend/release were never reached.
  assert.ok(!f.calls.some((c) => c.method === "PATCH"));
  const deletes = f.calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0]!.url.endsWith("/uploads/clip.mkv"));
});

test("a consume timeout cancels the upload and still releases, cancel first", async () => {
  const p = tmpFile("clip.mkv", Buffer.alloc(10, 0x7a));
  const f = recordingFetch({
    post: [
      makeResponse({ json: { id: "{dev-9}" } }),
      makeResponse({ json: { items: [{ uploadId: "clip.mkv" }] } }),
    ],
    patch: [
      makeResponse({ json: { lockInfo: { token: "lock-9" } } }), // lock OK
      makeResponse({ json: { lockInfo: { token: "lock-9" } } }), // consume OK
      makeResponse({ json: { lockInfo: { progress: 10 } } }), // extend: stuck at 10%
      makeResponse({ json: {} }), // release
    ],
    put: [makeResponse({ json: {} })],
    get: [makeResponse({ json: { uploadProgressPercent: 100 } })],
    delete: [makeResponse({ json: {} })],
  });
  const client = makeClient(f);
  const clock = new FakeClock();

  await assert.rejects(
    () =>
      uploadVideo(client, {
        filePath: p,
        name: "Cam",
        startTimeMs: 1,
        ttlMs: 1000,
        requestedChunkSize: 1024,
        pollIntervalS: 2,
        consumeTimeoutS: 5,
        sleepFn: clock.sleepFn,
        nowFn: clock.nowFn,
      }),
    ApiError,
  );

  const base = HOST + "/rest/v4/devices";
  const deletes = f.calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0]!.url, base + "/{dev-9}/virtual/uploads/clip.mkv");

  const releases = f.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/release"));
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0]!.body, { token: "lock-9" });

  // Cancel happens before release.
  assert.ok(f.calls.indexOf(deletes[0]!) < f.calls.indexOf(releases[0]!));
});

test("an incomplete upload status throws before locking", async () => {
  // Server reports the raw upload itself is not fully received yet: fail fast
  // instead of locking/consuming a partial file.
  const p = tmpFile("clip.mkv", Buffer.alloc(10, 0x7a));
  const f = recordingFetch({
    post: [
      makeResponse({ json: { id: "{dev-9}" } }),
      makeResponse({ json: { items: [{ uploadId: "clip.mkv" }] } }),
    ],
    put: [makeResponse({ json: {} })],
    get: [makeResponse({ json: { uploadProgressPercent: 42 } })],
    delete: [makeResponse({ json: {} })],
  });
  const client = makeClient(f);

  await assert.rejects(
    () =>
      uploadVideo(client, {
        filePath: p,
        name: "Cam",
        startTimeMs: 1,
        ttlMs: 1000,
        requestedChunkSize: 1024,
      }),
    (err: unknown) =>
      err instanceof ApiError && err.message.includes("uploadProgressPercent=42"),
  );

  assert.ok(!f.calls.some((c) => c.method === "PATCH"));
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("config uses NX_SERVER_* vars (env beats file)", () => {
  const config = resolveConfig(
    { serverHost: null, user: null, password: null },
    { NX_SERVER_HOST: "https://file:7001" },
    { NX_SERVER_HOST: "https://env:7001" } as NodeJS.ProcessEnv,
  );
  assert.equal(config.host, "https://env:7001");
});

test("config CLI beats env", () => {
  const config = resolveConfig(
    { serverHost: "https://cli:7001", user: null, password: null },
    {},
    { NX_SERVER_HOST: "https://env:7001" } as NodeJS.ProcessEnv,
  );
  assert.equal(config.host, "https://cli:7001");
});
