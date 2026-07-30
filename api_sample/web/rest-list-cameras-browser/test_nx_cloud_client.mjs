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
  NxCloudSiteClient,
  normalizeCameras,
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

const SYS = "11111111-2222-3333-4444-555555555555";

function makeClient(fetchOpts = {}, overrides = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxCloudSiteClient({
    user: "me@x.com",
    password: "pw",
    siteId: SYS,
    fetchImpl: f,
    ...overrides,
  });
  return { client, f };
}

// ---------------------------------------------------------------------------
// login(): the token MUST carry the cloudSystemId scope
// ---------------------------------------------------------------------------

test("login posts to the same-origin /cloud route with the site scope", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "nxcdb-t" } }) });
  const token = await client.login();
  assert.equal(token, "nxcdb-t");
  assert.equal(f.calls.post.url, "/cloud/cdb/oauth2/token");
  assert.equal(f.calls.post.body.scope, `cloudSystemId=${SYS}`);
  assert.equal(f.calls.post.body.client_id, "3rdParty");
  assert.equal(f.calls.post.body.grant_type, "password");
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
    const client = new NxCloudSiteClient({ user: "u", password: "p", siteId: SYS }); // no fetchImpl
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
  const client = new NxCloudSiteClient({ user: "u", password: "p", siteId: SYS, fetchImpl: f });
  await assert.rejects(() => client.login(), (err) => err instanceof ApiError && /server\.mjs/.test(err.message));
});

// ---------------------------------------------------------------------------
// relay url + listCameras() — same-origin /relay/<id>, NO manual redirect
// ---------------------------------------------------------------------------

test("relayUrl is the same-origin /relay/<siteId> route by default", () => {
  const { client } = makeClient();
  assert.equal(client.relayUrl, `/relay/${SYS}`);
});

test("baseUrl override prefixes both cloud and relay routes", () => {
  const { client } = makeClient({}, { baseUrl: "http://localhost:8080" });
  assert.equal(client.cloudUrl, "http://localhost:8080/cloud");
  assert.equal(client.relayUrl, `http://localhost:8080/relay/${SYS}`);
});

test("listCameras hits the same-origin v4 devices path with a bearer, no manual redirect", async () => {
  const payload = [{ id: "c1", name: "Lobby", status: "Online", model: "Axis" }];
  const { client, f } = makeClient({ get: makeResponse({ json: payload }) });
  client.token = "nxcdb-t";
  const cams = await client.listCameras();
  assert.equal(cams[0].name, "Lobby");
  assert.equal(f.calls.get.url, `/relay/${SYS}/rest/v4/devices`);
  assert.equal(f.calls.get.headers.Authorization, "Bearer nxcdb-t");
  // Browser must NOT use redirect:"manual" (opaqueredirect is unreadable).
  assert.equal(f.calls.get.redirect, undefined);
});

test("listCameras without login raises ApiError", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.listCameras(), ApiError);
});

test("listCameras maps a site 403 to AuthError", async () => {
  const { client } = makeClient({ get: makeResponse({ status: 403, text: "denied" }) });
  client.token = "t";
  await assert.rejects(() => client.listCameras(), AuthError);
});

// ---------------------------------------------------------------------------
// logout() deletes the token ON THE CLOUD
// ---------------------------------------------------------------------------

test("logout deletes the scoped token via the same-origin /cloud route", async () => {
  const { client, f } = makeClient({ del: makeResponse({ status: 204 }) });
  client.token = "nxcdb-t";
  await client.logout();
  assert.equal(f.calls.deleteUrl, "/cloud/cdb/oauth2/token/nxcdb-t");
  assert.equal(client.token, null);
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
  const c = resolveConfig({ user: "  me@x.com ", siteId: SYS });
  assert.equal(c.user, "me@x.com");
  assert.equal(c.siteId, SYS);
  assert.equal(c.mfaCode, null);
  assert.ok(!("cloudHost" in c) && !("relayBase" in c));
});

test("missingFields lists what's absent", () => {
  assert.deepEqual(missingFields(resolveConfig({})), ["siteId", "user", "password"]);
  assert.deepEqual(missingFields(resolveConfig({ user: "u", password: "p", siteId: SYS })), []);
});
