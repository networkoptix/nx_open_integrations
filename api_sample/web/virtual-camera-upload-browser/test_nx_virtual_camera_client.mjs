// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-virtual-camera-client.mjs. No network, no account, no
 * browser — a fake fetch records the calls and returns canned responses.
 *
 * These assert the CORRECTED v4 flow end-to-end:
 *   create -> lock -> create-upload (durationMs optional) -> PUT ?chunk=n
 *   (octet-stream) -> GET status (NO consume) -> release.
 *
 * Run from this folder:  node --test test_nx_virtual_camera_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxVirtualCameraClient,
  uploadVideo,
  parseStartTimeMs,
  chunkPlan,
  md5OfBytes,
  buildItemsPayload,
  parseDeviceId,
  parseLockToken,
  parseUploadItem,
  resolveConfig,
  missingFields,
  ApiError,
} from "./nx-virtual-camera-client.mjs";

import { md5Base64 } from "./md5.mjs";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("md5OfBytes matches the vendored md5 base64 (and a known vector)", () => {
  const bytes = new TextEncoder().encode("abc");
  assert.equal(md5OfBytes(bytes), md5Base64(bytes));
  assert.equal(md5OfBytes(new Uint8Array()), "1B2M2Y8AsgTpgAmY7PhCfg=="); // md5("")
});

test("parseStartTimeMs: blank -> now, ISO -> ms, raw epoch passes through", () => {
  const now = new Date("2026-06-16T00:00:00Z");
  assert.equal(parseStartTimeMs("", now), now.getTime());
  assert.equal(parseStartTimeMs("2026-06-15T12:00:00Z"), Date.parse("2026-06-15T12:00:00Z"));
  assert.equal(parseStartTimeMs("1700000000000"), 1700000000000);
  assert.throws(() => parseStartTimeMs("not-a-date"), ApiError);
});

test("chunkPlan splits evenly, holds the remainder, and yields one empty chunk for 0 bytes", () => {
  assert.deepEqual(chunkPlan(0, 10), [{ index: 0, offset: 0, length: 0 }]);
  assert.deepEqual(chunkPlan(10, 10), [{ index: 0, offset: 0, length: 10 }]);
  assert.deepEqual(chunkPlan(25, 10), [
    { index: 0, offset: 0, length: 10 },
    { index: 1, offset: 10, length: 10 },
    { index: 2, offset: 20, length: 5 },
  ]);
  assert.throws(() => chunkPlan(10, 0), ApiError);
});

test("buildItemsPayload has the 5 required fields and omits durationMs when not provided", () => {
  const body = buildItemsPayload("clip.mp4", 100, "md5==", 1700000000000, 1048576);
  assert.equal(body.items.length, 1);
  const item = body.items[0];
  assert.deepEqual(Object.keys(item).sort(), ["chunkSizeB", "filename", "md5", "sizeB", "startTimeMs"]);
  assert.equal(item.startTimeMs, 1700000000000);
  assert.ok(!("durationMs" in item), "must NOT send durationMs when omitted");
});

test("buildItemsPayload includes durationMs when provided", () => {
  const body = buildItemsPayload("clip.mp4", 100, "md5==", 1700000000000, 1048576, 30000);
  assert.equal(body.items[0].durationMs, 30000);
});

test("buildItemsPayload omits durationMs when zero or negative", () => {
  const body = buildItemsPayload("clip.mp4", 1, "md5==", 1, 1024, 0);
  assert.ok(!("durationMs" in body.items[0]));
});

test("parseDeviceId handles bare object, {reply}, and single-item list", () => {
  assert.equal(parseDeviceId({ id: "dev-1" }), "dev-1");
  assert.equal(parseDeviceId({ reply: { id: "dev-2" } }), "dev-2");
  assert.equal(parseDeviceId([{ id: "dev-3" }]), "dev-3");
  assert.throws(() => parseDeviceId({}), ApiError);
});

test("parseLockToken prefers lockInfo.token, falls back to top-level token", () => {
  assert.equal(parseLockToken({ id: "d", lockInfo: { token: "lock-1" } }), "lock-1");
  assert.equal(parseLockToken({ reply: { lockInfo: { token: "lock-2" } } }), "lock-2");
  assert.equal(parseLockToken({ token: "legacy" }), "legacy"); // defensive
  assert.throws(() => parseLockToken({ lockInfo: {} }), ApiError);
});

