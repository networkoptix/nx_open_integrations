// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs — route dispatch, header forwarding (the bearer
 * the page sends), the relay 307 hop with the method + JSON body + bearer
 * re-attached, and body passthrough. No real network: we stub the global fetch
 * with a FAKE UPSTREAM so we can inspect exactly what the proxy would have sent
 * to Nx.
 *
 * Run from this folder:  node --test test_proxy.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";

import { createProxyHandler, extractAuth, RELAY_SUFFIX } from "./proxy.mjs";

// A fake Node request. Non-GET/HEAD methods stream the given body to readBody().
function fakeReq(url, method = "GET", body = "", headers = {}) {
  const req = { url, method, headers };
  req.on = (event, cb) => {
    if (event === "data" && body) cb(Buffer.from(body));
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
 * Install a fake global fetch that records each call (URL, method, headers,
 * body) and returns scripted responses in order. Returns { calls, restore }.
 */
function stubFetch(responses) {
  const original = globalThis.fetch;
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({
      url: String(url),
      init,
      method: init.method,
      headers: init.headers || {},
      body: init.body ? init.body.toString() : null,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof r === "function" ? r() : r;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// Wait a tick for the streamed pipe to finish writing into fakeRes.
const settle = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// extractAuth unit (kept for parity with the other web samples' proxies)
// ---------------------------------------------------------------------------

test("extractAuth pulls the token and removes it from the path", () => {
  const out = extractAuth("/rest/v4/events/rules?foo=1&auth=TOK&bar=2");
  assert.equal(out.token, "TOK");
  assert.equal(out.path, "/rest/v4/events/rules?foo=1&bar=2");
});

test("extractAuth with no query leaves the path alone", () => {
  const out = extractAuth("/rest/v4/events/rules");
  assert.equal(out.token, null);
  assert.equal(out.path, "/rest/v4/events/rules");
});

test("extractAuth with a query but no auth keeps it intact", () => {
  const out = extractAuth("/x?foo=1");
  assert.equal(out.token, null);
  assert.equal(out.path, "/x?foo=1");
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
  const handled = await handle(fakeReq("/server/rest/v4/events/rules"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /serverBaseUrl/);
});

test("a /relay route with a non-UUID site id is rejected with 400", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  const handled = await handle(fakeReq("/relay/not-a-uuid/rest/v4/events/rules"), res);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /siteId/);
});

// ---------------------------------------------------------------------------
// GET listing (direct): the encoded base is decoded + forwarded, and the page's
// Authorization header is passed through verbatim.
// ---------------------------------------------------------------------------

test("direct GET: encoded base is decoded + forwarded, bearer header passed through", async () => {
  const SERVER = "https://192.168.1.10:7001";
  const SEG = encodeURIComponent(SERVER);
  const { calls, restore } = stubFetch([
    upstreamResponse({ status: 200, headers: { "content-type": "application/json" }, body: "[]" }),
  ]);
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    const handled = await handle(
      fakeReq(`/server/${SEG}/rest/v4/events/rules`, "GET", "", { authorization: "Bearer TOK1" }),
      res,
    );
    await settle();
    assert.equal(handled, true);
    const sent = calls[0];
    assert.equal(sent.url, `${SERVER}/rest/v4/events/rules`);
    assert.equal(sent.headers.authorization, "Bearer TOK1");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "[]");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// PATCH forwarding (direct): the method AND the JSON body AND the bearer must
// all reach the upstream unchanged.
// ---------------------------------------------------------------------------

test("direct PATCH: method + JSON body + bearer are forwarded to the decoded base", async () => {
  const SERVER = "https://192.168.1.10:7001";
  const SEG = encodeURIComponent(SERVER);
  const PAYLOAD = JSON.stringify({ schedule: [{ dayOfWeek: 1, startTime: 0, endTime: 86400 }] });
  const { calls, restore } = stubFetch([
    upstreamResponse({ status: 200, headers: { "content-type": "application/json" }, body: "{}" }),
  ]);
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    const handled = await handle(
      fakeReq(`/server/${SEG}/rest/v4/events/rules/r1`, "PATCH", PAYLOAD, {
        authorization: "Bearer TOK1",
        "content-type": "application/json",
      }),
      res,
    );
    await settle();
    assert.equal(handled, true);
    const sent = calls[0];
    assert.equal(sent.url, `${SERVER}/rest/v4/events/rules/r1`);
    assert.equal(sent.method, "PATCH");
    assert.equal(sent.headers.authorization, "Bearer TOK1");
    assert.equal(sent.body, PAYLOAD);
    assert.equal(res.statusCode, 200);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Cloud (/relay) PATCH: the relay's 307 must be followed server-side with the
// method + JSON body + bearer ALL re-attached on the second hop.
// ---------------------------------------------------------------------------

test("cloud PATCH: relay 307 hop re-attaches the method, body, and bearer", async () => {
  const SITE = "11111111-2222-3333-4444-555555555555";
  const PAYLOAD = JSON.stringify({ schedule: [] });
  const redirected = {
    status: 307,
    headers: {
      get: (k) =>
        k.toLowerCase() === "location"
          ? "https://node-7.relay.vmsproxy.com/rest/v4/events/rules/r1"
          : null,
    },
    body: null,
  };
  const final = upstreamResponse({ status: 200, headers: { "content-type": "application/json" }, body: "{}" });
  const { calls, restore } = stubFetch([redirected, final]);
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    const handled = await handle(
      fakeReq(`/relay/${SITE}/rest/v4/events/rules/r1`, "PATCH", PAYLOAD, {
        authorization: "Bearer CLOUDTOK",
        "content-type": "application/json",
      }),
      res,
    );
    await settle();
    assert.equal(handled, true);

    // First hop: to the site relay, method/body/bearer present, redirect manual.
    assert.equal(calls[0].url, `https://${SITE}.relay.vmsproxy.com/rest/v4/events/rules/r1`);
    assert.equal(calls[0].method, "PATCH");
    assert.equal(calls[0].headers.authorization, "Bearer CLOUDTOK");
    assert.equal(calls[0].body, PAYLOAD);
    assert.equal(calls[0].init.redirect, "manual");

    // Second hop: follows the 307, RE-ATTACHING method + body + bearer.
    assert.equal(calls[1].url, "https://node-7.relay.vmsproxy.com/rest/v4/events/rules/r1");
    assert.equal(calls[1].method, "PATCH");
    assert.equal(calls[1].headers.authorization, "Bearer CLOUDTOK");
    assert.equal(calls[1].body, PAYLOAD);

    assert.equal(res.statusCode, 200);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// auth=<token> fallback still works (parity with the other samples' proxies).
// ---------------------------------------------------------------------------

test("an ?auth=<token> query param is converted to a bearer header and stripped", async () => {
  const SITE = "11111111-2222-3333-4444-555555555555";
  const { calls, restore } = stubFetch([
    upstreamResponse({ status: 200, headers: { "content-type": "application/json" }, body: "[]" }),
  ]);
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    await handle(fakeReq(`/relay/${SITE}/rest/v4/events/rules?auth=QTOK`, "GET"), res);
    await settle();
    assert.ok(!calls[0].url.includes("auth="), "auth removed from upstream URL");
    assert.equal(calls[0].headers.authorization, "Bearer QTOK");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// A fetch failure to the upstream surfaces a 502.
// ---------------------------------------------------------------------------

test("a fetch failure to the upstream surfaces a 502", async () => {
  const SEG = encodeURIComponent("https://srv:7001");
  const { restore } = stubFetch([() => { throw new Error("ECONNREFUSED"); }]);
  try {
    const handle = createProxyHandler();
    const res = fakeRes();
    await handle(fakeReq(`/server/${SEG}/rest/v4/login/sessions`, "POST", "{}"), res);
    await settle();
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /could not reach/i);
  } finally {
    restore();
  }
});
