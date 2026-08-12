#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS JSON-RPC sample: subscribe to the live event log over WebSocket.
 *
 * This is the one thing plain REST can't do: instead of polling
 * GET /rest/v4/events/log, we open a single WebSocket JSON-RPC connection and
 * ask the server to PUSH us new events as they happen.
 *
 *   1. Open:      WS   {server}/jsonrpc
 *   2. Log in:    "rest.v4.login.sessions.create"
 *                 { username, password, setSession: true }
 *                 setSession applies the resulting token to THIS socket --
 *                 no separate REST login call and no Authorization header.
 *   3. Subscribe: "rest.v4.events.log.all.subscribe"  { }
 *                 -> reply #1: the current event log (same shape as a plain
 *                    GET /rest/v4/events/log call)
 *                 -> then: further messages pushed on the same socket, one
 *                    per new event, for as long as we stay subscribed
 *   4. Unsubscribe: "rest.v4.events.log.all.unsubscribe"  { }  (best-effort)
 *
 * Uses the 'ws' package: Node's own built-in WebSocket only became stable in
 * Node 22, and this sample wants to run on Node 18+. 'ws' is this sample's
 * only runtime dependency.
 *
 * Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket as DefaultWebSocket } from "ws";

// JSON-RPC methods used (see the v4 OpenAPI spec's "/jsonrpc" path).
export const METHOD_LOGIN = "rest.v4.login.sessions.create";
export const METHOD_SUBSCRIBE = "rest.v4.events.log.all.subscribe";
export const METHOD_UNSUBSCRIBE = "rest.v4.events.log.all.unsubscribe";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Configuration (CLI > env > .env).
// ---------------------------------------------------------------------------

export function loadEnvFile(path = ".env") {
  const values = {};
  if (!path || !fs.existsSync(path)) return values;
  for (let line of fs.readFileSync(path, "utf-8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function resolveConfig(cliArgs, envFileValues = {}, env = process.env) {
  const pick = (cliValue, envKey) => {
    if (cliValue !== undefined && cliValue !== null) return cliValue;
    if (env[envKey]) return env[envKey];
    return envFileValues[envKey];
  };
  return {
    host: normalizeHost(pick(cliArgs.host, "NX_SERVER_HOST")),
    user: pick(cliArgs.user, "NX_SERVER_USER"),
    password: pick(cliArgs.password, "NX_SERVER_PASSWORD"),
  };
}

// ---------------------------------------------------------------------------
// Parsing / formatting helpers (pure functions = easy to test)
// ---------------------------------------------------------------------------

/** https://host:port -> wss://host:port ; http://host:port -> ws://host:port */
export function toWsUrl(host) {
  return `${(host || "").replace(/\/+$/, "").replace(/^http/, "ws")}/jsonrpc`;
}

/**
 * A bare host/IP (no scheme), e.g. "192.168.1.10:7001" -> "https://192.168.1.10:7001".
 * A host that already has http:// or https:// is returned unchanged.
 */
export function normalizeHost(host) {
  if (!host) return host;
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
}

/** Convert an epoch-millisecond timestamp to a readable UTC string. */
export function msToIso(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || Number.isNaN(n)) return String(ms);
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}

/** Return the first present, truthy value among keys in object d. */
function first(d, ...keys) {
  if (d && typeof d === "object") {
    for (const k of keys) {
      if (d[k]) return d[k];
    }
  }
  return "";
}

/**
 * One event-log record ({ timestampMs, eventData{}, actionData{}, ... }, same
 * shape as GET /rest/v4/events/log) -> one printable line.
 */
export function formatEventLine(record) {
  const eventData = (record && record.eventData) || {};
  const actionData = (record && record.actionData) || {};
  const eventType = first(eventData, "eventType", "type") || "event";
  const resource = first(eventData, "caption", "resourceName", "eventResourceId", "source");
  const actionType = first(actionData, "actionType", "type");
  let line = `[${msToIso(record && record.timestampMs)}] ${eventType}`;
  if (resource) line += ` @ ${resource}`;
  if (actionType) line += ` -> ${actionType}`;
  return line;
}

/** Normalize a subscribe reply/notification payload to an array of records. */
export function toEventArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.reply)) return payload.reply;
  if (payload && typeof payload === "object") return [payload];
  return [];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxJsonRpcClient {
  constructor(host, user, password, { verifyTls = true, wsImpl = DefaultWebSocket } = {}) {
    this.host = host;
    this.user = user;
    this.password = password;
    this.verifyTls = verifyTls;
    this.wsImpl = wsImpl;
    this.ws = null;
    this.token = null;
    this.nextId = 1;
    this.pending = new Map(); // request id -> {resolve, reject}, waiting for a reply
    /** Called with the parsed JSON-RPC message for every push notification. */
    this.onNotification = null;
  }

  /** Open the WebSocket and wait for it to be ready. */
  connect() {
    return new Promise((resolve, reject) => {
      const url = toWsUrl(this.host);
      let ws;
      try {
        ws = new this.wsImpl(url, [], { rejectUnauthorized: this.verifyTls });
      } catch (exc) {
        reject(new ApiError(`Could not open a WebSocket to ${url}: ${exc.message}`));
        return;
      }
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("message", (data) => this._onMessage(data));
      ws.on("error", (exc) => {
        const err = new ApiError(`WebSocket error on ${url}: ${(exc && exc.message) || exc}`);
        reject(err);
        this._failPending(err);
      });
      ws.on("close", () => {
        this._failPending(new ApiError("WebSocket closed before a reply arrived."));
      });
    });
  }

  /** Reject every call() still waiting for a reply (the socket errored or closed). */
  _failPending(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /** Send one JSON-RPC request and resolve with its `result` when the matching reply arrives. */
  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new ApiError("Not connected. Call connect() first."));
        return;
      }
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (exc) {
        this.pending.delete(id);
        reject(new ApiError(`Could not send '${method}': ${exc.message}`));
      }
    });
  }

  /** Route one incoming WS frame: a reply to a pending call(), or a push notification. */
  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return; // ignore frames that aren't valid JSON
    }
    const hasId = msg && msg.id !== undefined && msg.id !== null;
    const pending = hasId ? this.pending.get(msg.id) : null;
    if (pending) {
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new ApiError(`${msg.error.message || "JSON-RPC error"} (code ${msg.error.code})`));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (this.onNotification) this.onNotification(msg);
  }

  /** Authenticate THIS socket. setSession:true applies the token to the connection. */
  async login() {
    const result = await this.call(METHOD_LOGIN, {
      username: this.user,
      password: this.password,
      setSession: true,
    });
    if (!result || !result.token) throw new ApiError("Login failed: no token in the reply.");
    this.token = result.token;
    return this.token;
  }

  /** Subscribe to the live event log; returns the current log as an array. */
  async subscribeEventLog(params = {}) {
    const result = await this.call(METHOD_SUBSCRIBE, params);
    return toEventArray(result);
  }

  /** Best-effort: stop live notifications. Never throws. */
  async unsubscribeEventLog() {
    try {
      await this.call(METHOD_UNSUBSCRIBE, {});
    } catch {
      // Cleanup only; ignore failures (e.g. the socket is already closing).
    }
  }

  /** Best-effort close. Never throws. */
  close() {
    try {
      if (this.ws) this.ws.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = {
    host: null,
    user: null,
    password: null,
    envFile: ".env",
    insecure: false,
  };
  const map = {
    "--host": "host",
    "--user": "user",
    "--password": "password",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  const booleans = { "--insecure": "insecure" };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const valueOf = () => (inlineValue !== null ? inlineValue : argv[++i]);
    if (arg in booleans) flags[booleans[arg]] = true;
    else if (arg in map) {
      const key = map[arg];
      const value = valueOf();

      flags[key] = key === "host" ? normalizeHost(value) : value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}

/**
 * Resolve once SIGINT (Ctrl+C) fires, OR the socket closes on its own (e.g.
 * the server dropped the connection). Listening otherwise runs forever.
 */
export function waitForStop(client) {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve({ reason: "interrupted" }));
    client.ws.on("close", (code, reason) => {
      resolve({ reason: "closed", code, message: reason ? reason.toString() : "" });
    });
  });
}

