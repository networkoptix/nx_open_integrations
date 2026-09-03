// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-virtual-camera-client.mjs. No network, no account, no
 * browser — a fake fetch records the calls and returns canned responses.
 *
 * These assert the v4 flow end-to-end:
 *   create -> create-upload (no lock, durationMs optional) -> PUT ?chunk=n
 *   (octet-stream) -> GET upload status -> lock -> consume -> extend(poll)
 *   -> release, plus the DELETE cancel-upload cleanup on failure.
 *
 * The extend-poll loop is driven by an injected fake clock, so nothing waits.
 *
 * Run from this folder:  node --test test_nx_virtual_camera_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxVirtualCameraClient,
  uploadVideo,
  waitForConsume,
  parseStartTimeMs,
  chunkPlan,
  md5OfBytes,
  buildItemsPayload,
  parseDeviceId,
  parseLockToken,
  parseLockProgress,
  parseUploadItem,
  parseUploadProgress,
  resolveConfig,
  missingFields,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_CONSUME_TIMEOUT_MS,
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

test("parseLockProgress reads lockInfo.progress (incl. a {reply} envelope)", () => {
  assert.equal(parseLockProgress({ id: "d1", lockInfo: { token: "t", progress: 42 } }), 42);
  assert.equal(parseLockProgress({ reply: { lockInfo: { progress: 7 } } }), 7);
  assert.equal(parseLockProgress({ lockInfo: { progress: 0 } }, 55), 0);
});

test("parseLockProgress: missing -> default (0 unless told otherwise)", () => {
  assert.equal(parseLockProgress({ id: "d1" }, 7), 7);
  assert.equal(parseLockProgress({}), 0);
  assert.equal(parseLockProgress({ lockInfo: {} }, 3), 3);
  assert.equal(parseLockProgress(null, 9), 9);
});

