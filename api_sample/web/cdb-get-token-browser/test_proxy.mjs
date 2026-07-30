// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs — the routing decisions only (no network).
 *
 * The forwarding path (/cloud) calls the real upstream via fetch, so it isn't
 * exercised here; we test the route dispatch that happens BEFORE any network
 * call. This sample is cloud-only, so /cloud is the single proxy route.
 *
 * Run from this folder:  node --test test_proxy.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createProxyHandler } from "./proxy.mjs";

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

test("the app module path falls through to static", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/app.mjs"), res), false);
});

test("there is no /relay route in this cloud-only sample", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  // A /relay path is NOT a proxy route here — it must fall through, not 400.
  const handled = await handle(fakeReq("/relay/some-id/rest/v4/devices"), res);
  assert.equal(handled, false);
  assert.equal(res.ended, false);
});
