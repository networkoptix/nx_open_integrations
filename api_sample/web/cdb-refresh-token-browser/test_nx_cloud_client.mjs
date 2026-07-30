// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-cloud-client.mjs. No network, no account, no browser.
 *
 * The page-wiring (app.mjs) only touches the DOM, so the API + session logic
 * lives in nx-cloud-client.mjs and is tested here with a fake fetch — same
 * approach as the Node samples.
 *
 * sessionStorage does NOT exist under node:test, so we INJECT a tiny in-memory
 * storage object (memStorage) wherever persistence/resume is under test, and a
 * deterministic time function (so expiry logic is testable without a clock).
 * resolveStorage() also feature-detects: with nothing injected it falls back to
 * a no-op, so the client never throws for a missing sessionStorage.
 *
 * Run from this folder:  node --test test_nx_cloud_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TokenSession,
  buildPasswordRequest,
  buildRefreshRequest,
  resolveStorage,
  resolveConfig,
  missingFields,
  shortToken,
  formatExpiry,
  AuthError,
  ApiError,
  STORAGE_KEY,
  REFRESH_SAFETY_MARGIN_S,
  DEFAULT_EXPIRES_IN_S,
} from "./nx-cloud-client.mjs";

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

/** Fake fetch that records POST bodies and returns queued responses in order. */
function fakeFetch(responses = []) {
  const queue = [...responses];
  const calls = { posts: [] };
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST") {
      calls.posts.push({ url, body: options.body ? JSON.parse(options.body) : null });
    }
    if (!queue.length) throw new Error("fakeFetch: no more queued responses");
    return queue.shift();
  };
  impl.calls = calls;
  return impl;
}

/** A minimal in-memory Storage-like object to stand in for sessionStorage. */
function memStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

// A clock we can advance by reassigning `now`.
function clock(start = 1000) {
  const state = { now: start };
  const fn = () => state.now;
  return { fn, state };
}

function makeSession(responses = [], overrides = {}) {
  const f = fakeFetch(responses);
  const storage = overrides.storage || memStorage();
  const c = overrides.clock || clock();
  const session = new TokenSession({
    fetchImpl: f,
    storage,
    timeFn: overrides.timeFn || c.fn,
    ...overrides,
  });
  return { session, f, storage, clock: c };
}

// ---------------------------------------------------------------------------
// Request bodies — exact payloads (login vs refresh)
// ---------------------------------------------------------------------------

test("buildPasswordRequest carries the password grant + 3rdParty client", () => {
  const body = buildPasswordRequest("me@x.com", "pw");
  assert.equal(body.grant_type, "password");
  assert.equal(body.response_type, "token");
  assert.equal(body.client_id, "3rdParty");
  assert.equal(body.username, "me@x.com");
  assert.equal(body.password, "pw");
  assert.ok(!("mfaCode" in body));
});

test("buildPasswordRequest adds the mfa code only when provided", () => {
  assert.equal(buildPasswordRequest("u", "p", "123456").mfaCode, "123456");
});

test("buildRefreshRequest uses the refresh grant and NO password", () => {
  const body = buildRefreshRequest("rt-1");
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.client_id, "3rdParty");
  assert.equal(body.refresh_token, "rt-1");
  assert.ok(!("password" in body) && !("username" in body));
});

// ---------------------------------------------------------------------------
// login(): posts to /cloud, absorbs tokens + expiry, persists
// ---------------------------------------------------------------------------

test("login posts to the same-origin /cloud route and stores both tokens", async () => {
  const { session, f, storage, clock: c } = makeSession([
    makeResponse({ json: { access_token: "nxcdb-a", refresh_token: "rt-1", expires_in: 3600 } }),
  ]);
  await session.login("me@x.com", "pw");
  assert.equal(f.calls.posts[0].url, "/cloud/cdb/oauth2/token");
  assert.equal(f.calls.posts[0].body.grant_type, "password");
  assert.equal(session.accessToken, "nxcdb-a");
  assert.equal(session.refreshToken, "rt-1");
  assert.equal(session.expiresAt, c.state.now + 3600);
  // Persisted to storage for resume.
  const saved = JSON.parse(storage.getItem(STORAGE_KEY));
  assert.equal(saved.refreshToken, "rt-1");
});

test("login defaults expiry when the server omits expires_in", async () => {
  const { session, clock: c } = makeSession([
    makeResponse({ json: { access_token: "a", refresh_token: "r" } }),
  ]);
  await session.login("u", "p");
  assert.equal(session.expiresAt, c.state.now + DEFAULT_EXPIRES_IN_S);
});

