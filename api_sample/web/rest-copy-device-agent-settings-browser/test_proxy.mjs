// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for proxy.mjs. No outside network: the upstream fetch is
 * injected, or the upstream is a throwaway server on 127.0.0.1.
 *
 * Run from this folder:  node --test test_proxy.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  createProxyHandler,
  BAD_REQUEST,
  NO_SERVER_HOST,
  PROXY_ERROR,
  UPSTREAM_ERROR_HEADER,
  UPSTREAM_TIMEOUT,
  UPSTREAM_TIMEOUT_SECONDS_HEADER,
} from "./proxy.mjs";
import {
  NxDeviceAgentSettingsClient,
  UnknownOutcomeError,
  runSession,
} from "./nx-device-agent-settings-client.mjs";

const HOST = "https://192.168.1.10:7001";
const SETTINGS = "/server/rest/v4/analytics/engines/e/deviceAgents/d/settings";

/** A fake request. `body` is delivered through the usual data/end events. */
function fakeReq(url, method = "GET", headers = {}, body = null) {
  const handlers = {};
  const req = {
    url,
    method,
    headers,
    on(event, fn) {
      handlers[event] = fn;
      if (handlers.data && handlers.end) {
        if (body) handlers.data(Buffer.from(body));
        handlers.end();
      }
      return req;
    },
  };
  return req;
}

/** A fake response that records the status, headers and the ended body. */
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

/** An upstream that answers with the given JSON body. */
function upstreamOf(json, { status = 200, contentType = "application/json" } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
    });
    const text = JSON.stringify(json ?? {});
    return {
      status,
      headers: { get: (n) => (String(n).toLowerCase() === "content-type" ? contentType : null) },
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
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

test("the root path falls through too", async () => {
  const handle = createProxyHandler({ serverHost: HOST });
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/"), res), false);
});

test("a /server route with no configured server host returns a clear 502 NO_SERVER_HOST", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();

  assert.equal(await handle(fakeReq("/server/rest/v4/analytics/engines/e/deviceAgents/d/settings"), res), true);
  assert.equal(res.statusCode, 502);
  assert.equal(res.headers[UPSTREAM_ERROR_HEADER], NO_SERVER_HOST);
  assert.match(res.body, /--server-host/);
});

test("the bare /server route is also owned by the proxy", async () => {
  const handle = createProxyHandler();
  const res = fakeRes();
  assert.equal(await handle(fakeReq("/server"), res), true);
  assert.equal(res.statusCode, 502);
});

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

test("it forwards /server/* to the configured host with the path preserved", async () => {
  const { fetchImpl, calls } = upstreamOf({});
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });

  await handle(fakeReq("/server/rest/v4/analytics/engines/e/deviceAgents/d/settings"), fakeRes());

  assert.equal(calls[0].url, `${HOST}/rest/v4/analytics/engines/e/deviceAgents/d/settings`);
});

test("it forwards the Authorization header and drops hop-by-hop ones", async () => {
  const { fetchImpl, calls } = upstreamOf({});
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });

  await handle(
    fakeReq("/server/rest/v4/analytics/engines/e/deviceAgents/d/settings", "GET", {
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

test("it forwards a PUT body unchanged", async () => {
  const { fetchImpl, calls } = upstreamOf({});
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const body = JSON.stringify({ values: { sensitivity: 50 } });

  await handle(
    fakeReq("/server/rest/v4/analytics/engines/e/deviceAgents/d/settings", "PUT", {}, body),
    fakeRes(),
  );

  assert.equal(calls[0].method, "PUT");
  assert.equal(Buffer.from(calls[0].body).toString("utf-8"), body);
});

test("it preserves the upstream status, content type and body", async () => {
  const { fetchImpl } = upstreamOf({ values: { sensitivity: 50 } }, { status: 403 });
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
  const res = fakeRes();

  await handle(fakeReq("/server/rest/v4/analytics/engines/e/deviceAgents/d/settings"), res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(res.body.toString("utf-8")), { values: { sensitivity: 50 } });
});

test("an unreachable server answers 502 readably, naming the socket error", async () => {
  const refused = new TypeError("fetch failed");
  refused.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  const handle = createProxyHandler({
    serverHost: HOST,
    fetchImpl: async () => {
      throw refused;
    },
  });
  const res = fakeRes();

  await handle(fakeReq("/server/rest/v4/analytics/engines/e/deviceAgents/d/settings"), res);

  assert.equal(res.statusCode, 502);
  assert.match(res.body, /Proxy could not reach/);
  assert.equal(res.headers[UPSTREAM_ERROR_HEADER], "ECONNREFUSED");
});

test("fetch is told not to follow redirects", async () => {
  const { fetchImpl, calls } = upstreamOf({});
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl });

  await handle(fakeReq(SETTINGS, "PUT", {}, "{}"), fakeRes());

  assert.equal(calls[0].redirect, "manual");
});

test("a failure while reading the upstream answer is still a clean 502", async () => {
  // The body read used to sit outside the try: a server that dropped
  // mid-answer rejected into the HTTP server's callback.
  const handle = createProxyHandler({
    serverHost: HOST,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => "application/json" },
      arrayBuffer: async () => {
        throw Object.assign(new TypeError("terminated"), {
          cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
        });
      },
    }),
  });
  const res = fakeRes();

  await handle(fakeReq(SETTINGS, "PUT", {}, "{}"), res);

  assert.equal(res.statusCode, 502);
  assert.equal(res.headers[UPSTREAM_ERROR_HEADER], "UND_ERR_SOCKET");
});

