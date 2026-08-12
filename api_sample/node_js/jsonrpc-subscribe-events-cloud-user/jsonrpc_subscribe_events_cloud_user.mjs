#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
// See README.md for the flow, design notes, and error-handling table.

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { WebSocket as DefaultWebSocket } from "ws";

export const CLIENT_ID = "3rdParty";
export const RELAY_SUFFIX = ".relay.vmsproxy.com";
export const MAX_REDIRECTS = 1;
export const METHOD_SUBSCRIBE = "rest.v4.events.log.all.subscribe";
export const METHOD_UNSUBSCRIBE = "rest.v4.events.log.all.unsubscribe";
export const DEFAULT_MAX_PAYLOAD_BYTES = 100 * 1024 * 1024;
export const DEFAULT_EVENT_LOG_LIMIT = 100;
export const DEFAULT_KEEP_ALIVE_MS = 25000;

export class AuthError extends Error {
  constructor(m) {
    super(m);
    this.name = "AuthError";
  }
}
export class ApiError extends Error {
  constructor(m) {
    super(m);
    this.name = "ApiError";
  }
}

export function loadEnvFile(path = ".env") {
  const values = {};
  if (!path || !fs.existsSync(path)) return values;
  for (let line of fs.readFileSync(path, "utf-8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    values[key] = quoted ? value.slice(1, -1) : value;
  }
  return values;
}
export function resolveConfig(cliArgs, envFileValues = {}, env = process.env) {
  const pick = (v, k) => (v !== undefined && v !== null ? v : env[k] || envFileValues[k]);
  return {
    cloudHost: pick(cliArgs.cloudHost, "NX_CLOUD_HOST"),
    user: pick(cliArgs.user, "NX_CLOUD_USER"),
    password: pick(cliArgs.password, "NX_CLOUD_PASSWORD"),
    siteId: pick(cliArgs.siteId, "NX_CLOUD_SITE_ID"),
    mfaCode: cliArgs.mfaCode,
  };
}
export function toWssUrl(url) {
  if (!url || !url.startsWith("https://"))
    throw new ApiError(`Expected an https:// URL from the relay, got: ${url}`);
  return `wss://${url.slice(8)}`;
}
export function msToIso(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || Number.isNaN(n)) return String(ms);
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}
function first(d, ...keys) {
  for (const k of keys) if (d && d[k]) return d[k];
  return "";
}
export function formatEventLine(record) {
  const eventData = (record && record.eventData) || {};
  const actionData = (record && record.actionData) || {};
  const eventType = first(eventData, "eventType", "type") || "event";
  const resource = first(eventData, "caption", "resourceName", "eventResourceId", "source");
  const actionType = first(actionData, "actionType", "type");
  const prefix = `[${msToIso(record && record.timestampMs)}] ${eventType}`;
  return prefix + (resource ? ` @ ${resource}` : "") + (actionType ? ` -> ${actionType}` : "");
}
export function toEventArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.reply)) return payload.reply;
  return payload && typeof payload === "object" ? [payload] : [];
}
async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
// fetch() only reports "fetch failed"; the useful detail (ECONNREFUSED, etc.)
// is nested in exc.cause, so we unwrap the whole chain.
function describeFetchError(exc) {
  const parts = [exc && exc.message ? exc.message : String(exc)];
  for (let c = exc && exc.cause; c; c = c.cause)
    parts.push(`${c.code ? `${c.code}: ` : ""}${c.message || c}`);
  return parts.join(" -- caused by: ");
}

