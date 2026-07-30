// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for cdb_oauth2_sample.mjs. No network, no account needed.
 *
 * Run from this folder:  node --test test_cdb_oauth2_sample.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxCloudOAuthClient,
  extractSystems,
  formatSystemsTable,
  resolveConfig,
  AuthError,
  ApiError,
} from "./cdb_oauth2_sample.mjs";

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

/** Serves one queued response per verb; records what was sent. */
function fakeFetch({ post = null, get = null } = {}) {
  const calls = { post: null, get: null };
  const impl = async (url, options = {}) => {
    if ((options.method || "GET").toUpperCase() === "POST") {
      calls.post = { url, body: options.body ? JSON.parse(options.body) : null };
      return post;
    }
    calls.get = { url, headers: options.headers };
    return get;
  };
  impl.calls = calls;
  return impl;
}

function makeClient(opts = {}, fetchOpts = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxCloudOAuthClient("https://nxvms.com", "me@x.com", "pw", {
    fetchImpl: f,
    ...opts,
  });
  return { client, f };
}

// ---------------------------------------------------------------------------
// login()
// ---------------------------------------------------------------------------

test("login returns and stores the token", async () => {
  const { client, f } = makeClient({}, { post: makeResponse({ json: { access_token: "nxcdb-xyz" } }) });
  const token = await client.login();
  assert.equal(token, "nxcdb-xyz");
  assert.equal(client.token, "nxcdb-xyz");
  assert.equal(f.calls.post.url, "https://nxvms.com/cdb/oauth2/token");
  assert.equal(f.calls.post.body.grant_type, "password");
  assert.equal(f.calls.post.body.client_id, "3rdParty");
  assert.equal(f.calls.post.body.username, "me@x.com");
  assert.ok(!("mfaCode" in f.calls.post.body));
});

test("login includes the mfa code when set", async () => {
  const { client, f } = makeClient(
    { mfaCode: "123456" },
    { post: makeResponse({ json: { access_token: "t" } }) },
  );
  await client.login();
  assert.equal(f.calls.post.body.mfaCode, "123456");
});

test("login with bad credentials raises AuthError", async () => {
  const { client } = makeClient({}, { post: makeResponse({ status: 401, text: "no" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("login without a token raises ApiError", async () => {
  const { client } = makeClient({}, { post: makeResponse({ json: { something_else: 1 } }) });
  await assert.rejects(() => client.login(), ApiError);
});

// ---------------------------------------------------------------------------
// listSystems()
// ---------------------------------------------------------------------------

test("listSystems sends the bearer header", async () => {
  const payload = [{ id: "s1", name: "HQ", status: "activated", version: "6.0" }];
  const { client, f } = makeClient({}, { get: makeResponse({ json: payload }) });
  client.token = "nxcdb-abc";
  const sites = await client.listSystems();
  assert.equal(sites[0].name, "HQ");
  assert.equal(f.calls.get.url, "https://nxvms.com/cdb/systems");
  assert.equal(f.calls.get.headers.Authorization, "Bearer nxcdb-abc");
});

test("listSystems without login raises", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.listSystems(), ApiError);
});

test("listSystems unwraps an object envelope", async () => {
  const payload = { sites: [{ id: "s1", name: "HQ" }, { id: "s2", name: "Lab" }] };
  const { client } = makeClient({}, { get: makeResponse({ json: payload }) });
  client.token = "nxcdb-abc";
  const sites = await client.listSystems();
  assert.deepEqual(sites.map((s) => s.name), ["HQ", "Lab"]);
});

// ---------------------------------------------------------------------------
// scope, config, envelope helper, table
// ---------------------------------------------------------------------------

test("no cloud-site-id means no scope (cloud-wide token)", async () => {
  const { client, f } = makeClient({}, { post: makeResponse({ json: { access_token: "t" } }) });
  await client.login();
  assert.ok(!("scope" in f.calls.post.body));
});

test("scope is set when a cloud-site-id is given", async () => {
  const { client, f } = makeClient(
    { cloudSystemId: "sys-123" },
    { post: makeResponse({ json: { access_token: "t" } }) },
  );
  await client.login();
  assert.equal(f.calls.post.body.scope, "cloudSystemId=sys-123");
});

test("CLI flag overrides env var", () => {
  const args = { host: "https://cli", user: null, password: null, mfaCode: null, cloudSystemId: null };
  const config = resolveConfig(args, { NX_CLOUD_HOST: "https://file" }, { NX_CLOUD_HOST: "https://env" });
  assert.equal(config.host, "https://cli");
});

test("extractSystems handles the shapes", () => {
  const bare = [{ id: "s1" }];
  assert.equal(extractSystems(bare), bare);
  assert.deepEqual(extractSystems({ sites: bare }), bare);
  assert.deepEqual(extractSystems({ reply: bare }), bare);
  assert.deepEqual(extractSystems({ data: { sites: bare } }), bare);
  assert.deepEqual(extractSystems({ whatever: bare }), bare); // fallback scan
  assert.deepEqual(extractSystems({ count: 0 }), []);
  assert.deepEqual(extractSystems("nope"), []);
});

test("formatSystemsTable renders rows and the empty case", () => {
  const out = formatSystemsTable([{ id: "s1", name: "HQ", status: "activated", version: "6.0" }]);
  assert.ok(out.includes("NAME") && out.includes("HQ"));
  assert.ok(formatSystemsTable([]).includes("No Sites"));
});