test("parseUploadItem reads server chunkSizeB/uploadId, else falls back", () => {
  assert.deepEqual(parseUploadItem({ items: [{ uploadId: "u1", chunkSizeB: 2048 }] }, 1024, "clip.mp4"), {
    uploadId: "u1",
    chunkSizeB: 2048,
  });
  // No echoed values -> fall back to requested chunk + filename.
  assert.deepEqual(parseUploadItem({ items: [{}] }, 1024, "clip.mp4"), {
    uploadId: "clip.mp4",
    chunkSizeB: 1024,
  });
  // Junk chunk size -> requested.
  assert.deepEqual(parseUploadItem({ items: [{ chunkSizeB: -5 }] }, 1024, "clip.mp4"), {
    uploadId: "clip.mp4",
    chunkSizeB: 1024,
  });
});

test("resolveConfig/missingFields cover serverHost + user + password", () => {
  const c = resolveConfig({ serverHost: " https://x:7001 ", user: " admin ", password: " pw " });
  assert.equal(c.serverHost, "https://x:7001");
  assert.equal(c.user, "admin");
  assert.deepEqual(missingFields(resolveConfig({})), ["serverHost", "user", "password"]);
  assert.deepEqual(missingFields(c), []);
});

// ---------------------------------------------------------------------------
// serverUrl encodes the user-typed server into the /server/<base> route
// ---------------------------------------------------------------------------

test("serverUrl URL-encodes the server address into the /server segment", () => {
  const client = new NxVirtualCameraClient({
    user: "u",
    password: "p",
    serverHost: "https://192.168.1.10:7001",
  });
  assert.equal(client.serverUrl, `/server/${encodeURIComponent("https://192.168.1.10:7001")}`);
});

// ---------------------------------------------------------------------------
// A fake fetch that records the full call sequence
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

/** Records every call; returns canned responses keyed by the step. */
function recordingFetch() {
  const calls = [];
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    const call = { url, method, headers: options.headers || {}, body: options.body };
    calls.push(call);

    if (method === "POST" && url.endsWith("/login/sessions")) {
      return makeResponse({ json: { token: "tok-1" } });
    }
    if (method === "POST" && url.endsWith("/devices/*/virtual")) {
      return makeResponse({ json: { id: "dev-1" } });
    }
    if (method === "PATCH" && url.endsWith("/virtual/lock")) {
      return makeResponse({ json: { id: "dev-1", lockInfo: { token: "lock-1" } } });
    }
    if (method === "POST" && url.endsWith("/virtual/uploads")) {
      return makeResponse({ json: { items: [{ uploadId: "up-1", chunkSizeB: 4 }] } });
    }
    if (method === "PUT" && url.includes("/virtual/uploads/")) {
      return makeResponse({ status: 200, json: {} });
    }
    if (method === "GET" && url.includes("/virtual/uploads/")) {
      return makeResponse({ json: { status: "importing" } });
    }
    if (method === "PATCH" && url.endsWith("/virtual/release")) {
      return makeResponse({ json: { ok: true } });
    }
    if (method === "DELETE") {
      return makeResponse({ status: 204, json: {} });
    }
    throw new Error(`unexpected call ${method} ${url}`);
  };
  impl.calls = calls;
  return impl;
}

/** A minimal stand-in for a browser File. */
function fakeFile(name, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  return {
    name,
    size: u8.length,
    async arrayBuffer() {
      return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    },
  };
}

