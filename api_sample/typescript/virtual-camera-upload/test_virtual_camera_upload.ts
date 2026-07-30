// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for virtual_camera_upload.ts. No network, no server needed.
 *
 * Run from this folder:  node --test test_virtual_camera_upload.ts
 *
 * Node 22 strips the TypeScript types and runs the file directly — there is no
 * build step. These tests inject a fake fetch (the FetchImpl seam), write small
 * temp files for the hashing/chunking paths, and assert the exact request
 * sequence. They confirm the CORRECTED v4 flow: NO deprecated `consume` call,
 * and `durationMs` in the create-upload item only when the caller supplies it.
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
  parseStartTimeMs,
  fileMd5Base64,
  chunkPlan,
  buildItemsPayload,
  parseDeviceId,
  parseLockToken,
  parseUploadItem,
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
 * entry it reuses that response (handy for many PUTs).
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
// Full happy-path orchestration: exact call sequence (NO consume, NO durationMs)
// ---------------------------------------------------------------------------

test("full upload call sequence: create -> lock -> uploads -> PUT chunks -> GET status -> release", async () => {
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
      makeResponse({ json: {} }), // release
    ],
    put: [makeResponse({ json: {} })], // reused for every chunk
    get: [makeResponse({ json: { status: "consuming" } })], // upload status
  });
  const client = makeClient(f);

  const result = await uploadVideo(client, {
    filePath: p,
    name: "Cam",
    startTimeMs: 1700000000000,
    ttlMs: 300000,
    requestedChunkSize: 1048576,
    durationMs: 30000,
  });

  const base = HOST + "/rest/v4/devices";
  const methodsUrls = f.calls.map((c) => [c.method, c.url]);
  // No deprecated /virtual/consume call: status is read from the uploads
  // endpoint and the import auto-starts on completion.
  assert.deepEqual(methodsUrls, [
    ["POST", base + "/*/virtual"],
    ["PATCH", base + "/{dev-1}/virtual/lock"],
    ["POST", base + "/{dev-1}/virtual/uploads"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv?chunk=0"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv?chunk=1"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv?chunk=2"],
    ["GET", base + "/{dev-1}/virtual/uploads/clip.mkv"],
    ["PATCH", base + "/{dev-1}/virtual/release"],
  ]);

  // No consume call anywhere.
  assert.ok(!f.calls.some((c) => c.url.includes("/virtual/consume")), "must not call /virtual/consume");

  // Bodies on the way through.
  assert.deepEqual(f.calls[0]!.body, { name: "Cam" });
  assert.deepEqual(f.calls[1]!.body, { ttlMs: 300000 });
  assert.deepEqual(f.calls[2]!.body, {
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

  // Release carries the lockInfo.token.
  assert.deepEqual(f.calls[7]!.body, { token: "lock-1" });

  // Bearer attached to every authenticated call.
  assert.ok(f.calls.every((c) => c.headers!.Authorization === "Bearer tok"));

  assert.equal(result.deviceId, "{dev-1}");
  assert.equal(result.chunkCount, 3);
  assert.equal(result.chunkSizeB, 100);
  assert.deepEqual(result.status, { status: "consuming" });
});

test("existing device id skips the create step", async () => {
  const p = tmpFile("clip.mp4", Buffer.alloc(50, 0x79));
  const f = recordingFetch({
    post: [makeResponse({ json: { items: [{ uploadId: "clip.mp4" }] } })],
    patch: [makeResponse({ json: { token: "L" } }), makeResponse({ json: {} })],
    put: [makeResponse({ json: {} })],
    get: [makeResponse({ json: {} })],
  });
  const client = makeClient(f);

  await uploadVideo(client, {
    filePath: p,
    name: "ignored",
    startTimeMs: 1,
    ttlMs: 1000,
    requestedChunkSize: 1024,
    deviceId: "{existing}",
  });

  const base = HOST + "/rest/v4/devices";
  const methodsUrls = f.calls.map((c) => `${c.method} ${c.url}`);
  // No create-virtual POST; first call is the lock.
  assert.equal(f.calls[0]!.method, "PATCH");
  assert.equal(f.calls[0]!.url, base + "/{existing}/virtual/lock");
  assert.ok(!methodsUrls.includes("POST " + base + "/*/virtual"));
});

test("release is called even when a step fails", async () => {
  const p = tmpFile("clip.mkv", Buffer.alloc(10, 0x7a));
  const f = recordingFetch({
    post: [
      makeResponse({ json: { id: "{dev-9}" } }),
      makeResponse({ json: { items: [{ uploadId: "clip.mkv" }] } }),
    ],
    patch: [
      makeResponse({ json: { lockInfo: { token: "lock-9" } } }), // lock OK
      makeResponse({ json: {} }), // release still runs
    ],
    put: [makeResponse({ json: {} })],
    get: [makeResponse({ status: 500, text: "status boom" })], // status GET FAILS
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

  const base = HOST + "/rest/v4/devices";
  const releases = f.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/release"));
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.url, base + "/{dev-9}/virtual/release");
  assert.deepEqual(releases[0]!.body, { token: "lock-9" });
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
