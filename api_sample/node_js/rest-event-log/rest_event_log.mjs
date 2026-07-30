#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST API sample: read a site's event log via the Cloud relay.
 *
 * Node.js port of ../../python/rest-event-log. Built-in `fetch` (Node 18+) and
 * `node:test`, no third-party dependencies. Uses the latest v4 event endpoint.
 *
 * This reads the event history of ONE site using a CLOUD account:
 *
 *   1. Get a token from the cloud, SCOPED to the target site:
 *        POST {cloud}/cdb/oauth2/token
 *        { grant_type:"password", response_type:"token", client_id:"3rdParty",
 *          username, password, scope:"cloudSystemId=<site id>" }
 *      (or pass an existing scoped token with --token)
 *   2. Reach the site through the Cloud relay:
 *        https://<site id>.relay.vmsproxy.com
 *   3. Read the event log (the v4 endpoint):
 *        GET /rest/v4/events/log?startTimeMs=<ms>&durationMs=<ms>[&eventType=...]
 *        Header: Authorization: Bearer <token>
 *
 * Important: the relay answers with an HTTP 307 redirect to the node that
 * actually serves the request. Browsers/agents that auto-follow may DROP the
 * Authorization header on a cross-host redirect, so we use redirect:"manual"
 * and follow the 307 ourselves, re-attaching the bearer header. See
 * getFollowingRedirects().
 *
 * Contract (from the v4 OpenAPI spec):
 *   - Time window is startTimeMs + durationMs (milliseconds), NOT from/to.
 *   - eventType and actionType are LISTS (repeatable query params).
 *   - Each response record is:
 *       { timestampMs, eventData{}, actionData{}, aggregatedInfo{}, ruleId, flags }
 *     where eventData / actionData are maps keyed by manifest field names.
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const CLIENT_ID = "3rdParty";
export const RELAY_SUFFIX = ".relay.vmsproxy.com";
export const EVENTS_PATH = "/rest/v4/events/log";
export const MANIFEST_PATH = "/rest/v4/events/manifest/events";
export const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Configuration (CLI > env > .env)
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
    cloudHost: pick(cliArgs.cloudHost, "NX_CLOUD_HOST"),
    user: pick(cliArgs.user, "NX_CLOUD_USER"),
    password: pick(cliArgs.password, "NX_CLOUD_PASSWORD"),
    siteId: pick(cliArgs.siteId, "NX_CLOUD_SITE_ID"),
    mfaCode: cliArgs.mfaCode,
    token: cliArgs.token,
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers (pure functions = easy to test)
// ---------------------------------------------------------------------------

/** Convert an epoch-millisecond timestamp to a readable UTC string. */
export function msToIso(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || Number.isNaN(n)) return String(ms);
  // "2026-06-12T14:30:00.000Z" -> "2026-06-12 14:30:00"
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i;
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

/**
 * Parse a duration like '30m', '24h', '7d', '2w' into milliseconds. A unit
 * suffix is required (s/m/h/d/w) so a bare number can't be misread.
 */
export function parseDuration(text) {
  const match = DURATION_RE.exec(text || "");
  if (!match) {
    throw new RangeError(
      `Invalid duration '${text}'. Use a number + unit (s, m, h, d, w), e.g. 30m, 24h, 7d, 2w.`,
    );
  }
  const value = Number.parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  return Math.trunc(value * UNIT_MS[unit]);
}

/**
 * Parse an absolute time into epoch milliseconds. Accepts epoch milliseconds,
 * epoch seconds, or ISO 8601. Naive (timezone-less) times are treated as UTC.
 */
export function parseTime(text) {
  text = (text || "").trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return text.length >= 13 ? n : n * 1000; // 13+ digits = ms
  }
  let s = text;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  if (!hasTz && s.includes("T")) s += "Z"; // naive time -> UTC
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new RangeError(
      `Invalid time '${text}'. Use ISO 8601 (e.g. 2026-06-10T14:00:00Z) or an epoch timestamp.`,
    );
  }
  return ms;
}

/**
 * Return [startMs, durationMs] from --since OR --start/--end. If --start is
 * given it wins (with --end defaulting to now); otherwise the window is the
 * last <since> ending now.
 */
