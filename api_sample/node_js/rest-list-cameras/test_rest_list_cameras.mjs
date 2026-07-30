// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for rest_list_cameras.mjs. No network, no server needed.
 *
 * Run from this folder:  node --test test_rest_list_cameras.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxServerClient,
  formatCamerasTable,
  resolveConfig,
  AuthError,
  ApiError,
} from "./rest_list_cameras.mjs";

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

/** Serves one queued response per verb; records calls (incl. DELETE count). */
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

function makeClient(fetchOpts = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxServerClient("https://srv:7001", "admin", "pw", { fetchImpl: f });
  return { client, f };
}

// ---------------------------------------------------------------------------
// login() — uses the latest /rest/v4
// ---------------------------------------------------------------------------

test("login posts credentials to v4 and stores the token", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { token: "abc123" } }) });
  const token = await client.login();
  assert.equal(token, "abc123");
  assert.equal(f.calls.post.url, "https://srv:7001/rest/v4/login/sessions");
  assert.deepEqual(f.calls.post.body, { username: "admin", password: "pw", setCookie: false });
});

test("login unauthorized raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 401, text: "bad" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("login without a token raises ApiError", async () => {
  const { client } = makeClient({ post: makeResponse({ json: { nope: 1 } }) });
  await assert.rejects(() => client.login(), ApiError);
});

// ---------------------------------------------------------------------------
// listCameras()
// ---------------------------------------------------------------------------

test("listCameras returns a plain array and hits v4 /devices", async () => {
  const payload = [{ id: "c1", name: "Lobby", status: "Online", model: "Axis" }];
  const { client, f } = makeClient({ get: makeResponse({ json: payload }) });
  client.token = "abc123";
  const cams = await client.listCameras();
  assert.equal(cams[0].name, "Lobby");
  assert.equal(f.calls.get.url, "https://srv:7001/rest/v4/devices");
  assert.equal(f.calls.get.headers.Authorization, "Bearer abc123");
});

test("listCameras unwraps a reply envelope", async () => {
  const { client } = makeClient({ get: makeResponse({ json: { reply: [{ id: "c1", name: "Lobby" }] } }) });
  client.token = "abc123";
  const cams = await client.listCameras();
  assert.equal(cams.length, 1);
  assert.equal(cams[0].name, "Lobby");
});

test("listCameras without login raises", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.listCameras(), ApiError);
});

// ---------------------------------------------------------------------------
// logout()
// ---------------------------------------------------------------------------

test("logout deletes the v4 session and clears the token", async () => {
  const { client, f } = makeClient({ del: makeResponse({ json: {} }) });
  client.token = "abc123";
  await client.logout();
  assert.equal(f.calls.deleteCalls, 1);
  assert.equal(f.calls.deleteUrl, "https://srv:7001/rest/v4/login/sessions/abc123");
  assert.equal(client.token, null);
});

test("logout without a token is a no-op", async () => {
  const { client, f } = makeClient();
  await client.logout();
  assert.equal(f.calls.deleteCalls, 0);
});

// ---------------------------------------------------------------------------
// config + table
// ---------------------------------------------------------------------------

test("config uses the NX_SERVER_* vars (env beats file)", () => {
  const args = { host: null, user: null, password: null };
  const config = resolveConfig(args, { NX_SERVER_HOST: "https://file:7001" }, { NX_SERVER_HOST: "https://env:7001" });
  assert.equal(config.host, "https://env:7001");
});

test("formatCamerasTable renders rows and the empty case", () => {
  const out = formatCamerasTable([{ id: "c1", name: "Lobby", status: "Online", model: "Axis" }]);
  assert.ok(out.includes("NAME") && out.includes("Lobby"));
  assert.ok(formatCamerasTable([]).includes("No cameras"));
});
