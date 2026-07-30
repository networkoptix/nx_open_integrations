// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-media-client.mjs. No network, no account, no browser,
 * no real camera.
 *
 * Actual video playback CANNOT be unit-tested — it needs a real server and a
 * live camera (same caveat as the webrtc-live-view sample). What IS testable,
 * and what we cover here: building the same-origin media URL for both modes,
 * the login flows (with a fake fetch), the auth-error mapping, and the global
 * fetch receiver regression guard.
 *
 * Run from this folder:  node --test test_nx_media_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxMediaClient,
  resolveConfig,
  missingFields,
  parsePositionMs,
  MODE_DIRECT,
  MODE_CLOUD,
  AuthError,
  ApiError,
} from "./nx-media-client.mjs";

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

function fakeFetch({ post = null, del = null } = {}) {
  const calls = { post: null, deleteUrl: null, deleteCalls: 0 };
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST") {
      calls.post = { url, body: options.body ? JSON.parse(options.body) : null };
      return post;
    }
    if (method === "DELETE") {
      calls.deleteUrl = url;
      calls.deleteCalls += 1;
      return del;
    }
    return makeResponse({ json: {} });
  };
  impl.calls = calls;
  return impl;
}

const SITE = "11111111-2222-3333-4444-555555555555";
const DEVICE = "{cam-0001}";
const SERVER = "https://192.168.1.10:7001";
const SERVER_SEG = encodeURIComponent(SERVER); // first /server/ path segment

// ---------------------------------------------------------------------------
// login(): DIRECT mode
// ---------------------------------------------------------------------------

test("direct login posts to the user-provided /server/<encoded-base> login route with setCookie:false", async () => {
  const f = fakeFetch({ post: makeResponse({ json: { token: "tok-1" } }) });
  const client = new NxMediaClient({
    mode: MODE_DIRECT, serverAddress: SERVER, user: "admin", password: "pw", fetchImpl: f,
  });
  const token = await client.login();
  assert.equal(token, "tok-1");
  assert.equal(f.calls.post.url, `/server/${SERVER_SEG}/rest/v4/login/sessions`);
  assert.equal(f.calls.post.body.username, "admin");
  assert.equal(f.calls.post.body.setCookie, false);
});

test("direct login rejected raises AuthError", async () => {
  const f = fakeFetch({ post: makeResponse({ status: 401, text: "no" }) });
  const client = new NxMediaClient({
    mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f,
  });
  await assert.rejects(() => client.login(), AuthError);
});

test("direct login with no token raises ApiError", async () => {
  const f = fakeFetch({ post: makeResponse({ json: {} }) });
  const client = new NxMediaClient({
    mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f,
  });
  await assert.rejects(() => client.login(), ApiError);
});

// ---------------------------------------------------------------------------
// login(): CLOUD mode
// ---------------------------------------------------------------------------

test("cloud login posts to /cloud with the cloudSystemId scope", async () => {
  const f = fakeFetch({ post: makeResponse({ json: { access_token: "nxcdb-t" } }) });
  const client = new NxMediaClient({
    mode: MODE_CLOUD, user: "me@x.com", password: "pw", siteId: SITE, fetchImpl: f,
  });
  const token = await client.login();
  assert.equal(token, "nxcdb-t");
  assert.equal(f.calls.post.url, "/cloud/cdb/oauth2/token");
  assert.equal(f.calls.post.body.scope, `cloudSystemId=${SITE}`);
  assert.equal(f.calls.post.body.client_id, "3rdParty");
  assert.equal(f.calls.post.body.grant_type, "password");
});

test("cloud login adds the mfa code when provided", async () => {
  const f = fakeFetch({ post: makeResponse({ json: { access_token: "t" } }) });
  const client = new NxMediaClient({
    mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, mfaCode: "999111", fetchImpl: f,
  });
  await client.login();
  assert.equal(f.calls.post.body.mfaCode, "999111");
});

test("cloud login rejected raises AuthError", async () => {
  const f = fakeFetch({ post: makeResponse({ status: 403, text: "no" }) });
  const client = new NxMediaClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, fetchImpl: f });
  await assert.rejects(() => client.login(), AuthError);
});

