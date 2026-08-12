// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for jsonrpc_subscribe_events_cloud_user.mjs. No network, no
 * account, and no real 'ws' socket -- fakeFetch/FakeWebSocket below stand in.
 *
 * Run from this folder:  node --test test_jsonrpc_subscribe_events_cloud_user.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxCloudJsonRpcClient,
  AuthError,
  ApiError,
  toWssUrl,
  msToIso,
  formatEventLine,
  toEventArray,
  resolveConfig,
  parseArgs,
  CLIENT_ID,
  RELAY_SUFFIX,
  MAX_REDIRECTS,
  DEFAULT_MAX_PAYLOAD_BYTES,
  METHOD_SUBSCRIBE,
  METHOD_UNSUBSCRIBE,
} from "./jsonrpc_subscribe_events_cloud_user.mjs";

const SITE = "11111111-2222-3333-4444-555555555555";

// fakeFetch: records the POST (login) / DELETE (logout) calls -- the only
// REST calls this sample makes; the relay hop is resolved at the WS layer.

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

function fakeFetch({ post = null, del = null } = {}) {
  const calls = { post: null, deleteUrl: null, deleteCalls: 0 };
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST") {
      calls.post = { url, body: options.body ? JSON.parse(options.body) : null };
      return post;
    }
    calls.deleteUrl = url;
    calls.deleteCalls += 1;
    return del;
  };
  impl.calls = calls;
  return impl;
}

/** Fetch stand-in whose GET always throws (network/DNS failure). */
function throwingFetch(message = "getaddrinfo ENOTFOUND") {
  return async (url, options = {}) => {
    if ((options.method || "GET").toUpperCase() === "POST") {
      throw new Error(message);
    }
    throw new Error(message);
  };
}

/**
 * Fetch stand-in mimicking undici's real failure shape: a top-level
 * "fetch failed" TypeError whose useful detail lives in `.cause`.
 */
function fetchThrowingWithCause(causeCode, causeMessage) {
  return async () => {
    const err = new TypeError("fetch failed");
    err.cause = new Error(causeMessage);
    err.cause.code = causeCode;
    throw err;
  };
}

// FakeWebSocket: same on()/send()/close() surface as 'ws', plus test hooks

class FakeWebSocket {
  constructor(url, protocols, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.pings = 0;
    this.closed = false;
    this.terminated = false;
    this.handlers = { open: [], message: [], error: [], close: [], "unexpected-response": [] };
    FakeWebSocket.instances.push(this);
  }
  on(event, cb) {
    this.handlers[event].push(cb);
    return this;
  }
  send(data) {
    if (this.closed) throw new Error("send on a closed socket");
    this.sent.push(JSON.parse(data));
  }
  ping() {
    this.pings += 1;
  }
  terminate() {
    this.terminated = true;
  }
  close(code, reason) {
    this.closed = true;
    this.emitClose(code, reason);
  }
  emitOpen() {
    this.handlers.open.forEach((cb) => cb());
  }
  emitMessage(obj) {
    this.handlers.message.forEach((cb) => cb(JSON.stringify(obj)));
  }
  emitError(exc) {
    this.handlers.error.forEach((cb) => cb(exc));
  }
  emitClose(code, reason) {
    this.handlers.close.forEach((cb) => cb(code, reason));
  }
  /** Simulates the relay's redirect (or any non-2xx) response to the upgrade. */
  emitUnexpectedResponse(statusCode, location) {
    const res = { statusCode, headers: { location }, resume: () => {} };
    this.handlers["unexpected-response"].forEach((cb) => cb({}, res));
  }
}
FakeWebSocket.instances = [];

function makeClient(fetchOpts = {}, opts = {}) {
  FakeWebSocket.instances = [];
  const f = fakeFetch(fetchOpts);
  const client = new NxCloudJsonRpcClient("https://nxvms.com", "me@x.com", "pw", SITE, {
    fetchImpl: f,
    wsImpl: FakeWebSocket,
    // Disabled by default: FakeWebSocket has a ping() method, so leaving the
    // real default on would schedule a real 25s setInterval in every test
    // that connects. Tests that specifically exercise keep-alive pass their
    // own keepAliveMs (usually with fake setIntervalFn/clearIntervalFn too).
    keepAliveMs: 0,
    ...opts,
  });
  return { client, f };
}

// login(): identical contract to rest-list-cameras-cloud-user

test("login includes the site scope and client id", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "nxcdb-t" } }) });
  const token = await client.login();
  assert.equal(token, "nxcdb-t");
  assert.equal(f.calls.post.url, "https://nxvms.com/cdb/oauth2/token");
  assert.equal(f.calls.post.body.scope, `cloudSystemId=${SITE}`);
  assert.equal(f.calls.post.body.client_id, CLIENT_ID);
});

