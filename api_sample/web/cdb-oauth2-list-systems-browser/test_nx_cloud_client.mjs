// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-cloud-client.mjs. No network, no account, no browser.
 *
 * The page-wiring (app.mjs) only touches the DOM, so the API logic lives in
 * nx-cloud-client.mjs and is tested here with a fake fetch — same approach as
 * the Node samples.
 *
 * Run from this folder:  node --test test_nx_cloud_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxCloudClient,
  normalizeSites,
  resolveConfig,
  missingFields,
  AuthError,
  ApiError,
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
    calls.get = { url, headers: options.headers, redirect: options.redirect };
    return get;
  };
  impl.calls = calls;
  return impl;
}

function makeClient(fetchOpts = {}, overrides = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxCloudClient({
    user: "me@x.com",
    password: "pw",
    fetchImpl: f,
    ...overrides,
  });
  return { client, f };
}

// ---------------------------------------------------------------------------
// login(): cloud-wide token, NO scope (Sites are an account-level call)
// ---------------------------------------------------------------------------

test("login posts to the same-origin /cloud route with NO scope", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "nxcdb-t" } }) });
  const token = await client.login();
  assert.equal(token, "nxcdb-t");
  assert.equal(f.calls.post.url, "/cloud/cdb/oauth2/token");
  assert.equal(f.calls.post.body.client_id, "3rdParty");
  assert.equal(f.calls.post.body.grant_type, "password");
  assert.equal(f.calls.post.body.response_type, "token");
  // No scope: a cloud-wide token is needed to list the account's Sites.
  assert.ok(!("scope" in f.calls.post.body));
});

test("login adds the mfa code when provided", async () => {
  const { client, f } = makeClient(
    { post: makeResponse({ json: { access_token: "t" } }) },
    { mfaCode: "999111" },
  );
  await client.login();
  assert.equal(f.calls.post.body.mfaCode, "999111");
});

test("login rejected raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 403, text: "no" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("default fetch is called via global (preserves receiver, no illegal invocation)", async () => {
  // Regression guard for "Can only call Window.fetch on instances of Window":
  // the client must call the GLOBAL fetch, not invoke it as its own method.
  const original = globalThis.fetch;
  let calledThis = "unset";
  globalThis.fetch = function (url, options) {
    calledThis = this; // a bare/global call has `this` === globalThis (or undefined in strict)
    return makeResponse({ json: { access_token: "t" } });
  };
  try {
    const client = new NxCloudClient({ user: "u", password: "p" }); // no fetchImpl
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
  const client = new NxCloudClient({ user: "u", password: "p", fetchImpl: f });
  await assert.rejects(() => client.login(), (err) => err instanceof ApiError && /server\.mjs/.test(err.message));
});

// ---------------------------------------------------------------------------
// cloud url + listSites() — same-origin /cloud/cdb/systems with a bearer
// ---------------------------------------------------------------------------

test("cloudUrl is the same-origin /cloud route by default", () => {
  const { client } = makeClient();
  assert.equal(client.cloudUrl, "/cloud");
});

test("baseUrl override prefixes the cloud route", () => {
  const { client } = makeClient({}, { baseUrl: "http://localhost:8080" });
  assert.equal(client.cloudUrl, "http://localhost:8080/cloud");
});

test("listSites hits the same-origin /cdb/systems path with a bearer", async () => {
  const payload = [{ id: "s1", name: "HQ", status: "online", version: "6.0" }];
  const { client, f } = makeClient({ get: makeResponse({ json: payload }) });
  client.token = "nxcdb-t";
  const sites = await client.listSites();
  assert.equal(sites[0].name, "HQ");
  assert.equal(f.calls.get.url, "/cloud/cdb/systems");
  assert.equal(f.calls.get.headers.Authorization, "Bearer nxcdb-t");
});

test("listSites without login raises ApiError", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.listSites(), ApiError);
});

test("listSites maps a cloud 403 to AuthError", async () => {
  const { client } = makeClient({ get: makeResponse({ status: 403, text: "denied" }) });
  client.token = "t";
  await assert.rejects(() => client.listSites(), AuthError);
});

// ---------------------------------------------------------------------------
// logout() deletes the token ON THE CLOUD
// ---------------------------------------------------------------------------

test("logout deletes the token via the same-origin /cloud route", async () => {
  const { client, f } = makeClient({ del: makeResponse({ status: 204 }) });
  client.token = "nxcdb-t";
  await client.logout();
  assert.equal(f.calls.deleteUrl, "/cloud/cdb/oauth2/token/nxcdb-t");
  assert.equal(client.token, null);
});

// ---------------------------------------------------------------------------
// normalizeSites: bare array OR an envelope, trimmed fields
// ---------------------------------------------------------------------------

test("normalizeSites handles a bare array", () => {
  const out = normalizeSites([{ id: "s1", name: "HQ", status: "online", version: "6.0", extra: 1 }]);
  assert.deepEqual(out, [{ name: "HQ", status: "online", version: "6.0", id: "s1" }]);
});

test("normalizeSites unwraps a sites envelope", () => {
  const out = normalizeSites({ sites: [{ id: "s2", name: "Warehouse" }] });
  assert.equal(out[0].name, "Warehouse");
  assert.equal(out[0].version, "");
});

test("normalizeSites unwraps a systems envelope", () => {
  const out = normalizeSites({ systems: [{ id: "s3", name: "Dock" }] });
  assert.equal(out[0].name, "Dock");
});

test("normalizeSites unwraps a reply envelope", () => {
  const out = normalizeSites({ reply: [{ id: "s4", name: "Lab" }] });
  assert.equal(out[0].name, "Lab");
});

test("normalizeSites prefers stateOfHealth for status when present", () => {
  const out = normalizeSites([{ id: "s5", name: "HQ", stateOfHealth: "online" }]);
  assert.equal(out[0].status, "online");
});

test("normalizeSites returns [] for junk", () => {
  assert.deepEqual(normalizeSites(null), []);
  assert.deepEqual(normalizeSites({ nope: true }), []);
});

// ---------------------------------------------------------------------------
// config helpers
// ---------------------------------------------------------------------------

test("resolveConfig keeps only the user-entered fields and trims them", () => {
  const c = resolveConfig({ user: "  me@x.com ", password: " pw " });
  assert.equal(c.user, "me@x.com");
  assert.equal(c.password, "pw");
  assert.equal(c.mfaCode, null);
  assert.ok(!("cloudHost" in c) && !("siteId" in c));
});

test("missingFields lists what's absent", () => {
  assert.deepEqual(missingFields(resolveConfig({})), ["user", "password"]);
  assert.deepEqual(missingFields(resolveConfig({ user: "u", password: "p" })), []);
});