// ---------------------------------------------------------------------------
// Regression guard: the default fetch must be called via the GLOBAL, not as a
// method of the client (else browsers throw "Can only call Window.fetch …").
// ---------------------------------------------------------------------------

test("default fetch is called via global (preserves receiver, no illegal invocation)", async () => {
  const original = globalThis.fetch;
  let calledThis = "unset";
  globalThis.fetch = function () {
    calledThis = this;
    return makeResponse({ json: { token: "t" } });
  };
  try {
    const client = new NxMediaClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p" }); // no fetchImpl
    await client.login();
    assert.notEqual(calledThis, client, "global fetch must not be invoked as a client method");
  } finally {
    globalThis.fetch = original;
  }
});

test("login wraps a network failure as ApiError pointing at the dev server", async () => {
  const f = async () => {
    throw new Error("Failed to fetch");
  };
  const client = new NxMediaClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  await assert.rejects(() => client.login(), (err) => err instanceof ApiError && /server\.mjs/.test(err.message));
});

// ---------------------------------------------------------------------------
// buildMediaUrl(): the heart of this sample — same-origin path, webm format,
// stream param, positionMs only for archive, auth=<token> always present.
// ---------------------------------------------------------------------------

function loggedIn(overrides = {}) {
  const client = new NxMediaClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", ...overrides });
  client.token = overrides.token || "tok-1";
  return client;
}

test("direct media URL: encoded user-provided base in /server path, media.webm, stream + auth", () => {
  const client = loggedIn();
  const url = client.buildMediaUrl({ deviceId: DEVICE, stream: "secondary" });
  const parsed = new URL(url, "http://x"); // relative -> resolve against a dummy base
  // The first /server/ segment is the URI-encoded user-provided server base.
  assert.equal(
    parsed.pathname,
    `/server/${SERVER_SEG}/rest/v4/devices/${encodeURIComponent(DEVICE)}/media.webm`,
  );
  // The raw URL string carries the encoded base segment verbatim.
  assert.ok(url.startsWith(`/server/${SERVER_SEG}/rest/v4/`), "encoded base must prefix the path");
  assert.equal(parsed.searchParams.get("stream"), "secondary");
  assert.equal(parsed.searchParams.get("auth"), "tok-1");
  assert.equal(parsed.searchParams.get("positionMs"), null, "no positionMs for live");
});

test("direct media URL: format is webm and positionMs rides for archive", () => {
  const client = loggedIn();
  const url = client.buildMediaUrl({ deviceId: "cam1", stream: "primary", positionMs: 1718452800000 });
  const parsed = new URL(url, "http://x");
  assert.ok(parsed.pathname.endsWith("/media.webm"), "format must be webm");
  assert.equal(parsed.searchParams.get("stream"), "primary");
  assert.equal(parsed.searchParams.get("positionMs"), "1718452800000");
  assert.equal(parsed.searchParams.get("auth"), "tok-1");
});

test("cloud media URL: same-origin /relay/<siteId> path, media.webm, stream + auth", () => {
  const client = new NxMediaClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE });
  client.token = "nxcdb-t";
  const url = client.buildMediaUrl({ deviceId: "cam1", stream: "primary" });
  const parsed = new URL(url, "http://x");
  assert.equal(parsed.pathname, `/relay/${SITE}/rest/v4/devices/cam1/media.webm`);
  assert.equal(parsed.searchParams.get("stream"), "primary");
  assert.equal(parsed.searchParams.get("auth"), "nxcdb-t");
});

test("archive media URL includes positionMs", () => {
  const client = loggedIn();
  const url = client.buildMediaUrl({ deviceId: "cam1", positionMs: 1718452800000 });
  const parsed = new URL(url, "http://x");
  assert.equal(parsed.searchParams.get("positionMs"), "1718452800000");
});

