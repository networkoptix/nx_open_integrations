// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for virtual_camera_upload.mjs. No network, no server needed.
 *
 * Run from this folder:  node --test test_virtual_camera_upload.mjs
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NxVirtualCameraClient,
  AuthError,
  ApiError,
  parseStartTimeMs,
  fileMd5Base64,
  chunkPlan,
  iterFileChunks,
  buildItemsPayload,
  parseDeviceId,
  parseLockToken,
  parseUploadItem,
  resolveConfig,
  uploadVideo,
} from "./virtual_camera_upload.mjs";

const HOST = "https://srv:7001";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeResponse({ status = 200, json = null, text = "" } = {}) {
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
  };
}

/**
 * Records the ordered sequence of calls and serves queued responses. Each verb
 * (POST/PATCH/PUT/GET/DELETE) pops from its own queue (or reuses the last one
 * when the queue runs dry — handy for many PUTs). Every call is appended to
 * `calls` so a test can assert the exact method + URL + body sequence.
 */
function recordingFetch({ post = [], patch = [], put = [], get = [], del = [] } = {}) {
  const queues = {
    POST: [...post],
    PATCH: [...patch],
    PUT: [...put],
    GET: [...get],
    DELETE: [...del],
  };
  const calls = [];
  const next = (verb) => {
    const q = queues[verb];
    if (!q || q.length === 0) return makeResponse({ json: {} });
    return q.length > 1 ? q.shift() : q[0];
  };
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    // Split the ?chunk=n query into a params object for PUT, like requests did.
    const qIndex = url.indexOf("?");
    let params = null;
    if (qIndex !== -1) {
      params = {};
      for (const [k, v] of new URLSearchParams(url.slice(qIndex + 1))) {
        params[k] = /^\d+$/.test(v) ? Number(v) : v;
      }
    }
    const call = {
      method,
      url: qIndex === -1 ? url : url.slice(0, qIndex),
      params,
      headers: options.headers || {},
      json: typeof options.body === "string" ? JSON.parse(options.body) : null,
      body: options.body,
    };
    calls.push(call);
    return next(method);
  };
  impl.calls = calls;
  return impl;
}

function makeClient(fetchOpts = {}) {
  const f = recordingFetch(fetchOpts);
  const client = new NxVirtualCameraClient(HOST, "admin", "pw", { fetchImpl: f });
  client.token = "tok";
  return { client, f };
}

function tmpFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nxvc-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

// ---------------------------------------------------------------------------
// fileMd5Base64
// ---------------------------------------------------------------------------

test("fileMd5Base64 matches a known base64 MD5", () => {
  const data = Buffer.from("hello virtual camera".repeat(100));
  const p = tmpFile("clip.mkv", data);
  const expected = createHash("md5").update(data).digest("base64");
  assert.equal(fileMd5Base64(p), expected);
});

// ---------------------------------------------------------------------------
// chunkPlan
// ---------------------------------------------------------------------------

test("chunkPlan: partial last chunk", () => {
  assert.deepEqual(chunkPlan(250, 100), [
    { index: 0, offset: 0, length: 100 },
    { index: 1, offset: 100, length: 100 },
    { index: 2, offset: 200, length: 50 },
  ]);
});

test("chunkPlan: exact multiple", () => {
  assert.deepEqual(chunkPlan(300, 100), [
    { index: 0, offset: 0, length: 100 },
    { index: 1, offset: 100, length: 100 },
    { index: 2, offset: 200, length: 100 },
  ]);
});

test("chunkPlan: smaller than one chunk", () => {
  assert.deepEqual(chunkPlan(40, 100), [{ index: 0, offset: 0, length: 40 }]);
});

test("chunkPlan: zero-byte file is one empty chunk", () => {
  assert.deepEqual(chunkPlan(0, 100), [{ index: 0, offset: 0, length: 0 }]);
});

