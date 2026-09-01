// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs — the routing decisions only (no network).
 *
 * The forwarding path (a valid /server call) reaches the real upstream via
 * fetch, so it isn't exercised here; we test the route dispatch and the
 * "no server configured" guard that happen BEFORE any network call.
 *
 * Run from this folder:  node --test test_proxy.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createProxyHandler, suppressTlsWarning } from "./proxy.mjs";

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
  const handle = createProxyHandler({ serverHost: "https://192.168.1.10:7001" });
  const res = fakeRes();
  const handled = await handle(fakeReq("/index.html"), res);
  assert.equal(handled, false);
  assert.equal(res.ended, false); // nothing written; caller serves the file
});

test("the root path falls through too", async () => {
  const handle = createProxyHandler({ serverHost: "https://192.168.1.10:7001" });
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/"), res), false);
});

test("a /server route with no configured server host returns a clear 502", async () => {
  const handle = createProxyHandler(); // no serverHost
  const res = fakeRes();
  const handled = await handle(fakeReq("/server/rest/v4/devices"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /--server-host/);
});

test("the bare /server route is also owned by the proxy", async () => {
  const handle = createProxyHandler(); // no serverHost -> 502 before any network
  const res = fakeRes();
  const handled = await handle(fakeReq("/server"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 502);
});

// ---------------------------------------------------------------------------
// TLS warning suppression (used only by the --insecure fallback path)
// ---------------------------------------------------------------------------

test("suppressTlsWarning hides only the NODE_TLS_REJECT_UNAUTHORIZED warning", () => {
  const original = process.emitWarning;
  try {
    const seen = [];
    process.emitWarning = (warning) => seen.push(String(warning));

    suppressTlsWarning();

    process.emitWarning(
      "Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' ...",
    );
    process.emitWarning("something else entirely");

    // The TLS one is swallowed; anything else still gets through.
    assert.deepEqual(seen, ["something else entirely"]);

    // Calling it again must not stack another wrapper.
    const afterFirst = process.emitWarning;
    suppressTlsWarning();
    assert.equal(process.emitWarning, afterFirst);
  } finally {
    process.emitWarning = original;
  }
});