test("a fault in the proxy itself answers 500 PROXY_ERROR", async () => {
  const handle = createProxyHandler({ serverHost: HOST, fetchImpl: upstreamOf({}).fetchImpl });
  const res = fakeRes();
  res.on = () => {
    throw new Error("boom");
  };

  await handle(fakeReq(SETTINGS), res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.headers[UPSTREAM_ERROR_HEADER], PROXY_ERROR);
});

// ---------------------------------------------------------------------------
// A browser that goes away mid-request never hangs the proxy
// ---------------------------------------------------------------------------

/** A request that sends part of its body, then fails the given way. */
function brokenReq(how) {
  const req = new EventEmitter();
  Object.assign(req, { url: SETTINGS, method: "PUT", headers: {} });
  setImmediate(() => {
    req.emit("data", Buffer.from('{"val'));
    if (how === "error") req.emit("error", new Error("socket hang up"));
    if (how === "aborted") req.emit("aborted");
    if (how === "close") req.emit("close");
  });
  return req;
}

for (const how of ["error", "aborted", "close"]) {
  test(`a request body cut off by '${how}' answers 400 and calls nothing upstream`, async () => {
    const { fetchImpl, calls } = upstreamOf({});
    const handle = createProxyHandler({ serverHost: HOST, fetchImpl });
    const res = fakeRes();

    await handle(brokenReq(how), res);

    assert.equal(res.statusCode, 400);
    assert.equal(res.headers[UPSTREAM_ERROR_HEADER], BAD_REQUEST);
    assert.match(res.body, /could not read the request/);
    assert.equal(calls.length, 0);
  });
}

test("a browser that leaves while the server is thinking cancels the upstream call", async () => {
  let signal = null;
  const handle = createProxyHandler({
    serverHost: HOST,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        signal = init.signal;
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const res = new EventEmitter();
  let wrote = false;
  res.writeHead = () => {
    wrote = true;
  };
  res.end = () => {
    wrote = true;
  };
  res.writableFinished = false;
  const done = handle(fakeReq(SETTINGS, "PUT", {}, "{}"), res);
  await new Promise((r) => setImmediate(r));

  res.destroyed = true;
  res.emit("close");
  await done;

  assert.equal(signal.aborted, true);
  assert.equal(wrote, false, "nothing is written to a closed socket");
});

test("a server that takes the request and goes silent gets a 504 UPSTREAM_TIMEOUT", async () => {
  const handle = createProxyHandler({
    serverHost: HOST,
    upstreamTimeoutMs: 50,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      }),
  });
  const res = fakeRes();

  await handle(fakeReq(SETTINGS, "PUT", {}, "{}"), res);

  assert.equal(res.statusCode, 504);
  assert.equal(res.headers[UPSTREAM_ERROR_HEADER], UPSTREAM_TIMEOUT);
  // The seconds the proxy waited, so the page can say "no answer within N s".
  assert.equal(res.headers[UPSTREAM_TIMEOUT_SECONDS_HEADER], "0.05");
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
    upstreamUrl: up.url,
    close() {
      for (const { server } of [up, px]) {
        server.closeAllConnections();
        server.close();
      }
    },
  };
}

/** The page's client, pointed at the proxy, already logged in. */
function clientVia(proxyUrl) {
  const client = new NxDeviceAgentSettingsClient({ baseUrl: proxyUrl });
  client.token = "tok-1";
  return client;
}

test("a redirect is passed back without its Location, and not followed", async () => {
  const seen = [];
  const px = await viaProxy((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    req.on("end", () => {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    });
  });
  try {
    await assert.rejects(
      () => clientVia(px.url).applySettings("e", "d", {}, { confirmed: true }),
      /HTTP 302 \(redirect not followed\)/,
    );
    assert.deepEqual(seen, ["PUT /rest/v4/analytics/engines/e/deviceAgents/d/settings"]);
  } finally {
    px.close();
  }
});