export class NxCloudJsonRpcClient {
  constructor(cloudHost, user, password, siteId, opts = {}) {
    const {
      mfaCode = null,
      verifyTls = true,
      fetchImpl = fetch,
      wsImpl = DefaultWebSocket,
      timeout = 15000,
      maxPayload = DEFAULT_MAX_PAYLOAD_BYTES,
      keepAliveMs = DEFAULT_KEEP_ALIVE_MS,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
    } = opts;
    Object.assign(this, {
      cloudHost: (cloudHost || "").replace(/\/+$/, ""),
      user,
      password,
      siteId,
      mfaCode,
    });
    Object.assign(this, { fetchImpl, wsImpl, timeout, verifyTls, maxPayload, keepAliveMs });
    Object.assign(this, {
      _setInterval: setIntervalFn,
      _clearInterval: clearIntervalFn,
      _keepAliveTimer: null,
    });
    Object.assign(this, {
      token: null,
      ws: null,
      nextId: 1,
      pending: new Map(),
      onNotification: null,
      onClose: null,
    });
    if (!verifyTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  get relayUrl() {
    return `https://${this.siteId}${RELAY_SUFFIX}`;
  }
  async _fetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
  async login() {
    const url = `${this.cloudHost}/cdb/oauth2/token`;
    const body = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
      scope: `cloudSystemId=${this.siteId}`,
    };
    if (this.mfaCode) body.mfaCode = this.mfaCode;
    let response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${describeFetchError(exc)}`);
    }
    if (response.status === 401 || response.status === 403)
      throw new AuthError(
        `Login rejected (HTTP ${response.status}). Check credentials, the site id, and 2FA (--mfa-code).`,
      );
    if (!response.ok)
      throw new ApiError(
        `Token request failed: HTTP ${response.status} ${(await safeText(response)).slice(0, 200)}`,
      );
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Token response was not valid JSON.");
    }
    this.token = data.access_token;
    if (!this.token) throw new ApiError("Token response did not contain an access_token.");
    return this.token;
  }
  _authHeader() {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }
  // The relay hands the handshake off to the serving node with a redirect
  // (HTTP 301/302/303/307/308 on the WebSocket upgrade). We follow it
  // MANUALLY, one hop at a time -- same idea as rest-list-cameras-cloud-user's
  // `_getFollowingRedirects`, just applied to a WS handshake instead of fetch.
  connect() {
    return this._connectAt(toWssUrl(`${this.relayUrl}/jsonrpc`), 0);
  }
  _connectAt(url, hop) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new this.wsImpl(url, [], {
          headers: this._authHeader(),
          rejectUnauthorized: this.verifyTls,
          maxPayload: this.maxPayload,
        });
      } catch (exc) {
        reject(new ApiError(`Could not open a WebSocket to ${url}: ${exc.message}`));
        return;
      }
      ws.on("unexpected-response", (req, res) => {
        res.resume();
        ws.terminate();
        const status = res.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          resolve(this._followRedirect(url, res.headers.location, hop, reject));
          return;
        }
        reject(
          status === 401 || status === 403
            ? new AuthError(`The relay rejected the token (HTTP ${status}). Check the cloudSystemId scope.`)
            : new ApiError(`Relay responded with HTTP ${status} while opening the WebSocket.`),
        );
      });
      ws.on("open", () => {
        this.ws = ws;
        this._startKeepAlive(ws);
        resolve();
      });
      ws.on("message", (data) => this._onMessage(data));
      ws.on("error", (exc) => {
        this._stopKeepAlive();
        const err = new ApiError(`WebSocket error on ${url}: ${(exc && exc.message) || exc}`);
        reject(err);
        this._failPending(err);
      });
      ws.on("close", (code, reason) => {
        this._stopKeepAlive();
        this._failPending(new ApiError("WebSocket closed before a reply arrived."));
        if (this.onClose) this.onClose(code, reason ? reason.toString() : "");
      });
    });
  }
  // Resolves the redirect's Location header against the current URL, refuses
  // to fall back to an unencrypted hop, and re-issues the handshake at the
  // new address with the same bearer token -- up to MAX_REDIRECTS hops.
  _followRedirect(fromUrl, location, hop, reject) {
    if (!location) return reject(new ApiError(`Redirect without a Location header (from ${fromUrl}).`));
    if (hop >= MAX_REDIRECTS)
      return reject(new ApiError(`Too many redirects (>${MAX_REDIRECTS}) chasing the relay.`));
    let next;
    try {
      next = new URL(location, fromUrl);
    } catch {
      return reject(new ApiError(`Redirect had an invalid Location header: ${location}`));
    }
    if (next.protocol === "http:") next.protocol = "ws:";
    else if (next.protocol === "https:") next.protocol = "wss:";
    if (next.protocol !== "wss:")
      return reject(new ApiError(`Relay redirected to a non-wss:// location (${next}); refusing to use it.`));
    return this._connectAt(next.toString(), hop + 1);
  }
  // Idle-timeout proxies/relays will drop a quiet socket even though we're
  // still subscribed, so we ping periodically to keep it alive.
  _startKeepAlive(ws) {
    if (!this.keepAliveMs || typeof ws.ping !== "function") return;
    this._keepAliveTimer = this._setInterval(() => {
      try {
        ws.ping();
      } catch {}
    }, this.keepAliveMs);
  }
  _stopKeepAlive() {
    if (!this._keepAliveTimer) return;
    this._clearInterval(this._keepAliveTimer);
    this._keepAliveTimer = null;
  }
  _failPending(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
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
  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    const pending = msg && msg.id != null ? this.pending.get(msg.id) : null;
    if (!pending) {
      if (this.onNotification) this.onNotification(msg);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.error)
      pending.reject(new ApiError(`${msg.error.message || "JSON-RPC error"} (code ${msg.error.code})`));
    else pending.resolve(msg.result);
  }
  async subscribeEventLog(params = {}) {
    return toEventArray(await this.call(METHOD_SUBSCRIBE, params));
  }
  async unsubscribeEventLog() {
    try {
      await this.call(METHOD_UNSUBSCRIBE, {});
    } catch {}
  }
  close() {
    this._stopKeepAlive();
    this.onClose = null;
    try {
      if (this.ws) this.ws.close();
    } catch {}
  }
  async logout() {
    if (!this.token) return;
    const url = `${this.cloudHost}/cdb/oauth2/token/${this.token}`;
    try {
      await this._fetchWithTimeout(url, { method: "DELETE", headers: this._authHeader() });
    } catch {
    } finally {
      this.token = null;
    }
  }
}

export function parseArgs(argv) {
  const flags = {
    cloudHost: null,
    user: null,
    password: null,
    siteId: null,
    mfaCode: null,
    envFile: ".env",
    insecure: false,
    limit: null,
    maxPayloadMb: null,
  };
  const map = {
    "--cloud-host": "cloudHost",
    "--user": "user",
    "--password": "password",
    "--site-id": "siteId",
    "--mfa-code": "mfaCode",
    "--dotenv": "envFile",
    "--limit": "limit",
    "--max-payload-mb": "maxPayloadMb",
  };
  const booleans = { "--insecure": "insecure" };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i],
      inlineValue = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const valueOf = () => (inlineValue !== null ? inlineValue : argv[++i]);
    if (arg in booleans) flags[booleans[arg]] = true;
    else if (arg in map) flags[map[arg]] = valueOf();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}
