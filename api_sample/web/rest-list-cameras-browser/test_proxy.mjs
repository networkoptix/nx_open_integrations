// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs — the routing decisions only (no network).
 *
 * The forwarding paths (/cloud, valid /relay) call the real upstream via fetch,
 * so they aren't exercised here; we test the route dispatch and validation that
 * happen BEFORE any network call.
 *
 * Run from this folder:  node --test test_proxy.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createProxyHandler, RELAY_SUFFIX } from "./proxy.mjs";

function fakeReq(url, method = "GET") {
  return { url, method, headers: {} };
}

function fakeRes() {
  const res = { statusCode: null, headers: null, body: null, ended: false };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (body) => {
    res.body = body;
    res.ended = true;
  };
  return res;
}

test("RELAY_SUFFIX is the expected relay domain", () => {
  assert.equal(RELAY_SUFFIX, ".relay.vmsproxy.com");
});

test("a non-proxy route is not handled (falls through to static)", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  const handled = await handle(fakeReq("/index.html"), res);
  assert.equal(handled, false);
  assert.equal(res.ended, false); // nothing written; caller serves the file
});

test("the root path falls through too", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/"), res), false);
});

test("a relay route with a non-UUID site id is rejected with 400", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  const handled = await handle(fakeReq("/relay/not-a-uuid/rest/v4/devices"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /siteId/);
});

test("an empty relay site id is rejected with 400", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  const handled = await handle(fakeReq("/relay/"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
});
