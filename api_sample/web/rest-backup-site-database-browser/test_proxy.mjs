// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs. No network: the upstream fetch is injected.
 *
 * The other web samples test only the route dispatch, because their proxies
 * call the global fetch and their forwarding path is therefore unreachable
 * from a test. This proxy's two reasons for existing, streaming the dump and
 * reporting the upstream socket error, both live in that path, so it takes an
 * injected fetch and the path is covered here.
 *
 * Run from this folder:  node --test test_proxy.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import http from "node:http";

import { createProxyHandler, UPSTREAM_ERROR_HEADER, CONFIG_ROUTE } from "./proxy.mjs";
import { NxBackupClient } from "./nx-backup-client.mjs";

const HOST = "https://192.168.1.10:7001";

/** A fake request. `body` is delivered through the usual data/end events. */
function fakeReq(url, method = "GET", headers = {}, body = null) {
  const handlers = {};
  const req = {
    url,
    method,
    headers,
    on(event, fn) {
      handlers[event] = fn;
      // Deliver as soon as both handlers are attached.
      if (handlers.data && handlers.end) {
        if (body) handlers.data(Buffer.from(body));
        handlers.end();
      }
      return req;
    },
  };
  return req;
}

/** A fake response that records the status, headers and every written chunk. */
function fakeRes() {
  const chunks = [];
  const res = { statusCode: null, headers: null, ended: false, writes: 0 };
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.write = (chunk) => {
    chunks.push(Buffer.from(chunk));
    res.writes += 1;
    return true;
  };
  res.end = (body) => {
    if (body) chunks.push(Buffer.from(body));
    res.ended = true;
  };
  res.bytes = () => new Uint8Array(Buffer.concat(chunks));
  res.text = () => Buffer.concat(chunks).toString("utf-8");
  return res;
}

/** An upstream that answers with the given byte chunks, as a web stream. */
function upstreamOf(chunks, { status = 200, contentType = "application/octet-stream" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url, method: init.method ?? "GET", headers: init.headers, body: init.body, dispatcher: init.dispatcher,
    });
    return {
      status,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? contentType : null) },
      body: (async function* () {
        for (const c of chunks) yield c;
      })(),
      // Buffering accessors exist but must never be reached: the dump is large.
      arrayBuffer: async () => {
        throw new Error("the proxy must stream the dump, not buffer it");
      },
    };
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// Route dispatch
// ---------------------------------------------------------------------------

test("a non-proxy route is not handled (falls through to static)", async () => {
  const handle = createProxyHandler({ serverHost: HOST });
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/index.html"), res), false);
  assert.equal(res.ended, false);
});

test("a /server route with no configured server host returns a clear 502", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();

  assert.equal(await handle(fakeReq("/server/rest/v4/site/database"), res), true);
  assert.equal(res.statusCode, 502);
  assert.match(res.text(), /--server-host/);
});

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

test("it forwards /server/* to the configured host with the path preserved", async () => {
  const { fetchImpl, calls } = upstreamOf([new Uint8Array([1])]);
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });

  await handle(fakeReq("/server/rest/v4/site/database"), fakeRes());

  assert.equal(calls[0].url, `${HOST}/rest/v4/site/database`);
});

test("it forwards the Authorization header and drops hop-by-hop ones", async () => {
  const { fetchImpl, calls } = upstreamOf([new Uint8Array([1])]);
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });

  await handle(
    fakeReq("/server/rest/v4/site/database", "GET", {
      authorization: "Bearer tok-1",
      host: "localhost:8080",
      connection: "keep-alive",
    }),
    fakeRes(),
  );

  assert.equal(calls[0].headers.authorization, "Bearer tok-1");
  assert.equal("host" in calls[0].headers, false);
  assert.equal("connection" in calls[0].headers, false);
});

