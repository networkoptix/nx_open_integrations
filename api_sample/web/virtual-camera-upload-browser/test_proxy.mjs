// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs — route decoding + forwarding (no real network).
 *
 * The proxy reads the target VMS server from the request's
 * /server/<encoded-base> segment, so we test:
 *   - decodeServerRoute() splits the encoded base from the sub-path,
 *   - a missing base returns a clear 502,
 *   - a real /server call decodes the base and forwards method + body + the
 *     Authorization: Bearer header (we stub the GLOBAL fetch the proxy uses),
 *   - a PUT body (raw chunk bytes) is forwarded.
 *
 * Run from this folder:  node --test test_proxy.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createProxyHandler, decodeServerRoute } from "./proxy.mjs";

function fakeReq(url, method = "GET", { headers = {}, body = null } = {}) {
  // A minimal readable-ish request: replays an optional body once the proxy's
  // readBody() has registered its 'data'/'end' listeners. We emit on the 'end'
  // registration (readBody adds 'data' then 'end'), so both handlers exist.
  const handlers = {};
  const req = {
    url,
    method,
    headers,
    on(event, cb) {
      handlers[event] = cb;
      if (event === "end") {
        queueMicrotask(() => {
          if (body && handlers.data) handlers.data(Buffer.from(body));
          handlers.end && handlers.end();
        });
      }
      return req;
    },
  };
  return req;
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

const ENC = encodeURIComponent("https://192.168.1.10:7001");

// ---------------------------------------------------------------------------
// decodeServerRoute
// ---------------------------------------------------------------------------

test("decodeServerRoute splits the encoded base from the sub-path (with query)", () => {
  const d = decodeServerRoute(`/server/${ENC}/rest/v4/devices/dev-1/virtual/uploads/up-1?chunk=2`);
  assert.equal(d.base, "https://192.168.1.10:7001");
  assert.equal(d.subPath, "/rest/v4/devices/dev-1/virtual/uploads/up-1?chunk=2");
});

test("decodeServerRoute on a non-proxy route returns null", () => {
  assert.equal(decodeServerRoute("/index.html"), null);
  assert.equal(decodeServerRoute("/"), null);
});

test("decodeServerRoute on a bare /server has an empty base", () => {
  assert.deepEqual(decodeServerRoute("/server"), { base: "", subPath: "/" });
});

// ---------------------------------------------------------------------------
// route dispatch
// ---------------------------------------------------------------------------

test("a non-proxy route is not handled (falls through to static)", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/index.html"), res), false);
  assert.equal(res.ended, false);
});

test("a /server route with no base returns a clear 502", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  const handled = await handle(fakeReq("/server"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /Server address/);
});

// ---------------------------------------------------------------------------
// forwarding: decode base + forward method/body/bearer (stub the global fetch)
// ---------------------------------------------------------------------------

test("forwards method + body + Authorization bearer to the decoded server (POST)", async () => {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (target, options) => {
    captured = { target, options };
    return {
      status: 200,
      headers: { get: () => "application/json" },
      async arrayBuffer() {
        return new TextEncoder().encode('{"id":"dev-1"}').buffer;
      },
    };
  };
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    const reqBody = JSON.stringify({ name: "Cam" });
    const handled = await handle(
      fakeReq(`/server/${ENC}/rest/v4/devices/*/virtual`, "POST", {
        headers: { authorization: "Bearer tok-1", "content-type": "application/json" },
        body: reqBody,
      }),
      res,
    );
    assert.equal(handled, true);
    // Decoded base + sub-path.
    assert.equal(captured.target, "https://192.168.1.10:7001/rest/v4/devices/*/virtual");
    assert.equal(captured.options.method, "POST");
    // Bearer header forwarded.
    assert.equal(captured.options.headers.authorization, "Bearer tok-1");
    // Body forwarded (as a Buffer of the same bytes).
    assert.equal(Buffer.from(captured.options.body).toString(), reqBody);
    assert.equal(res.statusCode, 200);
  } finally {
    globalThis.fetch = original;
  }
});

test("forwards a raw PUT chunk body and bearer to the decoded server", async () => {
  const original = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (target, options) => {
    captured = { target, options };
    return {
      status: 200,
      headers: { get: () => "application/json" },
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    };
  };
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    const chunk = Buffer.from([10, 20, 30, 40, 50]);
    const handled = await handle(
      fakeReq(`/server/${ENC}/rest/v4/devices/dev-1/virtual/uploads/up-1?chunk=0`, "PUT", {
        headers: { authorization: "Bearer tok-1", "content-type": "application/octet-stream" },
        body: chunk,
      }),
      res,
    );
    assert.equal(handled, true);
    assert.equal(captured.target, "https://192.168.1.10:7001/rest/v4/devices/dev-1/virtual/uploads/up-1?chunk=0");
    assert.equal(captured.options.method, "PUT");
    assert.equal(captured.options.headers.authorization, "Bearer tok-1");
    // The raw PUT body bytes are forwarded intact.
    assert.deepEqual(Buffer.from(captured.options.body), chunk);
  } finally {
    globalThis.fetch = original;
  }
});