test("login adds the mfa code", async () => {
  const { client, f } = makeClient(
    { post: makeResponse({ json: { access_token: "t" } }) },
    { mfaCode: "999111" },
  );
  await client.login();
  assert.equal(f.calls.post.body.mfaCode, "999111");
});

test("login rejected raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 403, text: "no" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("login with a bad JSON response raises ApiError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 200 }) }); // json:null -> .json() throws
  await assert.rejects(() => client.login(), ApiError);
});

test("login: a bare 'fetch failed' unwraps err.cause into the message", async () => {
  const { client } = makeClient();
  client.fetchImpl = fetchThrowingWithCause("ENOTFOUND", "getaddrinfo ENOTFOUND some.host");
  await assert.rejects(
    () => client.login(),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /fetch failed/);
      assert.match(err.message, /ENOTFOUND/); // the real cause, not just "fetch failed"
      return true;
    },
  );
});

// relayUrl

test("relayUrl is built from the site id", () => {
  const { client } = makeClient();
  assert.equal(client.relayUrl, `https://${SITE}${RELAY_SUFFIX}`);
});

// connect(): opens the WS directly at {relay}/jsonrpc. The relay's redirect
// to the serving node is followed MANUALLY, one hop at a time -- same idea
// as the manual-redirect pattern in rest-list-cameras-cloud-user's fetch.

async function makeConnectedClient(opts = {}) {
  const { client } = makeClient({}, opts);
  client.token = "nxcdb-t";
  const connectPromise = client.connect();
  await new Promise((r) => setImmediate(r));
  const socket = FakeWebSocket.instances[0];
  socket.emitOpen();
  return { client, socket, connectPromise };
}

test("connect() opens the WebSocket directly at {relay}/jsonrpc with the bearer, no followRedirects", async () => {
  const { socket, connectPromise } = await makeConnectedClient();
  await connectPromise;
  assert.equal(socket.url, `wss://${SITE}${RELAY_SUFFIX}/jsonrpc`);
  assert.equal(socket.options.followRedirects, undefined);
  assert.equal(socket.options.headers.Authorization, "Bearer nxcdb-t");
  assert.equal(socket.sent.length, 0); // no login.sessions.create was sent
});

test("connect() manually follows a 307 to the serving node, resending the bearer itself", async () => {
  const { client } = makeClient();
  client.token = "nxcdb-t";
  const connectPromise = client.connect();
  await new Promise((r) => setImmediate(r));
  const first = FakeWebSocket.instances[0];
  first.emitUnexpectedResponse(307, "https://node7.relay.vmsproxy.com/jsonrpc");
  await new Promise((r) => setImmediate(r));
  assert.equal(FakeWebSocket.instances.length, 2);
  const second = FakeWebSocket.instances[1];
  assert.equal(second.url, "wss://node7.relay.vmsproxy.com/jsonrpc");
  assert.equal(second.options.headers.Authorization, "Bearer nxcdb-t");
  assert.equal(first.terminated, true);
  second.emitOpen();
  await connectPromise;
  assert.equal(client.ws, second);
});

test("connect() follows a 301/302/303/308 redirect the same as a 307", async () => {
  for (const status of [301, 302, 303, 308]) {
    const { client } = makeClient();
    client.token = "t";
    const connectPromise = client.connect();
    await new Promise((r) => setImmediate(r));
    FakeWebSocket.instances[0].emitUnexpectedResponse(status, "https://node7.relay.vmsproxy.com/jsonrpc");
    await new Promise((r) => setImmediate(r));
    FakeWebSocket.instances[1].emitOpen();
    await connectPromise;
  }
});

test("connect() rejects with ApiError after too many redirect hops", async () => {
  const { client } = makeClient();
  client.token = "t";
  const connectPromise = client.connect();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await new Promise((r) => setImmediate(r));
    FakeWebSocket.instances[hop].emitUnexpectedResponse(307, `https://node${hop}.relay.vmsproxy.com/jsonrpc`);
  }
  await assert.rejects(() => connectPromise, ApiError);
});

test("connect() rejects with ApiError when the relay redirects to a non-wss:// location", async () => {
  const { client } = makeClient();
  client.token = "t";
  const connectPromise = client.connect();
  await new Promise((r) => setImmediate(r));
  const socket = FakeWebSocket.instances[0];
  socket.emitUnexpectedResponse(307, "http://node7.relay.vmsproxy.com/jsonrpc");
  await assert.rejects(() => connectPromise, ApiError);
  assert.equal(socket.terminated, true);
});

test("connect() rejects with ApiError when a redirect has no Location header", async () => {
  const { client } = makeClient();
  client.token = "t";
  const connectPromise = client.connect();
  await new Promise((r) => setImmediate(r));
  FakeWebSocket.instances[0].emitUnexpectedResponse(307, undefined);
  await assert.rejects(() => connectPromise, ApiError);
});