test("it forwards a POST body, streamed with its Content-Length", async () => {
  let seen = null;
  const px = await viaProxy((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen = { method: req.method, length: req.headers["content-length"], body: Buffer.concat(chunks) };
      res.writeHead(200);
      res.end();
    });
  });
  try {
    const r = await fetch(`${px.url}/server/rest/v4/site/database`, { method: "POST", body: "a dump" });
    assert.equal(r.status, 200);
    assert.equal(seen.method, "POST");
    assert.equal(seen.length, "6");
    assert.equal(seen.body.toString("utf-8"), "a dump");
  } finally {
    px.close();
  }
});

test("it streams the response instead of buffering it", async () => {
  // The fake upstream throws from arrayBuffer(), so this passes only if the
  // proxy consumes the body as a stream. The multiple writes prove the chunks
  // reach the client as they arrive rather than in one lump at the end.
  const { fetchImpl } = upstreamOf([
    new Uint8Array([1, 1, 1]),
    new Uint8Array([2, 2]),
    new Uint8Array([3]),
  ]);
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const res = fakeRes();

  await handle(fakeReq("/server/rest/v4/site/database"), res);

  assert.deepEqual(Array.from(res.bytes()), [1, 1, 1, 2, 2, 3]);
  assert.equal(res.writes, 3, "each upstream chunk should be written through");
});

test("it preserves the upstream status and content type", async () => {
  const { fetchImpl } = upstreamOf([new Uint8Array([1])], {
    status: 403,
    contentType: "application/json",
  });
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const res = fakeRes();

  await handle(fakeReq("/server/rest/v4/site/database"), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.headers["content-type"], "application/json");
});

// ---------------------------------------------------------------------------
// Reporting why an upstream call died
// ---------------------------------------------------------------------------

test("it names the upstream socket error in a header", async () => {
  // This is what lets the browser tell a post-restore restart apart from a
  // server it could never reach. Without it both look like "Failed to fetch".
  const px = await viaProxy((req) => {
    req.resume();
    req.on("end", () => req.socket.destroy()); // took it all, then restarted
  });
  try {
    const r = await fetch(`${px.url}/server/rest/v4/site/database`, { method: "POST", body: "a dump" });
    assert.equal(r.status, 502);
    assert.equal(r.headers.get(UPSTREAM_ERROR_HEADER), "ECONNRESET");
  } finally {
    px.close();
  }
});

test("an unreachable server answers 502 readably, with no error marker", async () => {
  const handle = createProxyHandler({
    serverHost: HOST,
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  const res = fakeRes();

  await handle(fakeReq("/server/rest/v4/site/database"), res);

  assert.equal(res.statusCode, 502);
  assert.match(res.text(), /Proxy could not reach/);
  assert.equal(UPSTREAM_ERROR_HEADER in res.headers, false);
});

// ---------------------------------------------------------------------------
// The configured server, for the page
// ---------------------------------------------------------------------------

test("/config.json tells the page which server it talks to", async () => {
  const { fetchImpl, calls } = upstreamOf([]);
  const handle = createProxyHandler({ serverHost: `${HOST}/`, fetchImpl });
  const res = fakeRes();
  assert.equal(await handle(fakeReq(CONFIG_ROUTE), res), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.text()), { serverHost: HOST });
  // Answered locally, never forwarded.
  assert.deepEqual(calls, []);
});

test("/config.json answers an empty address when no server is configured", async () => {
  const handle = createProxyHandler({});
  const res = fakeRes();
  await handle(fakeReq(CONFIG_ROUTE), res);
  assert.deepEqual(JSON.parse(res.text()), { serverHost: "" });
});

// ---------------------------------------------------------------------------
// Failures midway, and a browser that reads slowly or leaves
// ---------------------------------------------------------------------------

/** A fake response that is also an EventEmitter, for drain and close. */
function eventfulRes({ full = false } = {}) {
  // Delegate to fakeRes rather than copying it: its methods update their own
  // object, so copied fields such as `ended` would never change.
  const inner = fakeRes();
  const res = new EventEmitter();
  res.destroyed = false;
  res.destroyedWith = undefined;
  res.full = false;
  Object.defineProperty(res, "ended", { get: () => inner.ended });
  Object.defineProperty(res, "statusCode", { get: () => inner.statusCode });
  res.writeHead = (...args) => inner.writeHead(...args);
  res.end = (body) => inner.end(body);
  res.bytes = () => inner.bytes();
  res.write = (chunk) => {
    // A write while the last one is still waiting for drain is the bug.
    assert.equal(res.full, false, "wrote again before the browser drained");
    inner.write(chunk);
    if (!full) return true;
    res.full = true;
    return false;
  };
  res.destroy = (err) => {
    res.destroyed = true;
    res.destroyedWith = err;
    res.emit("close");
  };
  return res;
}

/** An upstream whose body yields `chunks` and then throws `error`. */
function upstreamThatDrops(chunks, error) {
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: () => "application/octet-stream" },
    body: (async function* () {
      for (const c of chunks) yield c;
      throw error;
    })(),
  });
  return { fetchImpl };
}