test("login rejected raises AuthError", async () => {
  const { session } = makeSession([makeResponse({ status: 403, text: "no" })]);
  await assert.rejects(() => session.login("u", "p"), AuthError);
});

test("login wraps a network failure as ApiError pointing at the dev server", async () => {
  const f = async () => {
    throw new Error("Failed to fetch");
  };
  const session = new TokenSession({ fetchImpl: f, storage: memStorage() });
  await assert.rejects(
    () => session.login("u", "p"),
    (err) => err instanceof ApiError && /server\.mjs/.test(err.message),
  );
});

test("a token response without access_token raises ApiError", async () => {
  const { session } = makeSession([makeResponse({ json: { refresh_token: "r" } })]);
  await assert.rejects(() => session.login("u", "p"), ApiError);
});

test("default fetch is called via global (preserves receiver, no illegal invocation)", async () => {
  // Regression guard for "Can only call Window.fetch on instances of Window":
  // the client must call the GLOBAL fetch, not invoke it as its own method.
  const original = globalThis.fetch;
  let calledThis = "unset";
  globalThis.fetch = function () {
    calledThis = this;
    return makeResponse({ json: { access_token: "a", refresh_token: "r" } });
  };
  try {
    const session = new TokenSession({ storage: memStorage() }); // no fetchImpl
    await session.login("u", "p");
    assert.notEqual(calledThis, session, "global fetch must not be invoked as a session method");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// refresh(): refresh grant, NO password, adopts rotated refresh token
// ---------------------------------------------------------------------------

test("refresh posts the refresh grant with the stored token and no password", async () => {
  const { session, f } = makeSession([
    makeResponse({ json: { access_token: "a1", refresh_token: "rt-1", expires_in: 3600 } }),
    makeResponse({ json: { access_token: "a2", refresh_token: "rt-2", expires_in: 3600 } }),
  ]);
  await session.login("u", "p");
  await session.refresh();
  const refreshCall = f.calls.posts[1];
  assert.equal(refreshCall.body.grant_type, "refresh_token");
  assert.equal(refreshCall.body.refresh_token, "rt-1");
  assert.ok(!("password" in refreshCall.body));
});

test("refresh adopts a ROTATED refresh token", async () => {
  const { session } = makeSession([
    makeResponse({ json: { access_token: "a1", refresh_token: "rt-1", expires_in: 3600 } }),
    makeResponse({ json: { access_token: "a2", refresh_token: "rt-2", expires_in: 3600 } }),
  ]);
  await session.login("u", "p");
  await session.refresh();
  assert.equal(session.accessToken, "a2");
  assert.equal(session.refreshToken, "rt-2");
});

test("refresh keeps the old refresh token when the server doesn't rotate", async () => {
  const { session } = makeSession([
    makeResponse({ json: { access_token: "a1", refresh_token: "rt-1", expires_in: 3600 } }),
    makeResponse({ json: { access_token: "a2", expires_in: 3600 } }), // no refresh_token
  ]);
  await session.login("u", "p");
  await session.refresh();
  assert.equal(session.refreshToken, "rt-1");
});

test("refresh without a refresh token raises ApiError", async () => {
  const { session } = makeSession();
  await assert.rejects(() => session.refresh(), ApiError);
});

test("a rejected refresh raises AuthError", async () => {
  const { session } = makeSession([
    makeResponse({ json: { access_token: "a1", refresh_token: "rt-1", expires_in: 3600 } }),
    makeResponse({ status: 401, text: "bad refresh" }),
  ]);
  await session.login("u", "p");
  await assert.rejects(() => session.refresh(), AuthError);
});

// ---------------------------------------------------------------------------
// Expiry / proactive refresh logic — driven by the injected clock
// ---------------------------------------------------------------------------

test("isExpiring respects the safety margin", async () => {
  const { session, clock: c } = makeSession([
    makeResponse({ json: { access_token: "a", refresh_token: "r", expires_in: 3600 } }),
  ]);
  await session.login("u", "p");
  assert.equal(session.isExpiring(), false);
  // Jump to within the safety margin of expiry.
  c.state.now += 3600 - (REFRESH_SAFETY_MARGIN_S - 1);
  assert.equal(session.isExpiring(), true);
});

test("ensureValid refreshes PROACTIVELY when the token is near expiry", async () => {
  const { session, f, clock: c } = makeSession([
    makeResponse({ json: { access_token: "a1", refresh_token: "rt-1", expires_in: 3600 } }),
    makeResponse({ json: { access_token: "a2", refresh_token: "rt-2", expires_in: 3600 } }),
  ]);
  await session.login("u", "p");
  c.state.now += 3600; // token now expired
  const token = await session.ensureValid();
  assert.equal(token, "a2");
  assert.equal(f.calls.posts.length, 2); // a refresh happened
});

test("ensureValid does NOT refresh when the token is fresh", async () => {
  const { session, f } = makeSession([
    makeResponse({ json: { access_token: "a1", refresh_token: "rt-1", expires_in: 3600 } }),
  ]);
  await session.login("u", "p");
  const token = await session.ensureValid();
  assert.equal(token, "a1");
  assert.equal(f.calls.posts.length, 1); // no extra POST
});

test("ensureValid without any session raises ApiError", async () => {
  const { session } = makeSession();
  await assert.rejects(() => session.ensureValid(), ApiError);
});

// ---------------------------------------------------------------------------
// Storage: resume on construction, clear, feature-detection fallback
// ---------------------------------------------------------------------------

test("a new session RESUMES tokens saved in storage (no login needed)", async () => {
  const seed = {
    [STORAGE_KEY]: JSON.stringify({ accessToken: "a", refreshToken: "rt-saved", expiresAt: 9999 }),
  };
  const storage = memStorage(seed);
  const session = new TokenSession({ storage, fetchImpl: fakeFetch() });
  assert.equal(session.hasSession(), true);
  assert.equal(session.refreshToken, "rt-saved");
});

test("a resumed session can refresh WITHOUT a password", async () => {
  const seed = {
    [STORAGE_KEY]: JSON.stringify({ accessToken: "a", refreshToken: "rt-saved", expiresAt: 1 }),
  };
  const storage = memStorage(seed);
  const f = fakeFetch([
    makeResponse({ json: { access_token: "a-new", refresh_token: "rt-new", expires_in: 3600 } }),
  ]);
  const session = new TokenSession({ storage, fetchImpl: f, timeFn: () => 0 });
  await session.refresh();
  assert.equal(session.accessToken, "a-new");
  assert.equal(f.calls.posts[0].body.refresh_token, "rt-saved");
});

test("clear() forgets the session in memory AND storage", async () => {
  const { session, storage } = makeSession([
    makeResponse({ json: { access_token: "a", refresh_token: "r", expires_in: 3600 } }),
  ]);
  await session.login("u", "p");
  assert.equal(session.hasSession(), true);
  session.clear();
  assert.equal(session.hasSession(), false);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("resolveStorage falls back to a safe no-op when sessionStorage is absent", () => {
  // Under node:test there is no globalThis.sessionStorage; the fallback must be
  // a working Storage-like object so the client never throws.
  assert.equal(globalThis.sessionStorage, undefined);
  const store = resolveStorage();
  assert.equal(store.getItem("anything"), null);
  store.setItem("k", "v"); // must not throw
  store.removeItem("k"); // must not throw
});

test("invalid JSON in storage is ignored (start fresh, no throw)", () => {
  const storage = memStorage({ [STORAGE_KEY]: "{not json" });
  const session = new TokenSession({ storage, fetchImpl: fakeFetch() });
  assert.equal(session.hasSession(), false);
});

// ---------------------------------------------------------------------------
// Display + config helpers
// ---------------------------------------------------------------------------

test("shortToken truncates long tokens and passes short ones through", () => {
  assert.equal(shortToken("nxcdb-0123456789012345678901234567"), "nxcdb-012345678901234567...");
  assert.equal(shortToken("short"), "short");
  assert.equal(shortToken(null), "");
});

test("formatExpiry reads seconds, minutes, and expired", () => {
  assert.equal(formatExpiry(-5), "expired");
  assert.equal(formatExpiry(45), "45s");
  assert.equal(formatExpiry(600), "10m");
});

test("resolveConfig keeps only user-entered fields and trims them", () => {
  const c = resolveConfig({ user: "  me@x.com ", password: " pw " });
  assert.equal(c.user, "me@x.com");
  assert.equal(c.password, "pw");
  assert.equal(c.mfaCode, null);
  assert.ok(!("host" in c) && !("siteId" in c));
});

test("missingFields lists what's absent (user + password)", () => {
  assert.deepEqual(missingFields(resolveConfig({})), ["user", "password"]);
  assert.deepEqual(missingFields(resolveConfig({ user: "u", password: "p" })), []);
});