test("connect() rejects with AuthError on an unexpected 401/403 response", async () => {
  const { client } = makeClient();
  client.token = "bad-token";
  const connectPromise = client.connect();
  await new Promise((r) => setImmediate(r));
  FakeWebSocket.instances[0].emitUnexpectedResponse(401);
  await assert.rejects(() => connectPromise, AuthError);
});

test("connect() rejects with ApiError on any other unexpected response status", async () => {
  const { client } = makeClient();
  client.token = "t";
  const connectPromise = client.connect();
  await new Promise((r) => setImmediate(r));
  FakeWebSocket.instances[0].emitUnexpectedResponse(500);
  await assert.rejects(() => connectPromise, ApiError);
});

test("connect() passes maxPayload through to the WebSocket, defaulting to DEFAULT_MAX_PAYLOAD_BYTES", async () => {
  const { socket, connectPromise } = await makeConnectedClient();
  await connectPromise;
  assert.equal(socket.options.maxPayload, DEFAULT_MAX_PAYLOAD_BYTES);
});

test("a custom maxPayload option is passed through to the WebSocket", async () => {
  const { socket, connectPromise } = await makeConnectedClient({ maxPayload: 5 * 1024 * 1024 });
  await connectPromise;
  assert.equal(socket.options.maxPayload, 5 * 1024 * 1024);
});

test("connect() starts a keep-alive ping interval once open, using the configured interval", async () => {
  const scheduled = [];
  const setIntervalFn = (fn, ms) => {
    scheduled.push({ fn, ms });
    return scheduled.length; // fake timer handle
  };
  const clearIntervalFn = () => {};
  const { socket, connectPromise } = await makeConnectedClient({
    keepAliveMs: 25000,
    setIntervalFn,
    clearIntervalFn,
  });
  await connectPromise;
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 25000);
  scheduled[0].fn(); // simulate the interval firing
  assert.equal(socket.pings, 1);
});

test("connect() does not schedule a keep-alive interval when keepAliveMs is 0", async () => {
  let calls = 0;
  const setIntervalFn = () => {
    calls += 1;
    return 1;
  };
  const { connectPromise } = await makeConnectedClient({ keepAliveMs: 0, setIntervalFn });
  await connectPromise;
  assert.equal(calls, 0);
});

test("an unexpected socket close clears the keep-alive interval and calls onClose", async () => {
  let cleared = 0;
  const setIntervalFn = () => 1;
  const clearIntervalFn = () => {
    cleared += 1;
  };
  const { client, socket, connectPromise } = await makeConnectedClient({
    keepAliveMs: 25000,
    setIntervalFn,
    clearIntervalFn,
  });
  await connectPromise;
  let closeInfo = null;
  client.onClose = (code, reasonText) => {
    closeInfo = { code, reasonText };
  };
  socket.close(1006, "abnormal closure");
  assert.equal(cleared, 1);
  assert.deepEqual(closeInfo, { code: 1006, reasonText: "abnormal closure" });
});

test("close() does not treat its own shutdown as an unexpected close", async () => {
  const { client, socket, connectPromise } = await makeConnectedClient();
  await connectPromise;
  let onCloseCalled = false;
  client.onClose = () => {
    onCloseCalled = true;
  };
  client.close();
  assert.equal(onCloseCalled, false);
  assert.equal(socket.closed, true);
});

test("connect() rejects with ApiError on a WebSocket error", async () => {
  const { client } = makeClient();
  client.token = "t";
  const connectPromise = client.connect();
  await new Promise((r) => setImmediate(r));
  FakeWebSocket.instances[0].emitError(new Error("boom"));
  await assert.rejects(() => connectPromise, ApiError);
});

// subscribeEventLog() + push notifications -- same contract as the local sample

test("subscribeEventLog() sends the subscribe method and returns the initial array", async () => {
  const { client, socket, connectPromise } = await makeConnectedClient();
  await connectPromise;
  const subPromise = client.subscribeEventLog({});
  const sent = socket.sent[0];
  assert.equal(sent.method, METHOD_SUBSCRIBE);
  const initial = [{ timestampMs: 1000, eventData: { eventType: "cameraMotionEvent" } }];
  socket.emitMessage({ jsonrpc: "2.0", id: sent.id, result: initial });
  const events = await subPromise;
  assert.equal(events.length, 1);
  assert.equal(events[0].eventData.eventType, "cameraMotionEvent");
});

test("subscribeEventLog() forwards params (e.g. limit) to bound the initial snapshot", async () => {
  const { client, socket, connectPromise } = await makeConnectedClient();
  await connectPromise;
  client.subscribeEventLog({ limit: 100 });
  const sent = socket.sent[0];
  assert.deepEqual(sent.params, { limit: 100 });
});

