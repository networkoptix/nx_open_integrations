// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs — route dispatch, the auth->bearer conversion,
 * the relay 307 hop, and body streaming. No real network: we stub the global
 * fetch with a FAKE UPSTREAM so we can inspect exactly what the proxy would
 * have sent to Nx.
 *
 * Run from this folder:  node --test test_proxy.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { createProxyHandler, extractAuth, RELAY_SUFFIX } from "./proxy.mjs";

function fakeReq(url, method = "GET", body = "") {
  // GET/HEAD never have readBody() called; other methods get a tiny readable.
  const req = { url, method, headers: {} };
  req.on = (event, cb) => {
    if (event === "end") cb();
    return req;
  };
  return req;
}

// A fake response sink that captures status, headers, and (streamed) body.
function fakeRes() {
  const res = new (class {
    constructor() {
      this.statusCode = null;
      this.headers = null;
      this.chunks = [];
      this.ended = false;
    }
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    }
    // Readable.pipe(res) calls write() then end(); plain handlers call end(body).
    write(chunk) {
      if (chunk) this.chunks.push(Buffer.from(chunk));
      return true;
    }
    end(body) {
      if (body) this.chunks.push(Buffer.from(body));
      this.ended = true;
      this.emit?.("finish");
    }
    on() {} // pipe attaches listeners; ignore them
    once() {}
    emit() {}
  })();
  Object.defineProperty(res, "body", {
    get() {
      return Buffer.concat(this.chunks).toString();
    },
  });
  return res;
}

// Build a WHATWG-style Response-like object backed by a streamable body, so the
// proxy's Readable.fromWeb(upstream.body).pipe(res) path is exercised.
function upstreamResponse({ status = 200, headers = {}, body = "" } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (k) => h.get(k.toLowerCase()) ?? null },
    body: Readable.toWeb(Readable.from([Buffer.from(body)])),
  };
}

/**
 * Install a fake global fetch that records each call and returns scripted
 * responses in order. Returns { calls, restore }.
 */
function stubFetch(responses) {
  const original = globalThis.fetch;
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof r === "function" ? r() : r;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Wait a tick for the streamed pipe to finish writing into fakeRes.
const settle = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// extractAuth unit
// ---------------------------------------------------------------------------

test("extractAuth pulls the token and removes it from the path", () => {
  const out = extractAuth("/rest/v4/devices/c1/media.webm?stream=secondary&auth=TOK&positionMs=5");
  assert.equal(out.token, "TOK");
  assert.equal(out.path, "/rest/v4/devices/c1/media.webm?stream=secondary&positionMs=5");
});

test("extractAuth with no query leaves the path alone", () => {
  const out = extractAuth("/rest/v4/devices");
  assert.equal(out.token, null);
  assert.equal(out.path, "/rest/v4/devices");
});

test("extractAuth with a query but no auth keeps it intact", () => {
  const out = extractAuth("/x?stream=primary");
  assert.equal(out.token, null);
  assert.equal(out.path, "/x?stream=primary");
});

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

test("RELAY_SUFFIX is the expected relay domain", () => {
  assert.equal(RELAY_SUFFIX, ".relay.vmsproxy.com");
});

test("a non-proxy route falls through to static", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/index.html"), res), false);
  assert.equal(res.ended, false);
});

test("the root path falls through too", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/"), res), false);
});

test("a /server route whose first segment is not a valid http(s) base is rejected with 400", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  // First segment "rest" is not a URL with a host -> bad request.
  const handled = await handle(fakeReq("/server/rest/v4/devices"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /serverBaseUrl/);
});

test("a /relay route with a non-UUID site id is rejected with 400", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  const handled = await handle(fakeReq("/relay/not-a-uuid/rest/v4/devices"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /siteId/);
});

// ---------------------------------------------------------------------------
// THE KEY ASSERTION: ?auth=<token> -> Authorization: Bearer <token>,
// and the param is removed from the upstream URL. Direct (/server) mode now
// decodes the user-provided base URL from the FIRST path segment and forwards
// there.
// ---------------------------------------------------------------------------

test("direct media: the encoded base is decoded + forwarded, auth becomes a bearer header and is stripped", async () => {
  const SERVER = "https://192.168.1.10:7001";
  const SEG = encodeURIComponent(SERVER);
  const { calls, restore } = stubFetch([
    upstreamResponse({ status: 200, headers: { "content-type": "video/webm" }, body: "WEBMDATA" }),
  ]);
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    const handled = await handle(
      fakeReq(`/server/${SEG}/rest/v4/devices/cam1/media.webm?stream=secondary&auth=TOKEN123`),
      res,
    );
    await settle();
    assert.equal(handled, true);

    const sent = calls[0];
    // The token must NOT be in the upstream URL anymore.
    assert.ok(!sent.url.includes("auth=TOKEN123"), "auth must be removed from the upstream URL");
    // The upstream URL is the DECODED user-provided base + the remaining path.
    assert.equal(sent.url, `${SERVER}/rest/v4/devices/cam1/media.webm?stream=secondary`);
    // It must instead ride as an Authorization header.
    assert.equal(sent.init.headers.authorization, "Bearer TOKEN123");
    // Body streamed straight through.
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["content-type"], "video/webm");
    assert.equal(res.body, "WEBMDATA");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Cloud (/relay) mode: same auth conversion, PLUS the relay's 307 must be
// followed server-side with the bearer re-attached.
// ---------------------------------------------------------------------------

test("cloud media: auth->bearer conversion + relay 307 hop re-attaches the bearer", async () => {
  const SITE = "11111111-2222-3333-4444-555555555555";
  const redirected = {
    status: 307,
    headers: { get: (k) => (k.toLowerCase() === "location" ? "https://node-7.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm?stream=secondary" : null) },
    body: null,
  };
  const final = upstreamResponse({ status: 200, headers: { "content-type": "video/webm" }, body: "STREAMED" });
  const { calls, restore } = stubFetch([redirected, final]);
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    const handled = await handle(
      fakeReq(`/relay/${SITE}/rest/v4/devices/cam1/media.webm?stream=secondary&auth=CLOUDTOK`),
      res,
    );
    await settle();
    assert.equal(handled, true);

    // First hop: to the site relay, no auth in URL, bearer in header.
    assert.equal(calls[0].url, `https://${SITE}.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm?stream=secondary`);
    assert.ok(!calls[0].url.includes("auth="), "auth removed from relay URL");
    assert.equal(calls[0].init.headers.authorization, "Bearer CLOUDTOK");
    assert.equal(calls[0].init.redirect, "manual");

    // Second hop: follows the 307, RE-ATTACHING the same bearer header.
    assert.equal(calls[1].url, "https://node-7.relay.vmsproxy.com/rest/v4/devices/cam1/media.webm?stream=secondary");
    assert.equal(calls[1].init.headers.authorization, "Bearer CLOUDTOK");

    // Final body streamed through.
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "STREAMED");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Non-media calls (login) still forward; a 502 is returned if upstream throws.
// ---------------------------------------------------------------------------

test("a fetch failure to the upstream surfaces a 502", async () => {
  const SEG = encodeURIComponent("https://srv:7001");
  const { restore } = stubFetch([() => { throw new Error("ECONNREFUSED"); }]);
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    await handle(fakeReq(`/server/${SEG}/rest/v4/login/sessions`, "POST"), res);
    await settle();
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /could not reach/i);
  } finally {
    restore();
  }
});