test("parseLockProgress: non-numeric -> default", () => {
  assert.equal(parseLockProgress({ lockInfo: { progress: "not-a-number" } }, 5), 5);
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

test("parseUploadProgress reads uploadProgressPercent", () => {
  assert.equal(parseUploadProgress({ uploadProgressPercent: 63 }), 63);
  assert.equal(parseUploadProgress({ reply: { uploadProgressPercent: 12 } }), 12);
  assert.equal(parseUploadProgress({ uploadProgressPercent: 0 }), 0);
});

test("parseUploadProgress: missing field defaults to 100 (chunk PUTs are synchronous)", () => {
  assert.equal(parseUploadProgress({}), 100);
  assert.equal(parseUploadProgress({ status: "importing" }), 100);
});

test("parseUploadProgress: non-numeric -> default", () => {
  assert.equal(parseUploadProgress({ uploadProgressPercent: "oops" }, 11), 11);
});

test("resolveConfig/missingFields cover serverHost + user + password", () => {
  const c = resolveConfig({ serverHost: " https://x:7001 ", user: " admin ", password: " pw " });
  assert.equal(c.serverHost, "https://x:7001");
  assert.equal(c.user, "admin");
  assert.deepEqual(missingFields(resolveConfig({})), ["serverHost", "user", "password"]);
  assert.deepEqual(missingFields(c), []);
});

test("poll-timing defaults are exported module constants (this house has no CLI)", () => {
  assert.equal(DEFAULT_POLL_INTERVAL_MS, 2000);
  assert.equal(DEFAULT_CONSUME_TIMEOUT_MS, 300000);
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
// Test doubles: a fake fetch that records the full call sequence, plus a fake
// clock so the extend-poll loop never actually waits.
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
 * Records every call; returns canned responses keyed by the step.
 * `extendProgress` is the queue of lockInfo.progress values the extend polls
 * report (the last one is reused if the loop asks for more).
 */
function recordingFetch({ extendProgress = [100], uploadProgressPercent = 100 } = {}) {
  const progressQueue = [...extendProgress];
  const calls = [];
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    const call = { url, method, headers: options.headers || {}, body: options.body };
    calls.push(call);

    if (method === "POST" && url.endsWith("/login/sessions")) {
      return makeResponse({ json: { token: "tok-1" } });
    }
    if (method === "DELETE" && url.includes("/login/sessions/")) {
      return makeResponse({ status: 204, json: {} });
    }
    if (method === "POST" && url.endsWith("/devices/*/virtual")) {
      return makeResponse({ json: { id: "dev-1" } });
    }
    if (method === "POST" && url.endsWith("/virtual/uploads")) {
      return makeResponse({ json: { items: [{ uploadId: "up-1", chunkSizeB: 4 }] } });
    }
    if (method === "PUT" && url.includes("/virtual/uploads/")) {
      return makeResponse({ status: 200, json: {} });
    }
    if (method === "GET" && url.includes("/virtual/uploads/")) {
      return makeResponse({ json: { uploadProgressPercent } });
    }
    if (method === "DELETE" && url.includes("/virtual/uploads/")) {
      return makeResponse({ status: 200, json: {} }); // cancel upload
    }
    if (method === "PATCH" && url.endsWith("/virtual/lock")) {
      return makeResponse({ json: { id: "dev-1", lockInfo: { token: "lock-1" } } });
    }
    if (method === "PATCH" && url.endsWith("/virtual/consume")) {
      return makeResponse({ json: { id: "dev-1", lockInfo: { token: "lock-1", progress: 0 } } });
    }
    if (method === "PATCH" && url.endsWith("/virtual/extend")) {
      const progress = progressQueue.length > 1 ? progressQueue.shift() : progressQueue[0];
      return makeResponse({ json: { id: "dev-1", lockInfo: { token: "lock-1", progress } } });
    }
    if (method === "PATCH" && url.endsWith("/virtual/release")) {
      return makeResponse({ json: { ok: true } });
    }
    throw new Error(`unexpected call ${method} ${url}`);
  };
  impl.calls = calls;
  return impl;
}

/** A controllable stand-in for Date.now()/sleep — nothing ever really waits. */
function fakeClock(start = 0) {
  const clock = { now: start, sleeps: [] };
  clock.nowFn = () => clock.now;
  clock.sleepFn = async (ms) => {
    clock.sleeps.push(ms);
    clock.now += ms;
  };
  return clock;
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

const BASE = `/server/${encodeURIComponent("https://192.168.1.10:7001")}/rest/v4`;

function makeClient(fetchImpl, serverHost = "https://192.168.1.10:7001") {
  return new NxVirtualCameraClient({ user: "admin", password: "pw", serverHost, fetchImpl });
}

// ---------------------------------------------------------------------------
// waitForConsume (the extend-poll loop)
// ---------------------------------------------------------------------------

test("waitForConsume polls extend until progress reaches 100", async () => {
  const f = recordingFetch({ extendProgress: [30, 70, 100] });
  const client = makeClient(f);
  await client.login();
  const clock = fakeClock();
  const seen = [];

  const progress = await waitForConsume(client, "dev-1", "lock-1", 60000, {
    pollIntervalMs: 2000,
    timeoutMs: 300000,
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    onProgress: (m) => seen.push(m),
  });

  assert.equal(progress, 100);

  const extends_ = f.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/virtual/extend"));
  assert.equal(extends_.length, 3);
  for (const call of extends_) {
    assert.deepEqual(JSON.parse(call.body), { ttlMs: 60000, token: "lock-1" });
  }
  assert.deepEqual(clock.sleeps, [2000, 2000, 2000]);
  assert.deepEqual(seen, [
    "Consume progress: 30%",
    "Consume progress: 70%",
    "Consume progress: 100%",
  ]);
});

test("waitForConsume throws when the timeout elapses before 100%", async () => {
  const f = recordingFetch({ extendProgress: [40] }); // stuck at 40%
  const client = makeClient(f);
  await client.login();
  const clock = fakeClock();

  await assert.rejects(
    () =>
      waitForConsume(client, "dev-1", "lock-1", 60000, {
        pollIntervalMs: 2000,
        timeoutMs: 5000,
        sleepFn: clock.sleepFn,
        nowFn: clock.nowFn,
      }),
    (exc) => {
      assert.ok(exc instanceof ApiError);
      assert.match(exc.message, /Consume did not reach 100% within 5s \(last progress: 40%\)\./);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Full happy-path orchestration: exact call sequence
// ---------------------------------------------------------------------------

test("FULL happy path: create -> create-upload -> PUT chunks -> status -> lock -> consume -> extend -> release", async () => {
  const f = recordingFetch({ extendProgress: [100] });
  const client = makeClient(f);
  await client.login();
  const clock = fakeClock();

  // 9 bytes with a server chunk size of 4 -> 3 chunks (4 + 4 + 1).
  const file = fakeFile("clip.mp4", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const notes = [];
  const result = await uploadVideo(client, file, {
    name: "Cam A",
    startTimeMs: 1700000000000,
    ttlMs: 60000,
    requestedChunkSize: 1024,
    durationMs: 30000,
    pollIntervalMs: 2000,
    consumeTimeoutMs: 300000,
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
    onProgress: (m) => notes.push(m),
  });

  const seq = f.calls.map((c) => `${c.method} ${c.url.replace(BASE, "")}`);

  // Exact ordered sequence of API steps: the file is uploaded BEFORE any lock.
  assert.deepEqual(seq, [
    "POST /login/sessions",
    "POST /devices/*/virtual",
    "POST /devices/dev-1/virtual/uploads",
    "PUT /devices/dev-1/virtual/uploads/up-1?chunk=0",
    "PUT /devices/dev-1/virtual/uploads/up-1?chunk=1",
    "PUT /devices/dev-1/virtual/uploads/up-1?chunk=2",
    "GET /devices/dev-1/virtual/uploads/up-1",
    "PATCH /devices/dev-1/virtual/lock",
    "PATCH /devices/dev-1/virtual/consume",
    "PATCH /devices/dev-1/virtual/extend",
    "PATCH /devices/dev-1/virtual/release",
  ]);

  // Nothing was cancelled on a clean run.
  assert.ok(!f.calls.some((c) => c.method === "DELETE"), "no cancel on the happy path");

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

  // The lock/consume/extend/release request bodies.
  const patchBody = (suffix) =>
    JSON.parse(f.calls.find((c) => c.method === "PATCH" && c.url.endsWith(suffix)).body);
  assert.deepEqual(patchBody("/virtual/lock"), { ttlMs: 60000 });
  assert.deepEqual(patchBody("/virtual/consume"), {
    token: "lock-1",
    uploadId: "up-1",
    startTimeMs: 1700000000000,
  });
  assert.deepEqual(patchBody("/virtual/extend"), { ttlMs: 60000, token: "lock-1" });
  assert.deepEqual(patchBody("/virtual/release"), { token: "lock-1" });

  // Consume progress is surfaced through the existing onProgress log.
  assert.ok(notes.includes("Consume progress: 100%"), "consume progress must be logged");

  // Result summary.
  assert.equal(result.deviceId, "dev-1");
  assert.equal(result.uploadId, "up-1");
  assert.equal(result.chunkCount, 3);
  assert.equal(result.chunkSizeB, 4);
  assert.equal(result.sizeB, 9);
  assert.equal(result.md5, md5Base64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])));
  assert.equal(result.consumeProgress, 100);
  assert.ok(!("status" in result), "the old `status` field is gone");
});

test("uploadVideo can target an existing device id (first call is create-upload)", async () => {
  const f = recordingFetch();
  const client = makeClient(f, "https://x:7001");
  await client.login();
  const clock = fakeClock();
  const file = fakeFile("c.mp4", "ab");

  await uploadVideo(client, file, {
    startTimeMs: 1,
    deviceId: "existing-7",
    requestedChunkSize: 1024,
    sleepFn: clock.sleepFn,
    nowFn: clock.nowFn,
  });

  assert.ok(!f.calls.some((c) => c.url.endsWith("/devices/*/virtual")), "must skip create when deviceId given");
  // First call after login is the create-upload POST.
  const afterLogin = f.calls.slice(1);
  assert.equal(afterLogin[0].method, "POST");
  assert.ok(afterLogin[0].url.endsWith("/devices/existing-7/virtual/uploads"));
  assert.ok(f.calls.some((c) => c.url.includes("/devices/existing-7/virtual/lock")));
});

// ---------------------------------------------------------------------------
// Failure paths: cancel the upload, release only a lock we actually hold
// ---------------------------------------------------------------------------

test("failure before the lock cancels the upload and never locks/releases", async () => {
  // The upload-status GET fails before any lock is acquired: cancel the upload,
  // but there is no lock token yet so release must NOT be called.
  const calls = [];
  const f = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    calls.push({ url, method, body: options.body });
    if (method === "POST" && url.endsWith("/login/sessions")) return makeResponse({ json: { token: "t" } });
    if (method === "POST" && url.endsWith("/devices/*/virtual")) return makeResponse({ json: { id: "dev-9" } });
    if (method === "POST" && url.endsWith("/virtual/uploads")) {
      return makeResponse({ json: { items: [{ uploadId: "up-9", chunkSizeB: 1024 }] } });
    }
    if (method === "PUT") return makeResponse({ json: {} });
    if (method === "GET") return makeResponse({ status: 500, text: "status boom" }); // FAILS
    if (method === "DELETE") return makeResponse({ json: {} });
    throw new Error(`unexpected call ${method} ${url}`);
  };
  const client = makeClient(f, "https://x:7001");
  await client.login();

  await assert.rejects(
    () => uploadVideo(client, fakeFile("clip.mkv", "zzzzzzzzzz"), { startTimeMs: 1, ttlMs: 1000 }),
    ApiError,
  );

  assert.ok(!calls.some((c) => c.method === "PATCH"), "lock/consume/extend/release must never be reached");
  const deletes = calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.ok(deletes[0].url.endsWith("/virtual/uploads/up-9"));
});

test("failure during consume cancels the upload AND still releases (cancel first)", async () => {
  // Consume never gets past 10%, so wait-for-consume times out after the lock
  // was acquired: expect one cancel DELETE and exactly one release, in that
  // order.
  const f = recordingFetch({ extendProgress: [10] });
  const client = makeClient(f);
  await client.login();
  const clock = fakeClock();

  await assert.rejects(
    () =>
      uploadVideo(client, fakeFile("clip.mkv", "zzzzzzzzzz"), {
        startTimeMs: 1,
        ttlMs: 1000,
        requestedChunkSize: 1024,
        pollIntervalMs: 2000,
        consumeTimeoutMs: 5000,
        sleepFn: clock.sleepFn,
        nowFn: clock.nowFn,
      }),
    ApiError,
  );

  const deletes = f.calls.filter((c) => c.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].url, `${BASE}/devices/dev-1/virtual/uploads/up-1`);

  const releases = f.calls.filter((c) => c.method === "PATCH" && c.url.endsWith("/virtual/release"));
  assert.equal(releases.length, 1);
  assert.deepEqual(JSON.parse(releases[0].body), { token: "lock-1" });

  // Cancel happens before release.
  assert.ok(f.calls.indexOf(deletes[0]) < f.calls.indexOf(releases[0]), "cancel must precede release");
});

test("an incomplete upload status throws before anything is locked", async () => {
  // The server reports the raw upload itself is not fully received: fail fast
  // instead of locking/consuming a partial file.
  const f = recordingFetch({ uploadProgressPercent: 42 });
  const client = makeClient(f);
  await client.login();

  await assert.rejects(
    () =>
      uploadVideo(client, fakeFile("clip.mkv", "zzzzzzzzzz"), {
        startTimeMs: 1,
        ttlMs: 1000,
        requestedChunkSize: 1024,
      }),
    (exc) => {
      assert.ok(exc instanceof ApiError);
      assert.equal(exc.message, "Upload did not complete: server reports uploadProgressPercent=42.");
      return true;
    },
  );

  assert.ok(!f.calls.some((c) => c.method === "PATCH"), "must not lock/consume a partial upload");
  assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 1, "the upload is cancelled");
});

test("a create-upload failure needs no cancel and no release", async () => {
  const calls = [];
  const f = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    calls.push({ url, method });
    if (method === "POST" && url.endsWith("/login/sessions")) return makeResponse({ json: { token: "t" } });
    if (method === "POST" && url.endsWith("/devices/*/virtual")) return makeResponse({ json: { id: "dev-1" } });
    if (method === "POST" && url.endsWith("/virtual/uploads")) return makeResponse({ status: 500, text: "boom" });
    throw new Error(`unexpected call ${method} ${url}`);
  };
  const client = makeClient(f, "https://x:7001");
  await client.login();

  await assert.rejects(() => uploadVideo(client, fakeFile("c.mp4", "abc"), { startTimeMs: 1 }), ApiError);
  assert.ok(!calls.some((c) => c.method === "DELETE"), "no upload exists yet, so nothing to cancel");
  assert.ok(!calls.some((c) => c.method === "PATCH"), "no lock was taken, so nothing to release");
});