export function resolveWindow(nowMs, { since = "24h", start = null, end = null } = {}) {
  if (start) {
    const startMs = parseTime(start);
    const endMs = end ? parseTime(end) : nowMs;
    if (endMs < startMs) throw new RangeError("--end is before --start.");
    return [startMs, endMs - startMs];
  }
  const durationMs = parseDuration(since);
  return [nowMs - durationMs, durationMs];
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
 * Flatten one v4 event-log record into a simple object for display. A record
 * is { timestampMs, eventData{}, actionData{}, ruleId, flags }; eventData /
 * actionData are maps keyed by manifest field names.
 */
export function normalizeEvent(record) {
  const eventData = record && typeof record === "object" ? record.eventData || {} : {};
  const actionData = record && typeof record === "object" ? record.actionData || {} : {};
  return {
    time: msToIso(record && record.timestampMs),
    event_type: first(eventData, "eventType", "type"),
    resource: first(eventData, "caption", "resourceName", "eventResourceId", "source"),
    action_type: first(actionData, "actionType", "type"),
  };
}

export function formatEventsTable(events) {
  if (!events || events.length === 0) return "No events in this time range.";
  const rows = [["TIME (UTC)", "EVENT", "ACTION", "RESOURCE"]];
  for (const ev of events) {
    rows.push([
      String(ev.time ?? ""),
      String(ev.event_type ?? ""),
      String(ev.action_type ?? ""),
      String(ev.resource ?? ""),
    ]);
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  "))
    .join("\n");
}

/**
 * Parse the v4 event-type manifest into a sorted [id, displayName] list. The
 * manifest is a JSON OBJECT MAP keyed by event-type id; each value has at least
 * `id` and `displayName`. Parse defensively: if a value lacks `id`, fall back to
 * the map key; if it lacks `displayName`, fall back to the id.
 */
export function normalizeManifest(data) {
  if (!data || typeof data !== "object") return [];
  const rows = [];
  for (const [key, value] of Object.entries(data)) {
    const entry = value && typeof value === "object" ? value : {};
    const id = entry.id || key;
    const displayName = entry.displayName || id;
    rows.push([id, displayName]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return rows;
}

export function formatManifestTable(rows) {
  if (!rows || rows.length === 0) return "No event types reported by this site.";
  const all = [["ID", "DISPLAY NAME"], ...rows.map(([id, name]) => [String(id), String(name)])];
  const widths = all[0].map((_, col) => Math.max(...all.map((r) => r[col].length)));
  return all
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  "))
    .join("\n");
}

/**
 * Assemble the v4 query parameters as a plain object. eventType/actionType are
 * arrays (repeatable query params built by toQueryString()).
 */
export function buildEventParams(startMs, durationMs, { eventType = null, actionType = null, order = "desc", limit = 50 } = {}) {
  const params = {
    startTimeMs: String(startMs),
    durationMs: String(durationMs),
    order,
    limit: String(limit),
  };
  if (eventType) params.eventType = Array.isArray(eventType) ? eventType : [eventType];
  if (actionType) params.actionType = Array.isArray(actionType) ? actionType : [actionType];
  return params;
}

/** Turn the params object into a query string, repeating array params. */
export function toQueryString(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => usp.append(key, v));
    else usp.append(key, value);
  }
  return usp.toString();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxCloudEventLogClient {
  constructor(cloudHost, siteId, { verifyTls = true, fetchImpl = fetch, timeout = 15000 } = {}) {
    this.cloudHost = (cloudHost || "").replace(/\/+$/, "");
    this.siteId = siteId;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.token = null;
    this.lastRaw = null;
    if (!verifyTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  get relayUrl() {
    return `https://${this.siteId}${RELAY_SUFFIX}`;
  }

  /** fetchImpl wrapper that aborts the request after `this.timeout` ms. */
  async _fetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async login(user, password, mfaCode = null) {
    const url = `${this.cloudHost}/cdb/oauth2/token`;
    const body = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: user,
      password: password,
      scope: `cloudSystemId=${this.siteId}`,
    };
    if (mfaCode) body.mfaCode = mfaCode;
    let response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${exc.message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}). Check credentials, the ` +
          "site id, and access; add --mfa-code for a 2FA account.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Token request failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
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

  /** Use a scoped bearer token obtained elsewhere. */
  useToken(token) {
    this.token = token;
  }

  _authHeader() {
    if (!this.token) throw new ApiError("No token. Call login() or useToken() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * GET that follows 307 redirects MANUALLY, re-attaching the bearer. The relay
   * replies 307 pointing at the serving node. We resend the Authorization
   * header ourselves so it survives the cross-host hop. Query params only need
   * to go on the first request; the redirect Location carries them.
   */
  async getFollowingRedirects(baseUrl, query) {
    const headers = this._authHeader();
    let url = query ? `${baseUrl}?${query}` : baseUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response;
      try {
        response = await this._fetchWithTimeout(url, { headers, redirect: "manual" });
      } catch (exc) {
        throw new ApiError(`Could not reach ${url}: ${exc.message}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new ApiError(`Redirect ${response.status} without a Location header.`);
        url = location; // params are already in the Location
        continue;
      }
      return response;
    }
    throw new ApiError("Too many redirects from the relay.");
  }

  async getEventLog(startMs, durationMs, { eventType = null, actionType = null, order = "desc", limit = 50 } = {}) {
    const baseUrl = `${this.relayUrl}${EVENTS_PATH}`;
    const params = buildEventParams(startMs, durationMs, { eventType, actionType, order, limit });
    const response = await this.getFollowingRedirects(baseUrl, toQueryString(params));

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The site rejected the token. Make sure it was scoped with cloudSystemId for THIS site.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Reading events failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Events response was not valid JSON.");
    }
    this.lastRaw = data;
    const records = Array.isArray(data) ? data : [];
    return records.map((r) => normalizeEvent(r));
  }

  /**
   * Fetch the site's event-type manifest and return a sorted [id, displayName]
   * list. Same relay + 307 + scoped-token plumbing as getEventLog(); the
   * manifest is the live, per-site source of truth for which event types exist.
   */
  async getEventManifest() {
    const baseUrl = `${this.relayUrl}${MANIFEST_PATH}`;
    const response = await this.getFollowingRedirects(baseUrl, null);

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The site rejected the token. Make sure it was scoped with cloudSystemId for THIS site.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Reading the manifest failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Manifest response was not valid JSON.");
    }
    this.lastRaw = data;
    return normalizeManifest(data);
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = {
    cloudHost: null,
    user: null,
    password: null,
    siteId: null,
    token: null,
    mfaCode: null,
    since: "24h",
    start: null,
    end: null,
    eventType: null,
    actionType: null,
    order: "desc",
    limit: 50,
    envFile: ".env",
    listEventTypes: false,
    insecure: false,
    debug: false,
  };
  const map = {
    "--cloud-host": "cloudHost",
    "--user": "user",
    "--password": "password",
    "--site-id": "siteId",
    "--token": "token",
    "--mfa-code": "mfaCode",
    "--since": "since",
    "--start": "start",
    "--end": "end",
    "--order": "order",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  // Repeatable (append) flags.
  const appends = { "--event-type": "eventType", "--action-type": "actionType" };
  const booleans = {
    "--list-event-types": "listEventTypes",
    "--insecure": "insecure",
    "--debug": "debug",
  };
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
    else if (arg === "--limit") flags.limit = Number.parseInt(valueOf(), 10);
    else if (arg in appends) {
      const key = appends[arg];
      flags[key] = flags[key] || [];
      flags[key].push(valueOf());
    } else if (arg in map) flags[map[arg]] = valueOf();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
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

  for (const name of ["cloudHost", "siteId"]) {
    if (!config[name]) {
      process.stderr.write(`Missing config: ${name}. See the README.\n`);
      return 2;
    }
  }

  const client = new NxCloudEventLogClient(config.cloudHost, config.siteId, {
    verifyTls: !args.insecure,
  });

  const nowMs = Date.now();
  let startMs;
  let durationMs;
  try {
    [startMs, durationMs] = resolveWindow(nowMs, { since: args.since, start: args.start, end: args.end });
  } catch (exc) {
    process.stderr.write(`Error: ${exc.message}\n`);
    return 2;
  }

  try {
    if (config.token) {
      client.useToken(config.token);
    } else if (config.user && config.password) {
      await client.login(config.user, config.password, config.mfaCode);
    } else {
      process.stderr.write("Provide --user/--password to log in, or --token.\n");
      return 2;
    }

    if (args.listEventTypes) {
      const manifest = await client.getEventManifest();

      if (args.debug) {
        process.stderr.write("--- raw manifest response (truncated) ---\n");
        process.stderr.write(JSON.stringify(client.lastRaw, null, 2).slice(0, 4000) + "\n");
        process.stderr.write("--- end raw ---\n");
      }

      process.stdout.write(
        `Event types for ${config.siteId}   (${manifest.length} types)\n\n`,
      );
      process.stdout.write(formatManifestTable(manifest) + "\n");
      return 0;
    }

    const events = await client.getEventLog(startMs, durationMs, {
      eventType: args.eventType,
      actionType: args.actionType,
      order: args.order,
      limit: args.limit,
    });

    if (args.debug) {
      process.stderr.write("--- raw events response (truncated) ---\n");
      process.stderr.write(JSON.stringify(client.lastRaw, null, 2).slice(0, 4000) + "\n");
      process.stderr.write("--- end raw ---\n");
    }

    process.stdout.write(
      `Events for ${config.siteId}\n` +
        `window: ${msToIso(startMs)} -> ${msToIso(startMs + durationMs)} UTC` +
        `   (${events.length} events)\n\n`,
    );
    process.stdout.write(formatEventsTable(events) + "\n");
    return 0;
  } catch (exc) {
    if (exc instanceof AuthError) {
      process.stderr.write(`Auth failed: ${exc.message}\n`);
      return 1;
    }
    if (exc instanceof ApiError) {
      process.stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
