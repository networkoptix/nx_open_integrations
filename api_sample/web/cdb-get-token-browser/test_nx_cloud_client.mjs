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
  NxCloudTokenClient,
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

function fakeFetch({ post = null } = {}) {
  const calls = { post: null };
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST") {
      calls.post = { url, body: options.body ? JSON.parse(options.body) : null };
      return post;
    }
    throw new Error(`unexpected method ${method}`);
  };
  impl.calls = calls;
  return impl;
}

const SITE = "11111111-2222-3333-4444-555555555555";

function makeClient(fetchOpts = {}, overrides = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxCloudTokenClient({
    user: "me@x.com",
    password: "pw",
    fetchImpl: f,
    ...overrides,
  });
  return { client, f };
}

// ---------------------------------------------------------------------------
// getToken(): the one login call, posted to the same-origin /cloud route
// ---------------------------------------------------------------------------

test("getToken posts to the same-origin /cloud route with the right fixed fields", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "nxcdb-t", expires_in: 3600 } }) });
  const data = await client.getToken();
  assert.equal(data.access_token, "nxcdb-t");
  assert.equal(data.expires_in, 3600);
  assert.equal(f.calls.post.url, "/cloud/cdb/oauth2/token");
  assert.equal(f.calls.post.body.client_id, "3rdParty");
  assert.equal(f.calls.post.body.grant_type, "password");
  assert.equal(f.calls.post.body.response_type, "token");
  assert.equal(f.calls.post.body.username, "me@x.com");
});

test("getToken omits scope for a cloud-wide token by default", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "t" } }) });
  await client.getToken();
  assert.ok(!("scope" in f.calls.post.body), "no scope should be sent without a cloudSiteId");
});

test("getToken adds the cloudSystemId scope when a Site ID is supplied", async () => {
  const { client, f } = makeClient(
    { post: makeResponse({ json: { access_token: "t" } }) },
    { cloudSiteId: SITE },
  );
  await client.getToken();
  assert.equal(f.calls.post.body.scope, `cloudSystemId=${SITE}`);
});

test("getToken adds the mfa code when provided", async () => {
  const { client, f } = makeClient(
    { post: makeResponse({ json: { access_token: "t" } }) },
    { mfaCode: "999111" },
  );
  await client.getToken();
  assert.equal(f.calls.post.body.mfaCode, "999111");
});

test("getToken rejected raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 403, text: "no" }) });
  await assert.rejects(() => client.getToken(), AuthError);
});

test("getToken without an access_token raises ApiError", async () => {
  const { client } = makeClient({ post: makeResponse({ json: { foo: "bar" } }) });
  await assert.rejects(() => client.getToken(), ApiError);
});

test("getToken on a non-ok, non-auth status raises ApiError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 500, text: "boom" }) });
  await assert.rejects(() => client.getToken(), ApiError);
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
    const client = new NxCloudTokenClient({ user: "u", password: "p" }); // no fetchImpl
    await client.getToken();
    assert.notEqual(calledThis, client, "global fetch must not be invoked as a client method");
  } finally {
    globalThis.fetch = original;
  }
});

test("getToken wraps a network failure as ApiError pointing at the dev server", async () => {
  const f = async () => {
    throw new Error("Failed to fetch");
  };
  const client = new NxCloudTokenClient({ user: "u", password: "p", fetchImpl: f });
  await assert.rejects(() => client.getToken(), (err) => err instanceof ApiError && /server\.mjs/.test(err.message));
});

// ---------------------------------------------------------------------------
// cloudUrl / baseUrl
// ---------------------------------------------------------------------------

test("cloudUrl is the same-origin /cloud route by default", () => {
  const { client } = makeClient();
  assert.equal(client.cloudUrl, "/cloud");
});

test("baseUrl override prefixes the cloud route", () => {
  const { client } = makeClient({}, { baseUrl: "http://localhost:8080" });
  assert.equal(client.cloudUrl, "http://localhost:8080/cloud");
});

// ---------------------------------------------------------------------------
// buildTokenRequest helper
// ---------------------------------------------------------------------------

test("buildTokenRequest carries the fixed fields and omits optionals when unset", () => {
  const { client } = makeClient();
  const body = client.buildTokenRequest();
  assert.equal(body.client_id, "3rdParty");
  assert.equal(body.grant_type, "password");
  assert.equal(body.response_type, "token");
  assert.ok(!("mfaCode" in body));
  assert.ok(!("scope" in body));
});

// ---------------------------------------------------------------------------
// config helpers
// ---------------------------------------------------------------------------

test("resolveConfig keeps only the user-entered fields and trims them", () => {
  const c = resolveConfig({ user: "  me@x.com ", password: " pw ", cloudSiteId: ` ${SITE} ` });
  assert.equal(c.user, "me@x.com");
  assert.equal(c.password, "pw");
  assert.equal(c.cloudSiteId, SITE);
  assert.equal(c.mfaCode, null);
  assert.ok(!("host" in c) && !("baseUrl" in c));
});

test("missingFields lists what's absent (Site ID + MFA are optional)", () => {
  assert.deepEqual(missingFields(resolveConfig({})), ["user", "password"]);
  assert.deepEqual(missingFields(resolveConfig({ user: "u", password: "p" })), []);
});