test("durationMs is included when given, omitted otherwise", () => {
  const client = loggedIn();
  const withDur = new URL(client.buildMediaUrl({ deviceId: "c", durationMs: 5000 }), "http://x");
  assert.equal(withDur.searchParams.get("durationMs"), "5000");
  const noDur = new URL(client.buildMediaUrl({ deviceId: "c" }), "http://x");
  assert.equal(noDur.searchParams.get("durationMs"), null);
});

test("buildMediaUrl without login raises ApiError", () => {
  const client = new NxMediaClient({ mode: MODE_DIRECT, user: "u", password: "p" });
  assert.throws(() => client.buildMediaUrl({ deviceId: "c" }), ApiError);
});

test("buildMediaUrl without a deviceId raises ApiError", () => {
  const client = loggedIn();
  assert.throws(() => client.buildMediaUrl({ deviceId: "" }), ApiError);
});

// ---------------------------------------------------------------------------
// logout() revokes against the right endpoint per mode
// ---------------------------------------------------------------------------

test("direct logout deletes the session token via /server/<encoded-base>", async () => {
  const f = fakeFetch({ del: makeResponse({ status: 204 }) });
  const client = new NxMediaClient({
    mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f,
  });
  client.token = "tok-1";
  await client.logout();
  assert.equal(f.calls.deleteUrl, `/server/${SERVER_SEG}/rest/v4/login/sessions/tok-1`);
  assert.equal(client.token, null);
});

test("cloud logout deletes the scoped token via /cloud", async () => {
  const f = fakeFetch({ del: makeResponse({ status: 204 }) });
  const client = new NxMediaClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, fetchImpl: f });
  client.token = "nxcdb-t";
  await client.logout();
  assert.equal(f.calls.deleteUrl, "/cloud/cdb/oauth2/token/nxcdb-t");
  assert.equal(client.token, null);
});

// ---------------------------------------------------------------------------
// parsePositionMs: ISO time, epoch ms, or blank=live
// ---------------------------------------------------------------------------

test("parsePositionMs returns null for blank (live)", () => {
  assert.equal(parsePositionMs(""), null);
  assert.equal(parsePositionMs("   "), null);
  assert.equal(parsePositionMs(null), null);
});

test("parsePositionMs passes through epoch ms", () => {
  assert.equal(parsePositionMs("1718452800000"), 1718452800000);
});

test("parsePositionMs parses an ISO time", () => {
  assert.equal(parsePositionMs("2024-06-15T12:00:00Z"), Date.parse("2024-06-15T12:00:00Z"));
});

test("parsePositionMs rejects junk", () => {
  assert.throws(() => parsePositionMs("not-a-time"), ApiError);
});

// ---------------------------------------------------------------------------
// config helpers
// ---------------------------------------------------------------------------

test("resolveConfig trims fields and defaults stream to secondary", () => {
  const c = resolveConfig({ mode: "cloud", user: "  me@x.com ", siteId: SITE, deviceId: " c1 " });
  assert.equal(c.mode, "cloud");
  assert.equal(c.user, "me@x.com");
  assert.equal(c.deviceId, "c1");
  assert.equal(c.stream, "secondary");
  assert.equal(c.mfaCode, null);
});

test("resolveConfig keeps primary stream when chosen", () => {
  assert.equal(resolveConfig({ stream: "primary" }).stream, "primary");
});

test("resolveConfig captures and trims the direct-mode server address", () => {
  const c = resolveConfig({ mode: "direct", serverAddress: "  https://192.168.1.10:7001 " });
  assert.equal(c.serverAddress, "https://192.168.1.10:7001");
});

test("missingFields: direct needs serverAddress/user/password/deviceId", () => {
  assert.deepEqual(
    missingFields(resolveConfig({ mode: "direct" })),
    ["serverAddress", "user", "password", "deviceId"],
  );
  assert.deepEqual(
    missingFields(
      resolveConfig({ mode: "direct", serverAddress: SERVER, user: "u", password: "p", deviceId: "c" }),
    ),
    [],
  );
});

test("missingFields: cloud also needs siteId", () => {
  assert.deepEqual(
    missingFields(resolveConfig({ mode: "cloud", user: "u", password: "p", deviceId: "c" })),
    ["siteId"],
  );
});
