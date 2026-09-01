// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-login-client.mjs. No network, no server, no browser.
 *
 * Run from this folder:  node --test test_nx_login_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxLoginClient,
  sessionRows,
  resolveConfig,
  missingFields,
  AuthError,
  ApiError,
  API,
} from "./nx-login-client.mjs";

const SESSION = {
  id: "{aaaa-bbbb}",
  username: "admin",
  token: "abc123",
  ageS: 0,
  expiresInS: 600,
};

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
 * Serves queued responses per verb and records every call.
 *
 * `get` accepts an array because this sample calls GET twice: once to use the
 * token, once after logout to prove it is dead.
 */
function fakeFetch({ post = null, get = null, del = null } = {}) {
  const queue = Array.isArray(get) ? [...get] : get ? [get] : [];
  const calls = { post: null, gets: [], deleteUrl: null, deleteHeaders: null, deleteCalls: 0 };
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST") {
      calls.post = { url, body: options.body ? JSON.parse(options.body) : null };
      if (post instanceof Error) throw post;
      return post;
    }
    if (method === "DELETE") {
      calls.deleteUrl = url;
      calls.deleteHeaders = options.headers;
      calls.deleteCalls += 1;
      if (del instanceof Error) throw del;
      return del;
    }
    calls.gets.push({ url, headers: options.headers });
    const next = queue.length ? queue.shift() : makeResponse({ json: {} });
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

function makeClient(fetchOpts = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxLoginClient({ user: "admin", password: "pw", fetchImpl: f });
  return { client, f };
}

// ---------------------------------------------------------------------------
// Routing: everything goes through the same-origin /server proxy route
// ---------------------------------------------------------------------------

test("serverUrl defaults to the same-origin /server route", () => {
  const { client } = makeClient();
  assert.equal(client.serverUrl, "/server");
});

test("a custom baseUrl is honored and trailing slashes trimmed", () => {
  const client = new NxLoginClient({ user: "a", password: "b", baseUrl: "http://localhost:8080//" });
  assert.equal(client.serverUrl, "http://localhost:8080/server");
});

// ---------------------------------------------------------------------------
// Step 1 — login()
// ---------------------------------------------------------------------------

test("login posts credentials through the proxy route", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: SESSION }) });

  const result = await client.login();

  assert.equal(client.token, "abc123");
  assert.equal(f.calls.post.url, `/server${API}/login/sessions`);
  assert.deepEqual(f.calls.post.body, { username: "admin", password: "pw", setCookie: false });
  // The whole session object comes back, not just the token string.
  assert.equal(result.expiresInS, 600);
  assert.equal(result.id, "{aaaa-bbbb}");
});

test("login unauthorized raises AuthError mentioning local accounts", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 401, text: "bad" }) });
  await assert.rejects(() => client.login(), (err) => {
    assert.ok(err instanceof AuthError);
    assert.match(err.message, /LOCAL server account/);
    return true;
  });
});

test("login forbidden raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 403, text: "nope" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("login without a token raises ApiError", async () => {
  const { client } = makeClient({ post: makeResponse({ json: { id: "x" } }) });
  await assert.rejects(() => client.login(), ApiError);
});

