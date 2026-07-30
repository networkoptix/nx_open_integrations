// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for cdb_refresh_token.mjs. No network, no account needed.
 *
 * Covers the session lifecycle: expiry tracking, proactive refresh, refresh
 * token rotation, reactive 401-retry, and on-disk persistence.
 *
 * Run from this folder:  node --test test_cdb_refresh_token.mjs
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPasswordRequest,
  buildRefreshRequest,
  TokenSession,
  resolveConfig,
  AuthError,
  ApiError,
} from "./cdb_refresh_token.mjs";

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

/** Serves queued POST and GET responses in order; records each call. */
function fakeFetch({ posts = [], gets = [] } = {}) {
  const postQ = [...posts];
  const getQ = [...gets];
  const postCalls = []; // {url, body}
  const getCalls = []; // {url, headers}
  const impl = async (url, options = {}) => {
    if ((options.method || "GET").toUpperCase() === "POST") {
      postCalls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      return postQ.shift();
    }
    getCalls.push({ url, headers: options.headers });
    return getQ.shift();
  };
  impl.postCalls = postCalls;
  impl.getCalls = getCalls;
  return impl;
}

/** A controllable time source (seconds) so expiry logic is deterministic. */
function makeClock(start = 1000) {
  const state = { now: start };
  const fn = () => state.now;
  fn.advance = (s) => {
    state.now += s;
  };
  return fn;
}

function makeSession({ posts, gets, clock, storePath } = {}) {
  const f = fakeFetch({ posts, gets });
  const timeFn = clock || makeClock();
  const sess = new TokenSession("https://nxvms.com", {
    storePath,
    fetchImpl: f,
    timeFn,
  });
  return { sess, f, clock: timeFn };
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

test("password body has the documented fields", () => {
  const body = buildPasswordRequest("me@x.com", "pw");
  assert.equal(body.grant_type, "password");
  assert.equal(body.client_id, "3rdParty");
  assert.ok(!("mfaCode" in body));
});

test("refresh body is correct", () => {
  assert.deepEqual(buildRefreshRequest("r1"), {
    grant_type: "refresh_token",
    response_type: "token",
    client_id: "3rdParty",
    refresh_token: "r1",
  });
});

// ---------------------------------------------------------------------------
// login() / refresh() basics
// ---------------------------------------------------------------------------

test("login sets tokens and expiry", async () => {
  const { sess, f, clock } = makeSession({
    posts: [makeResponse({ json: { access_token: "a1", refresh_token: "r1", expires_in: 3600 } })],
  });
  await sess.login("me@x.com", "pw");
  assert.equal(sess.accessToken, "a1");
  assert.equal(sess.refreshToken, "r1");
  assert.equal(sess.expiresAt, clock() + 3600);
  assert.equal(f.postCalls[0].body.grant_type, "password");
});

test("refresh sends no password", async () => {
  const { sess, f } = makeSession({ posts: [makeResponse({ json: { access_token: "a2" } })] });
  sess.refreshToken = "r1";
  await sess.refresh();
  const body = f.postCalls[0].body;
  assert.equal(body.grant_type, "refresh_token");
  assert.ok(!("password" in body));
});

test("refresh without a token raises", async () => {
  const { sess } = makeSession();
  await assert.rejects(() => sess.refresh(), ApiError);
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test("a new refresh token in the response replaces the old one", async () => {
  const { sess } = makeSession({
    posts: [makeResponse({ json: { access_token: "a2", refresh_token: "r2" } })],
  });
  sess.refreshToken = "r1";
  await sess.refresh();
  assert.equal(sess.refreshToken, "r2");
});

test("refresh keeps the old token when none returned", async () => {
  const { sess } = makeSession({ posts: [makeResponse({ json: { access_token: "a2" } })] });
  sess.refreshToken = "r1";
  await sess.refresh();
  assert.equal(sess.refreshToken, "r1");
});

// ---------------------------------------------------------------------------
// Expiry + proactive ensureValid()
// ---------------------------------------------------------------------------

test("isExpiring respects the safety margin", () => {
  const clock = makeClock();
  const { sess } = makeSession({ clock });
  sess.accessToken = "a1";
  sess.expiresAt = clock() + 3600;
  assert.equal(sess.isExpiring(), false);
  clock.advance(3600 - 10); // 10s left, inside the 60s margin
  assert.equal(sess.isExpiring(), true);
});

test("ensureValid refreshes only when needed", async () => {
  const clock = makeClock();
  const { sess, f } = makeSession({
    clock,
    posts: [
      makeResponse({ json: { access_token: "a1", refresh_token: "r1", expires_in: 3600 } }),
      makeResponse({ json: { access_token: "a2", refresh_token: "r2", expires_in: 3600 } }),
    ],
  });
  await sess.login("me@x.com", "pw");
  await sess.ensureValid();
  assert.equal(sess.accessToken, "a1"); // no refresh happened
  assert.equal(f.postCalls.length, 1);

  clock.advance(3600); // now expired
  await sess.ensureValid();
  assert.equal(sess.accessToken, "a2"); // proactive refresh happened
  assert.equal(f.postCalls.length, 2);
});

// ---------------------------------------------------------------------------
// Reactive 401 -> refresh -> retry
// ---------------------------------------------------------------------------

test("authorizedGet retries after a 401", async () => {
  const clock = makeClock();
  const { sess, f } = makeSession({
    clock,
    posts: [makeResponse({ json: { access_token: "a2", refresh_token: "r2" } })],
    gets: [makeResponse({ status: 401, text: "expired" }), makeResponse({ json: { ok: true } })],
  });
  sess.accessToken = "a1";
  sess.refreshToken = "r1";
  sess.expiresAt = clock() + 3600; // not expiring, so the 401 is a surprise

  const resp = await sess.authorizedGet("/cdb/systems");

  assert.equal(resp.status, 200);
  assert.equal(f.postCalls.length, 1); // one reactive refresh
  assert.equal(f.getCalls[1].headers.Authorization, "Bearer a2"); // retried w/ new token
});

// ---------------------------------------------------------------------------
// Persistence across "runs"
// ---------------------------------------------------------------------------

test("session persists to disk and reloads", async () => {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nxsess-")), "session.json");

  // Run 1: log in, which saves the refresh token to disk.
  const run1 = makeSession({
    posts: [makeResponse({ json: { access_token: "a1", refresh_token: "r1", expires_in: 3600 } })],
    storePath: store,
  });
  await run1.sess.login("me@x.com", "pw");

  // Run 2: a brand-new session with the same store loads the refresh token.
  const run2 = makeSession({
    posts: [makeResponse({ json: { access_token: "a2", refresh_token: "r2" } })],
    storePath: store,
  });
  assert.equal(run2.sess.refreshToken, "r1"); // loaded from disk
  await run2.sess.refresh();
  assert.equal(run2.sess.accessToken, "a2");
  assert.ok(!("password" in run2.f.postCalls[0].body));
});

// ---------------------------------------------------------------------------
// Errors + config
// ---------------------------------------------------------------------------

test("login with bad credentials raises AuthError", async () => {
  const { sess } = makeSession({ posts: [makeResponse({ status: 401, text: "no" })] });
  await assert.rejects(() => sess.login("u", "p"), AuthError);
});

test("config reads the refresh-token env var", () => {
  const args = { host: null, user: null, password: null, mfaCode: null, refreshToken: null };
  const config = resolveConfig(args, {}, { NX_CLOUD_REFRESH_TOKEN: "env-rt" });
  assert.equal(config.refreshToken, "env-rt");
});
