// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for jsonrpc_subscribe_events.mjs. No network, no server, and
 * no real 'ws' socket -- FakeWebSocket below stands in for it.
 *
 * Run from this folder:  node --test test_jsonrpc_subscribe_events.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxJsonRpcClient,
  ApiError,
  toWsUrl,
  normalizeHost,
  msToIso,
  formatEventLine,
  toEventArray,
  resolveConfig,
  parseArgs,
  waitForStop,
  main,
  METHOD_LOGIN,
  METHOD_SUBSCRIBE,
  METHOD_UNSUBSCRIBE,
} from "./jsonrpc_subscribe_events.mjs";

/** Flush pending microtasks (promise chains inside connect/login/subscribe). */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Minimal fake of the 'ws' WebSocket: same on()/send()/close() surface, plus
 * test-only hooks (emitOpen/emitMessage/emitClose) to script server behavior.
 */
class FakeWebSocket {
  constructor(url, protocols, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.closed = false;
    this.handlers = { open: [], message: [], error: [], close: [] };
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
  close() {
    this.closed = true;
    this.emitClose(1000, "");
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
  /** Simulate the SERVER closing the connection (not us calling close()). */
  emitClose(code = 1006, reason = "") {
    this.closed = true;
    this.handlers.close.forEach((cb) => cb(code, reason));
  }
}
FakeWebSocket.instances = [];

function makeConnectedClient(opts = {}) {
  FakeWebSocket.instances = [];
  const client = new NxJsonRpcClient("https://srv:7001", "admin", "pw", {
    wsImpl: FakeWebSocket,
    ...opts,
  });
  const connectPromise = client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.emitOpen();
  return { client, socket, connectPromise };
}

// ---------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------

test("connect() opens a WebSocket at {host}/jsonrpc and resolves on open", async () => {
  const { socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  assert.equal(socket.url, "wss://srv:7001/jsonrpc");
});

test("connect() rejects on a WebSocket error", async () => {
  FakeWebSocket.instances = [];
  const client = new NxJsonRpcClient("https://srv:7001", "admin", "pw", { wsImpl: FakeWebSocket });
  const connectPromise = client.connect();
  FakeWebSocket.instances[0].emitError(new Error("boom"));
  await assert.rejects(() => connectPromise, ApiError);
});

// ---------------------------------------------------------------------------
// login()
// ---------------------------------------------------------------------------

test("login() sends setSession:true and stores the token", async () => {
  const { client, socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  const loginPromise = client.login();
  const sent = socket.sent[0];
  assert.equal(sent.method, METHOD_LOGIN);
  assert.deepEqual(sent.params, { username: "admin", password: "pw", setSession: true });
  socket.emitMessage({ jsonrpc: "2.0", id: sent.id, result: { token: "abc123" } });
  const token = await loginPromise;
  assert.equal(token, "abc123");
  assert.equal(client.token, "abc123");
});

test("login() raises ApiError on a JSON-RPC error reply", async () => {
  const { client, socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  const loginPromise = client.login();
  const sent = socket.sent[0];
  socket.emitMessage({ jsonrpc: "2.0", id: sent.id, error: { code: 401, message: "Bad credentials" } });
  await assert.rejects(() => loginPromise, ApiError);
});

test("login() raises ApiError when the reply has no token", async () => {
  const { client, socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  const loginPromise = client.login();
  const sent = socket.sent[0];
  socket.emitMessage({ jsonrpc: "2.0", id: sent.id, result: {} });
  await assert.rejects(() => loginPromise, ApiError);
});

// ---------------------------------------------------------------------------
// subscribeEventLog() + push notifications
// ---------------------------------------------------------------------------

test("subscribeEventLog() sends the subscribe method and returns the initial array", async () => {
  const { client, socket, connectPromise } = makeConnectedClient();
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

test("a message with no matching pending id is routed to onNotification", async () => {
  const { client, socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  const received = [];
  client.onNotification = (msg) => received.push(msg);
  // Not a reply to anything we sent -- e.g. a pushed live-event notification.
  socket.emitMessage({
    jsonrpc: "2.0",
    method: METHOD_SUBSCRIBE,
    params: [{ timestampMs: 2000, eventData: { eventType: "cameraDisconnectEvent" } }],
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].params[0].eventData.eventType, "cameraDisconnectEvent");
});

test("unsubscribeEventLog() sends the unsubscribe method and never throws", async () => {
  const { client, socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  const unsubPromise = client.unsubscribeEventLog();
  const sent = socket.sent[0];
  assert.equal(sent.method, METHOD_UNSUBSCRIBE);
  socket.emitMessage({ jsonrpc: "2.0", id: sent.id, error: { code: 500, message: "already closing" } });
  await assert.doesNotReject(() => unsubPromise);
});

test("call() rejects if the socket closes before a reply arrives", async () => {
  const { client, socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  const callPromise = client.call("rest.v4.events.log.all.subscribe", {});
  socket.close();
  await assert.rejects(() => callPromise, ApiError);
});

test("call() without connect() first raises ApiError", async () => {
  const client = new NxJsonRpcClient("https://srv:7001", "admin", "pw", { wsImpl: FakeWebSocket });
  await assert.rejects(() => client.call("x", {}), ApiError);
});

// ---------------------------------------------------------------------------
// waitForStop() -- the bug this covers: a server-initiated close must
// resolve the same wait Ctrl+C resolves, or main() hangs and the process
// exits silently once the event loop drains, skipping cleanup entirely.
// ---------------------------------------------------------------------------

test("waitForStop() resolves when the SERVER closes the socket, with the close code", async () => {
  const { client, socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  const stopPromise = waitForStop(client);
  socket.emitClose(1006, "abnormal closure");
  const stop = await stopPromise;
  assert.equal(stop.reason, "closed");
  assert.equal(stop.code, 1006);
  assert.equal(stop.message, "abnormal closure");
});

test("waitForStop() resolves on SIGINT (Ctrl+C) with reason 'interrupted'", async () => {
  const { client, connectPromise } = makeConnectedClient();
  await connectPromise;
  const stopPromise = waitForStop(client);
  process.emit("SIGINT"); // simulate Ctrl+C without sending a real signal
  const stop = await stopPromise;
  assert.deepEqual(stop, { reason: "interrupted" });
});

test("waitForStop() ignores a close that happens strictly before it is called", async () => {
  // Documents a real edge case: if the socket closes in the gap between
  // subscribeEventLog() resolving and waitForStop() being invoked, the
  // 'close' event has already fired and this new listener never sees it --
  // the wait then only resolves via Ctrl+C, not the (already-dead) socket.
  const { client, socket, connectPromise } = makeConnectedClient();
  await connectPromise;
  socket.emitClose(1006, "closed before waitForStop was called");
  const stopPromise = waitForStop(client);
  let settled = false;
  stopPromise.then(() => {
    settled = true;
  });
  await tick();
  assert.equal(settled, false, "waitForStop() should NOT have resolved from the earlier close");
  // Unblock the promise so the test process can exit cleanly.
  process.emit("SIGINT");
  await stopPromise;
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test("toWsUrl converts https/http to wss/ws and appends /jsonrpc", () => {
  assert.equal(toWsUrl("https://srv:7001"), "wss://srv:7001/jsonrpc");
  assert.equal(toWsUrl("http://srv:7001/"), "ws://srv:7001/jsonrpc");
});

test("normalizeHost assumes https:// for a bare host/IP", () => {
  assert.equal(normalizeHost("192.168.1.10:7001"), "https://192.168.1.10:7001");
  assert.equal(normalizeHost("srv.local"), "https://srv.local");
});

test("normalizeHost leaves an already-schemed host as-is", () => {
  assert.equal(normalizeHost("https://192.168.1.10:7001"), "https://192.168.1.10:7001");
  assert.equal(normalizeHost("http://srv:7001"), "http://srv:7001");
  assert.equal(normalizeHost("HTTPS://srv:7001"), "HTTPS://srv:7001");
});

test("normalizeHost passes through empty/nullish values unchanged", () => {
  assert.equal(normalizeHost(""), "");
  assert.equal(normalizeHost(null), null);
  assert.equal(normalizeHost(undefined), undefined);
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

test("resolveConfig uses NX_SERVER_* vars (env beats file)", () => {
  const args = { host: null, user: null, password: null };
  const config = resolveConfig(args, { NX_SERVER_HOST: "https://file:7001" }, { NX_SERVER_HOST: "https://env:7001" });
  assert.equal(config.host, "https://env:7001");
});

test("parseArgs rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});

test("parseArgs applies normalizeHost to --host (space-separated form)", () => {
  const flags = parseArgs(["--host", "192.168.1.10:7001", "--user", "admin"]);
  assert.equal(flags.host, "https://192.168.1.10:7001");
  assert.equal(flags.user, "admin");
});

test("parseArgs applies normalizeHost to --host=<value> (inline form)", () => {
  const flags = parseArgs(["--host=192.168.1.10:7001"]);
  assert.equal(flags.host, "https://192.168.1.10:7001");
});

test("parseArgs leaves an already-schemed --host unchanged", () => {
  const flags = parseArgs(["--host", "https://srv:7001"]);
  assert.equal(flags.host, "https://srv:7001");
});

test("parseArgs does not touch non-host flags", () => {
  const flags = parseArgs(["--user", "admin", "--password", "pw", "--dotenv", "custom.env", "--insecure"]);
  assert.equal(flags.user, "admin");
  assert.equal(flags.password, "pw");
  assert.equal(flags.envFile, "custom.env");
  assert.equal(flags.insecure, true);
});

test("resolveConfig also normalizes a host coming from NX_SERVER_HOST (env), not just --host", () => {
  const config = resolveConfig(
    { host: null, user: null, password: null },
    {},
    { NX_SERVER_HOST: "192.168.1.10:7001" },
  );
  assert.equal(config.host, "https://192.168.1.10:7001");
});

// ---------------------------------------------------------------------------
// main() -- end-to-end CLI orchestration, driven through FakeWebSocket.
// ---------------------------------------------------------------------------

/**
 * A fake stdio stream: same `write()` surface main() uses, capturing everything
 * written to `.text` instead of touching the real process.stdout/stderr. Using
 * dependency injection here (rather than monkeypatching process.stdout.write)
 * matters: node:test's own TAP reporter writes other tests' "ok" lines to the
 * real process.stdout at unpredictable times, and an earlier version of this
 * test that globally overrode process.stdout.write around an `await` swallowed
 * other tests' output.
 */
function makeFakeStream() {
  const stream = { text: "" };
  stream.write = (chunk) => {
    stream.text += chunk;
    return true;
  };
  return stream;
}

test("main() returns exit code 2 and reports missing config when nothing is provided", async () => {
  const stderr = makeFakeStream();
  const code = await main(["--dotenv", "/nonexistent/.env"], { wsImpl: FakeWebSocket, stderr });
  assert.equal(code, 2);
  assert.match(stderr.text, /Missing config: host, user, password/);
});

test("main() returns exit code 2 and reports an unknown flag without touching the network", async () => {
  FakeWebSocket.instances = [];
  const stderr = makeFakeStream();
  const code = await main(["--nope"], { wsImpl: FakeWebSocket, stderr });
  assert.equal(code, 2);
  assert.match(stderr.text, /Unknown argument: --nope/);
  assert.equal(FakeWebSocket.instances.length, 0, "should fail before ever opening a socket");
});

test("main() full flow: connect, login, subscribe, a live event, then a server close (exit code 1)", async () => {
  FakeWebSocket.instances = [];
  const stdout = makeFakeStream();
  const mainPromise = main(
    ["--host", "192.168.1.10:7001", "--user", "admin", "--password", "pw", "--insecure"],
    { wsImpl: FakeWebSocket, stdout },
  );

  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, "wss://192.168.1.10:7001/jsonrpc", "normalizeHost should have added https://");
  socket.emitOpen();

  await tick();
  let sent = socket.sent.at(-1);
  assert.equal(sent.method, METHOD_LOGIN);
  socket.emitMessage({ jsonrpc: "2.0", id: sent.id, result: { token: "abc123" } });

  await tick();
  sent = socket.sent.at(-1);
  assert.equal(sent.method, METHOD_SUBSCRIBE);
  socket.emitMessage({
    jsonrpc: "2.0",
    id: sent.id,
    result: [{ timestampMs: 0, eventData: { eventType: "cameraMotionEvent", caption: "Lobby" } }],
  });

  await tick();
  // A pushed live notification (no matching pending id).
  socket.emitMessage({
    jsonrpc: "2.0",
    method: METHOD_SUBSCRIBE,
    params: [{ timestampMs: 1000, eventData: { eventType: "cameraDisconnectEvent", caption: "Yard" } }],
  });

  await tick();
  // The server hangs up.
  socket.emitClose(1006, "bye");

  const code = await mainPromise;
  assert.equal(code, 1, "a server-initiated close should exit 1");
  assert.match(stdout.text, /Connected and authenticated to https:\/\/192\.168\.1\.10:7001 as admin/);
  assert.match(stdout.text, /Current event log \(1 events\)/);
  assert.match(stdout.text, /cameraMotionEvent @ Lobby/);
  assert.match(stdout.text, /\(live\) .*cameraDisconnectEvent @ Yard/);
  assert.match(stdout.text, /Connection closed by the server \(code 1006: bye\)/);
});

test("main() returns exit code 1 and reports the server's message when login fails", async () => {
  FakeWebSocket.instances = [];
  const stderr = makeFakeStream();
  const mainPromise = main(["--host", "https://srv:7001", "--user", "admin", "--password", "wrong"], {
    wsImpl: FakeWebSocket,
    stderr,
  });

  const socket = FakeWebSocket.instances[0];
  socket.emitOpen();
  await tick();

  const sent = socket.sent.at(-1);
  assert.equal(sent.method, METHOD_LOGIN);
  socket.emitMessage({ jsonrpc: "2.0", id: sent.id, error: { code: 401, message: "Bad credentials" } });
  // Close the socket so the best-effort unsubscribe/close cleanup in
  // main()'s `finally` resolves instead of hanging on an unanswered call().
  socket.emitClose(1006, "");

  const code = await mainPromise;
  assert.equal(code, 1);
  assert.match(stderr.text, /Error: Bad credentials \(code 401\)/);
});