/**
 * @param {{ wsImpl?: typeof DefaultWebSocket, stdout?: {write: Function}, stderr?: {write: Function} }} [deps]
 *   Injectable for offline tests (e.g. FakeWebSocket + capturing streams); production
 *   callers omit this and get the real 'ws' socket and the real process streams.
 */
export async function main(
  argv = process.argv.slice(2),
  { wsImpl = DefaultWebSocket, stdout = process.stdout, stderr = process.stderr } = {},
) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    stderr.write(`${exc.message}\n`);
    return 2;
  }
  const config = resolveConfig(args, loadEnvFile(args.envFile));

  const missing = ["host", "user", "password"].filter((n) => !config[n]);
  if (missing.length) {
    stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy .env.example). See the README.\n",
    );
    return 2;
  }

  const client = new NxJsonRpcClient(config.host, config.user, config.password, {
    verifyTls: !args.insecure,
    wsImpl,
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.login();
    stdout.write(`Connected and authenticated to ${config.host} as ${config.user}\n\n`);

    let liveCount = 0;
    client.onNotification = (msg) => {
      for (const record of toEventArray(msg.params ?? msg.result)) {
        liveCount += 1;
        stdout.write(`  (live) ${formatEventLine(record)}\n`);
      }
    };

    const initial = await client.subscribeEventLog({});
    stdout.write(`Current event log (${initial.length} events):\n`);
    for (const record of initial) stdout.write(`  ${formatEventLine(record)}\n`);

    stdout.write("\nListening for new events -- press Ctrl+C to stop...\n");
    const stop = await waitForStop(client);

    if (stop.reason === "closed") {
      stdout.write(
        `\nConnection closed by the server (code ${stop.code}${stop.message ? `: ${stop.message}` : ""}).\n`,
      );
      return 1;
    }

    stdout.write(`\nStopping. Received ${liveCount} live event(s). Unsubscribing...\n`);
    return 0;
  } catch (exc) {
    if (exc instanceof ApiError) {
      stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  } finally {
    if (connected) {
      await client.unsubscribeEventLog();
      client.close();
    }
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