test("FULL happy-path orchestration: create -> lock -> create-upload -> PUT chunks -> status -> release", async () => {
  const f = recordingFetch();
  const client = new NxVirtualCameraClient({
    user: "admin",
    password: "pw",
    serverHost: "https://192.168.1.10:7001",
    fetchImpl: f,
  });
  await client.login();

  // 9 bytes with a server chunk size of 4 -> 3 chunks (4 + 4 + 1).
  const file = fakeFile("clip.mp4", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const result = await uploadVideo(client, file, {
    name: "Cam A",
    startTimeMs: 1700000000000,
    ttlMs: 60000,
    requestedChunkSize: 1024,
    durationMs: 30000,
  });

  const base = `/server/${encodeURIComponent("https://192.168.1.10:7001")}/rest/v4`;
  const seq = f.calls.map((c) => `${c.method} ${c.url.replace(base, "")}`);

  // Exact ordered sequence of API steps.
  assert.deepEqual(seq, [
    "POST /login/sessions",
    "POST /devices/*/virtual",
    "PATCH /devices/dev-1/virtual/lock",
    "POST /devices/dev-1/virtual/uploads",
    "PUT /devices/dev-1/virtual/uploads/up-1?chunk=0",
    "PUT /devices/dev-1/virtual/uploads/up-1?chunk=1",
    "PUT /devices/dev-1/virtual/uploads/up-1?chunk=2",
    "GET /devices/dev-1/virtual/uploads/up-1",
    "PATCH /devices/dev-1/virtual/release",
  ]);

  // NO consume call anywhere.
  assert.ok(!f.calls.some((c) => c.url.includes("/virtual/consume")), "must NOT call /virtual/consume");

  // create-upload body: required fields, startTimeMs present, durationMs sent
  // because it was supplied.
  const createUpload = f.calls.find((c) => c.method === "POST" && c.url.endsWith("/virtual/uploads"));
  const body = JSON.parse(createUpload.body);
  assert.equal(body.items[0].startTimeMs, 1700000000000);
  assert.equal(body.items[0].durationMs, 30000);
  assert.equal(body.items[0].md5, md5Base64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])));

  // Chunk PUTs carry octet-stream + bearer; the body is the raw byte slice.
  const puts = f.calls.filter((c) => c.method === "PUT");
  assert.equal(puts.length, 3);
  for (const put of puts) {
    assert.equal(put.headers["Content-Type"], "application/octet-stream");
    assert.equal(put.headers.Authorization, "Bearer tok-1");
    assert.ok(put.body instanceof Uint8Array, "PUT body must be raw bytes");
  }
  assert.equal(puts[0].body.length, 4);
  assert.equal(puts[2].body.length, 1);

  // Release carries the lock token from lockInfo.token.
  const release = f.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/virtual/release"));
  assert.equal(JSON.parse(release.body).token, "lock-1");

  // Result summary.
  assert.equal(result.deviceId, "dev-1");
  assert.equal(result.uploadId, "up-1");
  assert.equal(result.chunkCount, 3);
  assert.equal(result.chunkSizeB, 4);
  assert.equal(result.sizeB, 9);
  assert.deepEqual(result.status, { status: "importing" });
});

test("uploadVideo always releases the lock even if create-upload fails", async () => {
  const calls = [];
  const f = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    calls.push({ url, method });
    if (url.endsWith("/login/sessions") && method === "POST") return makeResponse({ json: { token: "t" } });
    if (url.endsWith("/devices/*/virtual")) return makeResponse({ json: { id: "dev-1" } });
    if (url.endsWith("/virtual/lock")) return makeResponse({ json: { lockInfo: { token: "lock-9" } } });
    if (url.endsWith("/virtual/uploads") && method === "POST") return makeResponse({ status: 500, text: "boom" });
    if (url.endsWith("/virtual/release")) return makeResponse({ json: {} });
    return makeResponse({ status: 204, json: {} });
  };
  const client = new NxVirtualCameraClient({ user: "u", password: "p", serverHost: "https://x:7001", fetchImpl: f });
  await client.login();
  const file = fakeFile("c.mp4", "abc");
  await assert.rejects(() => uploadVideo(client, file, { startTimeMs: 1 }), ApiError);
  assert.ok(calls.some((c) => c.url.endsWith("/virtual/release")), "lock must be released on failure");
});

test("uploadVideo can target an existing device id (skips create)", async () => {
  const f = recordingFetch();
  const client = new NxVirtualCameraClient({ user: "u", password: "p", serverHost: "https://x:7001", fetchImpl: f });
  await client.login();
  const file = fakeFile("c.mp4", "ab");
  await uploadVideo(client, file, { startTimeMs: 1, deviceId: "existing-7", requestedChunkSize: 1024 });
  assert.ok(!f.calls.some((c) => c.url.endsWith("/devices/*/virtual")), "must skip create when deviceId given");
  assert.ok(f.calls.some((c) => c.url.includes("/devices/existing-7/virtual/lock")));
});
