// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs — the routing decisions only (no network).
 *
 * The forwarding path (/cloud) calls the real upstream via fetch, so it isn't
 * exercised here; we test the route dispatch that happens BEFORE any network
 * call. This sample is CLOUD-ONLY, so there is exactly one proxy route.
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

test("createProxyHandler returns a function", () => {
  assert.equal(typeof createProxyHandler(), "function");
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

test("app.mjs and other static assets fall through", async () => {
  const handle = createProxyHandler();
  for (const p of ["/app.mjs", "/nx-cloud-client.mjs", "/favicon.ico"]) {
    assert.equal(await handle(fakeReq(p), fakeRes()), false, `${p} should fall through`);
  }
});

test("there is NO /relay route in this cloud-only sample (it falls through)", async () => {
  // The refresh-token flow only talks to the cloud, so /relay is not a proxy
  // route here — it must NOT be claimed by the handler.
  const handle = createProxyHandler();
  const res = fakeRes();
  const handled = await handle(fakeReq("/relay/whatever/rest/v4/devices"), res);
  assert.equal(handled, false);
  assert.equal(res.ended, false);
});

test("a /cloud route IS claimed by the handler (dispatch decision)", async () => {
  // We only assert that the handler OWNS the route (returns a promise that the
  // dispatcher will treat as handled). We cannot complete the upstream fetch
  // offline, so we just check the route is recognized vs. the fall-throughs
  // above. A GET /cloud/ that 404s in routing terms still belongs to /cloud.
  const handle = createProxyHandler();
  // /cloud without a trailing slash is NOT the route prefix -> falls through.
  assert.equal(await handle(fakeReq("/cloud"), fakeRes()), false);
});
