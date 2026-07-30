// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for rest_cloud_sample.mjs. No network, no account needed.
 *
 * Run from this folder:  node --test test_rest_cloud_sample.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxCloudSiteClient,
  formatCamerasTable,
  resolveConfig,
  AuthError,
  ApiError,
} from "./rest_cloud_sample.mjs";

function makeResponse({ status = 200, json = null, text = "", headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return {
    status,
    ok: status < 400,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    async json() {
      if (json === null) throw new Error("no json");
      return json;
    },
    async text() {
      return text;
    },
  };
}

/** Serves queued GET responses in order; records each GET. */
function fakeFetch({ post = null, gets = [], del = null } = {}) {
  const getQ = [...gets];
  const calls = { post: null, gets: [], deleteUrl: null, deleteCalls: 0 };
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
    calls.gets.push({ url, headers: options.headers, redirect: options.redirect });
    return getQ.shift();
  };
  impl.calls = calls;
  return impl;
}

const SYS = "11111111-2222-3333-4444-555555555555";

function makeClient(fetchOpts = {}, opts = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxCloudSiteClient("https://nxvms.com", "me@x.com", "pw", SYS, {
    fetchImpl: f,
    ...opts,
  });
  return { client, f };
}

// ---------------------------------------------------------------------------
// login(): the token MUST carry the cloudSystemId scope
// ---------------------------------------------------------------------------

test("login includes the site scope", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "nxcdb-t" } }) });
  const token = await client.login();
  assert.equal(token, "nxcdb-t");
  assert.equal(f.calls.post.url, "https://nxvms.com/cdb/oauth2/token");
  assert.equal(f.calls.post.body.scope, `cloudSystemId=${SYS}`);
  assert.equal(f.calls.post.body.client_id, "3rdParty");
});

test("login adds the mfa code", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "t" } }) }, { mfaCode: "999111" });
  await client.login();
  assert.equal(f.calls.post.body.mfaCode, "999111");
});

test("login rejected raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 403, text: "no" }) });
  await assert.rejects(() => client.login(), AuthError);
});

// ---------------------------------------------------------------------------
// relay url + listCameras() — uses the latest /rest/v4 via the relay
// ---------------------------------------------------------------------------

test("relayUrl is built from the site id", () => {
  const { client } = makeClient();
  assert.equal(client.relayUrl, `https://${SYS}.relay.vmsproxy.com`);
});

test("listCameras uses the relay v4 path, bearer, and manual redirect", async () => {
  const payload = [{ id: "c1", name: "Lobby", status: "Online", model: "Axis" }];
  const { client, f } = makeClient({ gets: [makeResponse({ json: payload })] });
  client.token = "nxcdb-t";
  const cams = await client.listCameras();
  assert.equal(cams[0].name, "Lobby");
  const call = f.calls.gets[0];
  assert.equal(call.url, `https://${SYS}.relay.vmsproxy.com/rest/v4/devices`);
  assert.equal(call.headers.Authorization, "Bearer nxcdb-t");
  assert.equal(call.redirect, "manual"); // we follow redirects ourselves
});

test("listCameras follows a 307 with the bearer preserved", async () => {
  const node = "https://node7.relay.vmsproxy.com/rest/v4/devices";
  const payload = [{ id: "c1", name: "Lobby", status: "Online", model: "Axis" }];
  const { client, f } = makeClient({
    gets: [
      makeResponse({ status: 307, headers: { Location: node } }),
      makeResponse({ json: payload }),
    ],
  });
  client.token = "nxcdb-t";

  const cams = await client.listCameras();

  assert.equal(f.calls.gets.length, 2);
  // Crucially, the bearer header is re-attached on the redirected request.
  assert.equal(f.calls.gets[1].url, node);
  assert.equal(f.calls.gets[1].headers.Authorization, "Bearer nxcdb-t");
  assert.equal(cams[0].name, "Lobby");
});

test("listCameras redirect without a Location header raises", async () => {
  const { client } = makeClient({ gets: [makeResponse({ status: 307, headers: {} })] });
  client.token = "t";
  await assert.rejects(() => client.listCameras(), ApiError);
});

test("listCameras gives up after too many redirects", async () => {
  const node = "https://node7.relay.vmsproxy.com/rest/v4/devices";
  const { client } = makeClient({
    gets: Array.from({ length: 7 }, () => makeResponse({ status: 307, headers: { Location: node } })),
  });
  client.token = "t";
  await assert.rejects(() => client.listCameras(), ApiError);
});

test("listCameras unwraps a reply envelope", async () => {
  const { client } = makeClient({ gets: [makeResponse({ json: { reply: [{ id: "c1", name: "L" }] } })] });
  client.token = "t";
  const cams = await client.listCameras();
  assert.equal(cams[0].name, "L");
});

test("listCameras without login raises", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.listCameras(), ApiError);
});

// ---------------------------------------------------------------------------
// logout() deletes the token ON THE CLOUD
// ---------------------------------------------------------------------------

test("logout deletes the token on the cloud", async () => {
  const { client, f } = makeClient({ del: makeResponse({ status: 204 }) });
  client.token = "nxcdb-t";
  await client.logout();
  assert.equal(f.calls.deleteUrl, "https://nxvms.com/cdb/oauth2/token/nxcdb-t");
  assert.equal(client.token, null);
});

// ---------------------------------------------------------------------------
// config + table
// ---------------------------------------------------------------------------

test("config reads the site id (env beats file)", () => {
  const args = { cloudHost: null, user: null, password: null, siteId: null, mfaCode: null };
  const config = resolveConfig(args, { NX_CLOUD_SITE_ID: "file-sys" }, { NX_CLOUD_SITE_ID: "env-sys" });
  assert.equal(config.siteId, "env-sys");
});

test("formatCamerasTable renders rows and the empty case", () => {
  assert.ok(formatCamerasTable([{ name: "Lobby" }]).includes("Lobby"));
  assert.ok(formatCamerasTable([]).includes("No cameras"));
});