test("login with the dev server down points at the README", async () => {
  const { client } = makeClient({ post: new Error("fetch failed") });
  await assert.rejects(() => client.login(), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /server\.mjs --server-host/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Step 2 — getCurrentSession()
// ---------------------------------------------------------------------------

test("getCurrentSession uses the bearer header on the current path", async () => {
  const { client, f } = makeClient({ get: makeResponse({ json: SESSION }) });
  client.token = "abc123";

  const data = await client.getCurrentSession();

  const { url, headers } = f.calls.gets[0];
  assert.equal(url, `/server${API}/login/sessions/current`);
  // The path uses the sentinel; the header carries the token.
  assert.equal(headers.Authorization, "Bearer abc123");
  assert.ok(!url.includes("abc123"));
  assert.equal(data.username, "admin");
});

test("getCurrentSession without login raises", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.getCurrentSession(), ApiError);
});

test("getCurrentSession rejected raises AuthError", async () => {
  const { client } = makeClient({ get: makeResponse({ status: 401 }) });
  client.token = "abc123";
  await assert.rejects(() => client.getCurrentSession(), AuthError);
});

// ---------------------------------------------------------------------------
// Step 4 — tokenStillWorks() must NOT throw: a 401 here is the good outcome
// ---------------------------------------------------------------------------

test("tokenStillWorks reports live while the session is live", async () => {
  const { client } = makeClient({ get: makeResponse({ json: SESSION }) });
  assert.deepEqual(await client.tokenStillWorks("abc123"), { isLive: true, status: 200 });
});

test("tokenStillWorks reports dead after logout without throwing", async () => {
  const { client } = makeClient({ get: makeResponse({ status: 401 }) });
  assert.deepEqual(await client.tokenStillWorks("abc123"), { isLive: false, status: 401 });
});

test("tokenStillWorks reports unknown when the proxy is unreachable", async () => {
  const { client } = makeClient({ get: new Error("fetch failed") });
  assert.deepEqual(await client.tokenStillWorks("abc123"), { isLive: false, status: null });
});

// ---------------------------------------------------------------------------
// Step 3 — logout()
// ---------------------------------------------------------------------------

test("logout deletes the session and clears the token", async () => {
  const { client, f } = makeClient({ del: makeResponse({ json: {} }) });
  client.token = "abc123";

  assert.equal(await client.logout(), true);
  assert.equal(f.calls.deleteCalls, 1);
  assert.equal(f.calls.deleteUrl, `/server${API}/login/sessions/current`);
  // The path uses the sentinel; the header carries the token.
  assert.ok(!f.calls.deleteUrl.includes("abc123"));
  assert.equal(f.calls.deleteHeaders.Authorization, "Bearer abc123");
  assert.equal(client.token, null);
});

test("logout without a token is a no-op", async () => {
  const { client, f } = makeClient();
  assert.equal(await client.logout(), false);
  assert.equal(f.calls.deleteCalls, 0);
});

test("logout swallows a network error", async () => {
  const { client } = makeClient({ del: new Error("boom") });
  client.token = "abc123";
  assert.equal(await client.logout(), false);
  assert.equal(client.token, null);
});

// ---------------------------------------------------------------------------
// The full four-step sequence, as the page runs it
// ---------------------------------------------------------------------------

test("the four steps issue exactly one POST, two GETs and one DELETE", async () => {
  const { client, f } = makeClient({
    post: makeResponse({ json: SESSION }),
    get: [makeResponse({ json: SESSION }), makeResponse({ status: 401 })],
    del: makeResponse({ json: {} }),
  });

  await client.login();
  await client.getCurrentSession();
  const spent = client.token;
  await client.logout();
  const probe = await client.tokenStillWorks(spent);

  assert.equal(f.calls.gets.length, 2);
  assert.equal(f.calls.deleteCalls, 1);
  assert.deepEqual(probe, { isLive: false, status: 401 });
});

// ---------------------------------------------------------------------------
// UI shaping
// ---------------------------------------------------------------------------

test("sessionRows renders the lifetime fields", () => {
  const rows = sessionRows(SESSION);
  const flat = rows.map(([label, value]) => `${label}=${value}`).join("|");
  assert.match(flat, /Token=abc123/);
  assert.match(flat, /Expires in=600 seconds/);
});

test("sessionRows omits absent lifetime fields", () => {
  const labels = sessionRows({ token: "t" }).map(([label]) => label);
  assert.ok(!labels.includes("Expires in"));
  assert.ok(!labels.includes("Age"));
});

test("sessionRows tolerates an empty session", () => {
  assert.equal(sessionRows().length, 3); // token / id / username, all blank
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test("resolveConfig trims and stringifies the two fields", () => {
  assert.deepEqual(resolveConfig({ user: "  admin ", password: "pw" }), {
    user: "admin",
    password: "pw",
  });
});

test("missingFields names what the form still needs", () => {
  assert.deepEqual(missingFields({ user: "", password: "" }), ["user", "password"]);
  assert.deepEqual(missingFields({ user: "admin", password: "pw" }), []);
});