test("a dump cut off upstream breaks the browser's connection instead of ending it", async () => {
  // A clean end() would hand the browser a truncated dump that looks complete.
  const cut = Object.assign(new TypeError("terminated"), { code: "UND_ERR_SOCKET" });
  const { fetchImpl } = upstreamThatDrops([new Uint8Array([1, 2])], cut);
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const res = eventfulRes();

  assert.equal(await handle(fakeReq("/server/rest/v4/site/database"), res), true);

  assert.equal(res.destroyed, true);
  assert.equal(res.destroyedWith, cut);
  assert.equal(res.ended, false);
});

test("a request that errors mid-upload does not reject into the dev server", async () => {
  // An unhandled rejection in the http.createServer callback stops the server.
  const req = Object.assign(new EventEmitter(), {
    url: "/server/rest/v4/site/database",
    method: "POST",
    headers: {},
  });
  const { fetchImpl, calls } = upstreamOf([]);
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const res = fakeRes();

  const handled = handle(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  req.emit("error", new Error("aborted"));

  assert.equal(await handled, true);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(calls, [], "nothing half-uploaded is forwarded");
});

test("it waits for the browser to drain before writing more", async () => {
  const { fetchImpl } = upstreamOf([new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])]);
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const res = eventfulRes({ full: true });
  const drainer = setInterval(() => {
    if (res.full) {
      res.full = false;
      res.emit("drain");
    }
  }, 1);

  try {
    await handle(fakeReq("/server/rest/v4/site/database"), res);
  } finally {
    clearInterval(drainer);
  }

  assert.deepEqual(Array.from(res.bytes()), [1, 2, 3]);
  assert.equal(res.ended, true);
});

test("a browser that leaves mid-dump stops the upstream read", async () => {
  let produced = 0;
  let cancelled = false;
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: () => "application/octet-stream" },
    body: (async function* () {
      try {
        for (;;) {
          produced += 1;
          yield new Uint8Array([produced]);
        }
      } finally {
        cancelled = true;
      }
    })(),
  });
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const res = eventfulRes({ full: true });
  // The first write fills the pipe; then the tab closes instead of draining.
  setImmediate(() => res.destroy());

  await handle(fakeReq("/server/rest/v4/site/database"), res);

  assert.equal(cancelled, true);
  assert.equal(produced, 1);
});