test("chunkPlan: rejects non-positive chunk size", () => {
  assert.throws(() => chunkPlan(100, 0), ApiError);
});

test("iterFileChunks reads the file back exactly", () => {
  const data = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]); // 512 bytes
  const p = tmpFile("clip.bin", data);
  const chunks = [...iterFileChunks(p, 200)];
  assert.deepEqual(chunks.map((c) => c.index), [0, 1, 2]);
  assert.deepEqual(chunks.map((c) => c.bytes.length), [200, 200, 112]);
  assert.ok(Buffer.concat(chunks.map((c) => c.bytes)).equals(data));
});

// ---------------------------------------------------------------------------
// parseStartTimeMs
// ---------------------------------------------------------------------------

test("parseStartTimeMs: epoch ms passthrough", () => {
  assert.equal(parseStartTimeMs("1700000000000"), 1700000000000);
});

test("parseStartTimeMs: ISO UTC", () => {
  assert.equal(parseStartTimeMs("2021-01-01T00:00:00Z"), 1609459200000);
});

test("parseStartTimeMs: blank defaults to provided now", () => {
  assert.equal(parseStartTimeMs("", 1750000000000), 1750000000000);
});

test("parseStartTimeMs: bad value raises ApiError", () => {
  assert.throws(() => parseStartTimeMs("not-a-time"), ApiError);
});

// ---------------------------------------------------------------------------
// buildItemsPayload  (durationMs optional)
// ---------------------------------------------------------------------------

test("buildItemsPayload has filename/sizeB/md5/startTimeMs/chunkSizeB and omits durationMs when not provided", () => {
  const body = buildItemsPayload("clip.mkv", 1234, "bWQ1", 1700000000000, 1048576);
  assert.deepEqual(body, {
    items: [
      { filename: "clip.mkv", sizeB: 1234, md5: "bWQ1", startTimeMs: 1700000000000, chunkSizeB: 1048576 },
    ],
  });
  assert.ok(!("durationMs" in body.items[0]), "durationMs must NOT be present when omitted");
});

test("buildItemsPayload includes durationMs when provided", () => {
  const body = buildItemsPayload("clip.mkv", 1234, "bWQ1", 1700000000000, 1048576, 30000);
  assert.equal(body.items[0].durationMs, 30000);
});

test("buildItemsPayload omits durationMs when zero or negative", () => {
  const body = buildItemsPayload("clip.mkv", 1, "bWQ1", 1, 1024, 0);
  assert.ok(!("durationMs" in body.items[0]));
});

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

test("parseDeviceId: bare object / reply envelope / single-item list", () => {
  assert.equal(parseDeviceId({ id: "{dev-1}", name: "x" }), "{dev-1}");
  assert.equal(parseDeviceId({ reply: { id: "{dev-2}" } }), "{dev-2}");
  assert.equal(parseDeviceId([{ id: "{dev-3}" }]), "{dev-3}");
});

test("parseDeviceId: missing id raises", () => {
  assert.throws(() => parseDeviceId({ name: "no id" }), ApiError);
});

test("parseLockToken: token lives at lockInfo.token (real v4 shape)", () => {
  assert.equal(parseLockToken({ id: "d1", lockInfo: { token: "lock-abc" } }), "lock-abc");
  assert.equal(parseLockToken({ reply: { lockInfo: { token: "lock-rep" } } }), "lock-rep");
  // Fallbacks for a top-level token.
  assert.equal(parseLockToken({ token: "lock-xyz" }), "lock-xyz");
  assert.equal(parseLockToken({ reply: { token: "lock-env" } }), "lock-env");
});

test("parseLockToken: missing token raises", () => {
  assert.throws(() => parseLockToken({ nope: 1 }), ApiError);
});

test("parseUploadItem: uses server chunkSizeB + uploadId", () => {
  const { uploadId, chunkSizeB } = parseUploadItem(
    { items: [{ uploadId: "clip.mkv", chunkSizeB: 4096 }] },
    1048576,
    "clip.mkv",
  );
  assert.equal(uploadId, "clip.mkv");
  assert.equal(chunkSizeB, 4096);
});