test("a message with no matching pending id is routed to onNotification", async () => {
  const { client, socket, connectPromise } = await makeConnectedClient();
  await connectPromise;
  const received = [];
  client.onNotification = (msg) => received.push(msg);
  socket.emitMessage({
    jsonrpc: "2.0",
    method: METHOD_SUBSCRIBE,
    params: [{ timestampMs: 2000, eventData: { eventType: "cameraDisconnectEvent" } }],
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].params[0].eventData.eventType, "cameraDisconnectEvent");
});

test("unsubscribeEventLog() sends the unsubscribe method and never throws", async () => {
  const { client, socket, connectPromise } = await makeConnectedClient();
  await connectPromise;
  const unsubPromise = client.unsubscribeEventLog();
  const sent = socket.sent[0];
  assert.equal(sent.method, METHOD_UNSUBSCRIBE);
  socket.emitMessage({ jsonrpc: "2.0", id: sent.id, error: { code: 500, message: "already closing" } });
  await assert.doesNotReject(() => unsubPromise);
});

test("call() rejects if the socket closes before a reply arrives", async () => {
  const { client, socket, connectPromise } = await makeConnectedClient();
  await connectPromise;
  const callPromise = client.call("rest.v4.events.log.all.subscribe", {});
  socket.close();
  await assert.rejects(() => callPromise, ApiError);
});

test("call() without connect() first raises ApiError", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.call("x", {}), ApiError);
});

// logout(): deletes the scoped token on the cloud, best-effort

test("logout deletes the token on the cloud", async () => {
  const { client, f } = makeClient({ del: makeResponse({ status: 204 }) });
  client.token = "nxcdb-t";
  await client.logout();
  assert.equal(f.calls.deleteUrl, "https://nxvms.com/cdb/oauth2/token/nxcdb-t");
  assert.equal(client.token, null);
});

test("logout is a no-op when there is no token", async () => {
  const { client, f } = makeClient();
  await client.logout();
  assert.equal(f.calls.deleteUrl, null);
});

test("logout never throws even if the delete call fails", async () => {
  const { client } = makeClient();
  client.fetchImpl = throwingFetch("network down");
  client.token = "t";
  await assert.doesNotReject(() => client.logout());
});

// pure helpers

test("toWssUrl converts https to wss", () => {
  assert.equal(
    toWssUrl("https://node7.relay.vmsproxy.com/jsonrpc"),
    "wss://node7.relay.vmsproxy.com/jsonrpc",
  );
});

test("toWssUrl rejects a non-https input", () => {
  assert.throws(() => toWssUrl("http://node7.relay.vmsproxy.com/jsonrpc"), ApiError);
});

test("msToIso renders a readable UTC timestamp", () => {
  assert.equal(msToIso(0), "1970-01-01 00:00:00");
});

test("formatEventLine renders type, resource, and action", () => {
  const line = formatEventLine({
    timestampMs: 0,
    eventData: { eventType: "cameraMotionEvent", caption: "Lobby" },
    actionData: { actionType: "bookmarkAction" },
  });
  assert.ok(line.includes("cameraMotionEvent"));
  assert.ok(line.includes("Lobby"));
  assert.ok(line.includes("bookmarkAction"));
});

test("toEventArray handles an array, a {reply:[]} envelope, and a bare object", () => {
  assert.deepEqual(toEventArray([{ a: 1 }]), [{ a: 1 }]);
  assert.deepEqual(toEventArray({ reply: [{ a: 1 }] }), [{ a: 1 }]);
  assert.deepEqual(toEventArray({ a: 1 }), [{ a: 1 }]);
  assert.deepEqual(toEventArray(null), []);
});

// config + CLI

test("resolveConfig uses NX_CLOUD_* vars (env beats file)", () => {
  const args = { cloudHost: null, user: null, password: null, siteId: null, mfaCode: null };
  const config = resolveConfig(args, { NX_CLOUD_SITE_ID: "file-sys" }, { NX_CLOUD_SITE_ID: "env-sys" });
  assert.equal(config.siteId, "env-sys");
});

test("parseArgs accepts the cloud flag set", () => {
  const flags = parseArgs([
    "--cloud-host",
    "https://nxvms.com",
    "--user",
    "me@x.com",
    "--password",
    "pw",
    "--site-id",
    SITE,
    "--mfa-code",
    "123456",
    "--insecure",
  ]);
  assert.equal(flags.cloudHost, "https://nxvms.com");
  assert.equal(flags.siteId, SITE);
  assert.equal(flags.mfaCode, "123456");
  assert.equal(flags.insecure, true);
});

test("parseArgs accepts --limit and --max-payload-mb", () => {
  const flags = parseArgs(["--limit", "25", "--max-payload-mb", "300"]);
  assert.equal(flags.limit, "25");
  assert.equal(flags.maxPayloadMb, "300");
});

test("parseArgs rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});