test("--insecure turns certificate checks off for this process, and nothing else", async () => {
  // No undici import, no dispatcher: stock Node cannot load undici, so the old
  // attempt always failed over to this anyway.
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const { fetchImpl, calls } = upstreamOf([new Uint8Array([1])]);
  try {
    const handle = createProxyHandler({ serverHost: HOST, insecure: true, fetchImpl });
    await handle(fakeReq("/server/rest/v4/site/database"), fakeRes());
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
    assert.equal(calls[0].dispatcher, undefined);
  } finally {
    if (before === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = before;
  }
});

// ---------------------------------------------------------------------------
// The real forwarding path: a loopback upstream behind the proxy
// ---------------------------------------------------------------------------

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

/** The real proxy, in a real HTTP server, in front of a loopback upstream. */
async function viaProxy(upstreamHandler, options = {}) {
  const up = await listen(upstreamHandler);
  const handle = createProxyHandler({ serverHost: up.url, ...options });
  const px = await listen((req, res) => handle(req, res));
  return {
    url: px.url,
    close() {
      for (const { server } of [up, px]) {
        server.closeAllConnections();
        server.close();
      }
    },
  };
}

/** The page's client, pointed at the proxy. */
function clientVia(proxyUrl) {
  const client = new NxBackupClient({ baseUrl: proxyUrl });
  client.token = "tok-1";
  return client;
}

const DUMP = new Blob([new Uint8Array(1024 * 1024).fill(7)]);

test("an upload cut off partway is reported as not applied, never as a restart", async () => {
  const px = await viaProxy((req) => {
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n >= 64 * 1024) req.socket.destroy();
    });
  });
  try {
    const r = await fetch(`${px.url}/server/rest/v4/site/database`, { method: "POST", body: DUMP });
    assert.equal(r.headers.get(UPSTREAM_ERROR_HEADER), "UPLOAD_INCOMPLETE");
    await assert.rejects(
      () => clientVia(px.url).restoreDatabase(DUMP, { confirmed: true }),
      /not applied/,
    );
  } finally {
    px.close();
  }
});

test("a server that took the upload and went silent is an unknown outcome", async () => {
  const px = await viaProxy((req) => req.resume(), { uploadIdleMs: 200 });
  try {
    await assert.rejects(
      () => clientVia(px.url).restoreDatabase(DUMP, { confirmed: true }),
      /may have loaded it/,
    );
  } finally {
    px.close();
  }
});

test("a redirect on the restore POST is passed back, not followed", async () => {
  // Followed, a 302 turns the POST into a GET of the dump, which answers 200.
  const seen = [];
  const px = await viaProxy((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(302, { location: "/rest/v4/site/database" });
      res.end();
    });
  });
  try {
    await assert.rejects(
      () => clientVia(px.url).restoreDatabase(DUMP, { confirmed: true }),
      /HTTP 302/,
    );
    assert.deepEqual(seen, ["POST /rest/v4/site/database"]);
  } finally {
    px.close();
  }
});

test("a redirect on a GET is passed back, not followed", async () => {
  const seen = [];
  const px = await viaProxy((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(302, { location: "/elsewhere" });
    res.end();
  });
  try {
    const r = await fetch(`${px.url}/server/rest/v4/site/database`, { redirect: "manual" });
    assert.equal(r.status, 302);
    assert.deepEqual(seen, ["GET /rest/v4/site/database"]);
  } finally {
    px.close();
  }
});

test("a browser that left before the next write stops the upstream read", async () => {
  // A real response that has closed fires 'close' once and never again, and
  // write() then returns false: waiting for drain or close would wait forever.
  let produced = 0;
  let cancelled = false;
  const fetchImpl = async () => ({
    status: 200,
    headers: { get: () => "application/octet-stream" },
    body: (async function* () {
      try {
        for (;;) {
          produced += 1;
          yield new Uint8Array([produced]);
        }
      } finally {
        cancelled = true;
      }
    })(),
  });
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const res = eventfulRes();
  const write = res.write;
  res.write = (chunk) => {
    write(chunk);
    res.destroyed = true; // closed, and 'close' already fired: no event follows
    return false;
  };

  await handle(fakeReq("/server/rest/v4/site/database"), res);

  assert.equal(cancelled, true);
  assert.equal(produced, 1);
});