test("parseUploadItem: falls back to requested chunk size + filename", () => {
  const { uploadId, chunkSizeB } = parseUploadItem({ items: [{ filename: "clip.mkv" }] }, 2048, "clip.mkv");
  assert.equal(uploadId, "clip.mkv");
  assert.equal(chunkSizeB, 2048);
});

test("parseUploadItem: bare list response", () => {
  const { uploadId, chunkSizeB } = parseUploadItem([{ uploadId: "clip.mkv", chunkSizeB: 512 }], 2048, "clip.mkv");
  assert.equal(uploadId, "clip.mkv");
  assert.equal(chunkSizeB, 512);
});

test("parseUploadItem: invalid chunkSizeB falls back", () => {
  const { chunkSizeB } = parseUploadItem({ items: [{ chunkSizeB: "garbage" }] }, 999, "clip.mkv");
  assert.equal(chunkSizeB, 999);
});

// ---------------------------------------------------------------------------
// Client: login
// ---------------------------------------------------------------------------

test("login posts credentials and stores the token", async () => {
  const f = recordingFetch({ post: [makeResponse({ json: { token: "abc123" } })] });
  const client = new NxVirtualCameraClient(HOST, "admin", "pw", { fetchImpl: f });
  const token = await client.login();
  assert.equal(token, "abc123");
  assert.equal(f.calls[0].url, HOST + "/rest/v4/login/sessions");
  assert.deepEqual(f.calls[0].json, { username: "admin", password: "pw", setCookie: false });
});

test("login unauthorized raises AuthError", async () => {
  const f = recordingFetch({ post: [makeResponse({ status: 401, text: "bad" })] });
  const client = new NxVirtualCameraClient(HOST, "admin", "pw", { fetchImpl: f });
  await assert.rejects(() => client.login(), AuthError);
});

// ---------------------------------------------------------------------------
// Full happy-path orchestration: exact call sequence (NO consume PATCH)
// ---------------------------------------------------------------------------