function waitForInterruptOrClose(client) {
  return new Promise((resolve) => {
    const onSigint = () => {
      client.onClose = null;
      resolve({ reason: "interrupt" });
    };
    client.onClose = (code, reasonText) => {
      process.removeListener("SIGINT", onSigint);
      resolve({ reason: "closed", code, reasonText });
    };
    process.once("SIGINT", onSigint);
  });
}
export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`${exc.message}\n`);
    return 2;
  }
  const config = resolveConfig(args, loadEnvFile(args.envFile));
  const missing = ["cloudHost", "user", "password", "siteId"].filter((n) => !config[n]);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\nProvide via flags or .env. See the README.\n`,
    );
    return 2;
  }
  const limit = args.limit !== null ? Number(args.limit) : DEFAULT_EVENT_LOG_LIMIT;
  const maxPayload =
    args.maxPayloadMb !== null ? Number(args.maxPayloadMb) * 1024 * 1024 : DEFAULT_MAX_PAYLOAD_BYTES;
  const client = new NxCloudJsonRpcClient(config.cloudHost, config.user, config.password, config.siteId, {
    mfaCode: config.mfaCode,
    verifyTls: !args.insecure,
    maxPayload,
  });
  let connected = false;
  try {
    await client.login();
    process.stdout.write(`Got site-scoped token for ${config.siteId}\n`);
    await client.connect();
    connected = true;
    process.stdout.write(`Connected over the relay as ${config.user}\n\n`);
    let liveCount = 0;
    client.onNotification = (msg) => {
      for (const record of toEventArray(msg.params ?? msg.result)) {
        liveCount += 1;
        process.stdout.write(`  (live) ${formatEventLine(record)}\n`);
      }
    };
    const initial = await client.subscribeEventLog({ limit });
    process.stdout.write(`Current event log (last ${initial.length} of up to ${limit} requested):\n`);
    for (const record of initial) process.stdout.write(`  ${formatEventLine(record)}\n`);
    process.stdout.write("\nListening for new events -- press Ctrl+C to stop...\n");
    const outcome = await waitForInterruptOrClose(client);
    if (outcome.reason !== "closed") {
      process.stdout.write(`\nStopping. Received ${liveCount} live event(s). Unsubscribing...\n`);
      return 0;
    }
    const detail =
      outcome.code !== undefined
        ? ` (code ${outcome.code}${outcome.reasonText ? `: ${outcome.reasonText}` : ""})`
        : "";
    process.stdout.write(
      `\nConnection closed by the relay/server${detail}. Received ${liveCount} live event(s).\n`,
    );
    connected = false;
    return 0;
  } catch (exc) {
    if (exc instanceof AuthError) {
      process.stderr.write(`Login failed: ${exc.message}\n`);
      return 1;
    }
    if (exc instanceof ApiError) {
      process.stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  } finally {
    if (connected) {
      await client.unsubscribeEventLog();
      client.close();
    }
    await client.logout();
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) main().then((code) => process.exit(code));