test("a server that drops the connection after taking the PUT is an unknown outcome", async () => {
  const px = await viaProxy((req) => {
    req.resume();
    req.on("end", () => req.socket.destroy());
  });
  try {
    await assert.rejects(
      () => clientVia(px.url).applySettings("e", "d", { values: {} }, { confirmed: true }),
      UnknownOutcomeError,
    );
  } finally {
    px.close();
  }
});

test("a server that never answers the PUT is an unknown outcome", async () => {
  const px = await viaProxy((req) => req.resume(), { upstreamTimeoutMs: 200 });
  try {
    await assert.rejects(
      () => clientVia(px.url).applySettings("e", "d", { values: {} }, { confirmed: true }),
      UnknownOutcomeError,
    );
  } finally {
    px.close();
  }
});

test("a server that is not listening means the settings were not applied", async () => {
  // Point the proxy at a port nothing listens on.
  const dead = await listen(() => {});
  const deadUrl = dead.url;
  dead.server.close();
  const handle = createProxyHandler({ serverHost: deadUrl });
  const front = await listen((req, res) => handle(req, res));
  try {
    await assert.rejects(
      () => clientVia(front.url).applySettings("e", "d", {}, { confirmed: true }),
      (err) => {
        assert.ok(!(err instanceof UnknownOutcomeError));
        assert.match(err.message, /^Could not reach the server \(ECONNREFUSED\)\. The settings were not applied\.$/);
        return true;
      },
    );
  } finally {
    front.server.closeAllConnections();
    front.server.close();
  }
});

/** The real proxy with no options (no --server-host), in a real HTTP server. */
async function unconfiguredProxy() {
  const handle = createProxyHandler();
  return listen((req, res) => handle(req, res));
}

const NO_SERVER_MESSAGE = "No VMS server configured. Restart server.mjs with --server-host https://<ip>:7001.";

test("with no --server-host, login says so, not \"Login failed: HTTP 502\"", async () => {
  const front = await unconfiguredProxy();
  try {
    const result = await runSession(
      new NxDeviceAgentSettingsClient({ baseUrl: front.url }),
      { user: "admin", password: "secret" },
      async () => "never",
    );
    assert.deepEqual(result, { ok: false, message: NO_SERVER_MESSAGE });
  } finally {
    front.server.closeAllConnections();
    front.server.close();
  }
});

test("with no --server-host, apply says so, and that nothing was applied", async () => {
  const front = await unconfiguredProxy();
  try {
    await assert.rejects(() => clientVia(front.url).applySettings("e", "d", {}, { confirmed: true }), {
      message: `${NO_SERVER_MESSAGE} The settings were not applied.`,
    });
  } finally {
    front.server.closeAllConnections();
    front.server.close();
  }
});

// ---------------------------------------------------------------------------
// server.mjs flags
// ---------------------------------------------------------------------------

const SERVER_MJS = fileURLToPath(new URL("./server.mjs", import.meta.url));

function runServer(args) {
  // A run that wrongly starts listening is killed by the timeout, not left.
  // NODE_USE_SYSTEM_CA is dropped: with it set, Node 22 reads the OS
  // certificate store at startup, which can push the child past the 5 s
  // timeout before it even parses its flags; these runs never open a TLS
  // connection. NODE_TEST_CONTEXT is dropped too, as these children are
  // plain runs of server.mjs, not test-runner children.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_USE_SYSTEM_CA;
  return spawnSync(process.execPath, [SERVER_MJS, ...args], { encoding: "utf-8", timeout: 5000, env });
}

for (const [args, code, message] of [
  [["--insecure=no"], 2, /ERROR: --insecure takes no value/],
  [["--insecure=yes"], 2, /ERROR: --insecure takes no value/],
  [["--port"], 2, /ERROR: Missing value for --port/],
  [["--port="], 2, /ERROR: Missing value for --port/],
  [["--server-host", "--insecure"], 2, /ERROR: Missing value for --server-host/],
  [["--port", "eighty"], 2, /ERROR: --port must be a number/],
  [["--bogus"], 2, /ERROR: unknown argument: --bogus/],
  [["--server-host", "192.168.1.10:7001"], 1, /ERROR: --server-host must be a URL/],
]) {
  test(`server.mjs ${args.join(" ")} exits ${code} with a one-line error`, () => {
    const run = runServer(args);
    assert.equal(run.status, code);
    assert.match(run.stderr, message);
    assert.doesNotMatch(run.stderr, /\n\s+at /, "no stack trace");
  });
}