test("full upload call sequence: create -> lock -> create-upload -> PUT*3 -> GET status -> release", async () => {
  const chunk = 100;
  const data = Buffer.alloc(250, 0x78); // 250 bytes of 'x' -> 2.5 chunks
  const p = tmpFile("clip.mkv", data);
  const md5B64 = createHash("md5").update(data).digest("base64");

  const { client, f } = makeClient({
    post: [
      makeResponse({ json: { id: "{dev-1}" } }), // create virtual
      makeResponse({ json: { items: [{ uploadId: "clip.mkv", chunkSizeB: chunk }] } }), // create upload
    ],
    patch: [
      makeResponse({ json: { lockInfo: { token: "lock-1" } } }), // lock
      makeResponse({ json: {} }), // release
    ],
    put: [makeResponse({ json: {} })], // reused for every chunk
    get: [makeResponse({ json: { status: "consuming" } })], // upload status
  });

  const result = await uploadVideo(client, p, {
    name: "Cam",
    startTimeMs: 1700000000000,
    ttlMs: 300000,
    requestedChunkSize: 1048576,
    durationMs: 30000,
  });

  const base = HOST + "/rest/v4/devices";
  const methodsUrls = f.calls.map((c) => [c.method, c.url]);
  // No deprecated /virtual/consume call: status is read from the uploads
  // endpoint via GET and the import auto-starts on completion.
  assert.deepEqual(methodsUrls, [
    ["POST", base + "/*/virtual"],
    ["PATCH", base + "/{dev-1}/virtual/lock"],
    ["POST", base + "/{dev-1}/virtual/uploads"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv"],
    ["PUT", base + "/{dev-1}/virtual/uploads/clip.mkv"],
    ["GET", base + "/{dev-1}/virtual/uploads/clip.mkv"],
    ["PATCH", base + "/{dev-1}/virtual/release"],
  ]);

  // No consume anywhere.
  assert.equal(f.calls.filter((c) => c.url.endsWith("/virtual/consume")).length, 0);

  // Bodies / params on the way through.
  assert.deepEqual(f.calls[0].json, { name: "Cam" });
  assert.deepEqual(f.calls[1].json, { ttlMs: 300000 });
  assert.deepEqual(f.calls[2].json, {
    items: [{
      filename: "clip.mkv", sizeB: 250, md5: md5B64, startTimeMs: 1700000000000,
      chunkSizeB: 1048576, durationMs: 30000,
    }],
  });

  const puts = f.calls.filter((c) => c.method === "PUT");
  assert.deepEqual(
    puts.map((p2) => p2.params),
    [{ chunk: 0 }, { chunk: 1 }, { chunk: 2 }],
  );
  assert.deepEqual(
    puts.map((p2) => Buffer.from(p2.body).length),
    [100, 100, 50],
  );
  assert.ok(puts.every((p2) => p2.headers["Content-Type"] === "application/octet-stream"));

  const release = f.calls[7];
  assert.deepEqual(release.json, { token: "lock-1" });

  // Bearer attached to every authenticated call.
  assert.ok(f.calls.every((c) => c.headers.Authorization === "Bearer tok"));

  assert.equal(result.deviceId, "{dev-1}");
  assert.equal(result.chunkCount, 3);
  assert.equal(result.chunkSizeB, 100);
  assert.deepEqual(result.status, { status: "consuming" });
});

test("existing device id skips the create POST", async () => {
  const p = tmpFile("clip.mp4", Buffer.alloc(50, 0x79));
  const { client, f } = makeClient({
    post: [makeResponse({ json: { items: [{ uploadId: "clip.mp4" }] } })], // create upload only
    patch: [makeResponse({ json: { token: "L" } }), makeResponse({ json: {} })],
    put: [makeResponse({ json: {} })],
    get: [makeResponse({ json: {} })],
  });

  await uploadVideo(client, p, {
    name: "ignored",
    startTimeMs: 1,
    ttlMs: 1000,
    requestedChunkSize: 1024,
    deviceId: "{existing}",
  });

  const base = HOST + "/rest/v4/devices";
  const methodsUrls = f.calls.map((c) => [c.method, c.url]);
  // First call is the lock; no create-virtual POST.
  assert.deepEqual(methodsUrls[0], ["PATCH", base + "/{existing}/virtual/lock"]);
  assert.equal(f.calls.filter((c) => c.method === "POST" && c.url === base + "/*/virtual").length, 0);
});

test("release runs even when the status GET fails", async () => {
  const p = tmpFile("clip.mkv", Buffer.alloc(10, 0x7a));
  const { client, f } = makeClient({
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

  await assert.rejects(
    () => uploadVideo(client, p, { name: "Cam", startTimeMs: 1, ttlMs: 1000, requestedChunkSize: 1024 }),
    ApiError,
  );

  const base = HOST + "/rest/v4/devices";
  const releases = f.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/release"));
  assert.equal(releases.length, 1);
  assert.equal(releases[0].url, base + "/{dev-9}/virtual/release");
  assert.deepEqual(releases[0].json, { token: "lock-9" });
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("config uses the NX_SERVER_* vars (env beats file)", () => {
  const config = resolveConfig(
    { host: null, user: null, password: null },
    { NX_SERVER_HOST: "https://file:7001" },
    { NX_SERVER_HOST: "https://env:7001" },
  );
  assert.equal(config.host, "https://env:7001");
});

test("config: CLI beats env", () => {
  const config = resolveConfig(
    { host: "https://cli:7001", user: null, password: null },
    {},
    { NX_SERVER_HOST: "https://env:7001" },
  );
  assert.equal(config.host, "https://cli:7001");
});
