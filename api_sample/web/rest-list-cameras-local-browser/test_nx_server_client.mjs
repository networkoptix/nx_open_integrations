// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-server-client.mjs. No network, no account, no browser.
 *
 * The page-wiring (app.mjs) only touches the DOM, so the API logic lives in
 * nx-server-client.mjs and is tested here with a fake fetch — same approach as
 * the Node samples.
 *
 * Run from this folder:  node --test test_nx_server_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxServerClient,
  normalizeCameras,
  resolveConfig,
  missingFields,
  AuthError,
  ApiError,
} from "./nx-server-client.mjs";

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

function fakeFetch({ post = null, get = null, del = null } = {}) {
  const calls = { post: null, get: null, deleteUrl: null, deleteCalls: 0 };
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
    calls.get = { url, headers: options.headers };
    return get;
  };
  impl.calls = calls;
  return impl;
}

function makeClient(fetchOpts = {}, overrides = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxServerClient({
    user: "admin",
    password: "pw",
    fetchImpl: f,
    ...overrides,
  });
  return { client, f };
}

// ---------------------------------------------------------------------------
// login(): POST credentials to the same-origin /server route, get a token
// ---------------------------------------------------------------------------

test("login posts to the same-origin /server login route with setCookie:false", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { token: "tok-1" } }) });
  const token = await client.login();
  assert.equal(token, "tok-1");
  assert.equal(f.calls.post.url, "/server/rest/v4/login/sessions");
  assert.equal(f.calls.post.body.username, "admin");
  assert.equal(f.calls.post.body.password, "pw");
  assert.equal(f.calls.post.body.setCookie, false);
});

test("login rejected raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 401, text: "no" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("login with no token in the response raises ApiError", async () => {
  const { client } = makeClient({ post: makeResponse({ json: {} }) });
  await assert.rejects(() => client.login(), ApiError);
});

test("default fetch is called via global (preserves receiver, no illegal invocation)", async () => {
  // Regression guard for "Can only call Window.fetch on instances of Window":
  // the client must call the GLOBAL fetch, not invoke it as its own method.
  const original = globalThis.fetch;
  let calledThis = "unset";
  globalThis.fetch = function (url, options) {
    calledThis = this; // a bare/global call has `this` === globalThis (or undefined in strict)
    return makeResponse({ json: { token: "t" } });
  };
  try {
    const client = new NxServerClient({ user: "u", password: "p" }); // no fetchImpl
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
  const client = new NxServerClient({ user: "u", password: "p", fetchImpl: f });
  await assert.rejects(() => client.login(), (err) => err instanceof ApiError && /server\.mjs/.test(err.message));
});

// ---------------------------------------------------------------------------
// server url + listCameras() — same-origin /server route, bearer token
// ---------------------------------------------------------------------------

test("serverUrl is the same-origin /server route by default", () => {
  const { client } = makeClient();
  assert.equal(client.serverUrl, "/server");
});

test("baseUrl override prefixes the server route", () => {
  const { client } = makeClient({}, { baseUrl: "http://localhost:8080" });
  assert.equal(client.serverUrl, "http://localhost:8080/server");
});

test("listCameras hits the same-origin v4 devices path with a bearer", async () => {
  const payload = [{ id: "c1", name: "Lobby", status: "Online", model: "Axis" }];
  const { client, f } = makeClient({ get: makeResponse({ json: payload }) });
  client.token = "tok-1";
  const cams = await client.listCameras();
  assert.equal(cams[0].name, "Lobby");
  assert.equal(f.calls.get.url, "/server/rest/v4/devices");
  assert.equal(f.calls.get.headers.Authorization, "Bearer tok-1");
});

test("listCameras without login raises ApiError", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.listCameras(), ApiError);
});

test("listCameras maps a server 403 to AuthError", async () => {
  const { client } = makeClient({ get: makeResponse({ status: 403, text: "denied" }) });
  client.token = "t";
  await assert.rejects(() => client.listCameras(), AuthError);
});

// ---------------------------------------------------------------------------
// logout() deletes the session token on the SERVER
// ---------------------------------------------------------------------------

test("logout deletes the session token via the same-origin /server route", async () => {
  const { client, f } = makeClient({ del: makeResponse({ status: 204 }) });
  client.token = "tok-1";
  await client.logout();
  assert.equal(f.calls.deleteUrl, "/server/rest/v4/login/sessions/tok-1");
  assert.equal(client.token, null);
});

test("logout with no token does nothing", async () => {
  const { client, f } = makeClient({ del: makeResponse({ status: 204 }) });
  await client.logout();
  assert.equal(f.calls.deleteCalls, 0);
});

// ---------------------------------------------------------------------------
// normalizeCameras: bare array OR { reply: [...] } envelope, trimmed fields
// ---------------------------------------------------------------------------

test("normalizeCameras handles a bare array", () => {
  const out = normalizeCameras([{ id: "c1", name: "Lobby", status: "Online", model: "Axis", extra: 1 }]);
  assert.deepEqual(out, [{ name: "Lobby", status: "Online", model: "Axis", id: "c1" }]);
});

test("normalizeCameras unwraps a reply envelope", () => {
  const out = normalizeCameras({ reply: [{ id: "c2", name: "Dock" }] });
  assert.equal(out[0].name, "Dock");
  assert.equal(out[0].model, "");
});

test("normalizeCameras returns [] for junk", () => {
  assert.deepEqual(normalizeCameras(null), []);
  assert.deepEqual(normalizeCameras({ nope: true }), []);
});

// ---------------------------------------------------------------------------
// config helpers
// ---------------------------------------------------------------------------

test("resolveConfig keeps only the user-entered fields and trims them", () => {
  const c = resolveConfig({ user: "  admin ", password: " pw " });
  assert.equal(c.user, "admin");
  assert.equal(c.password, "pw");
  assert.ok(!("host" in c) && !("serverHost" in c));
});

test("missingFields lists what's absent", () => {
  assert.deepEqual(missingFields(resolveConfig({})), ["user", "password"]);
  assert.deepEqual(missingFields(resolveConfig({ user: "u", password: "p" })), []);
});
