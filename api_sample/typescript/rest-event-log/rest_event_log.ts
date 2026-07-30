#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST API sample: read a site's event log via the Cloud relay.
 *
 * TypeScript port of ../../node/rest-event-log. Runs directly on Node 22.6+ via
 * native type stripping (`node rest_event_log.ts`) — no build step. Uses the
 * built-in global `fetch` and `node:test`, with no third-party runtime
 * dependencies. Uses the latest v4 event endpoint.
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

import type {
  EventLogQuery,
  EventManifest,
  EventRecord,
  EventRow,
  FetchImpl,
  ManifestEntry,
  OAuthPasswordGrant,
  TokenResponse,
} from "../nx-types.ts";

export const CLIENT_ID: OAuthPasswordGrant["client_id"] = "3rdParty";
export const RELAY_SUFFIX = ".relay.vmsproxy.com";
export const EVENTS_PATH = "/rest/v4/events/log";
export const MANIFEST_PATH = "/rest/v4/events/manifest/events";
export const MAX_REDIRECTS = 5;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when the cloud or the site rejects the token (bad credentials / 2FA). */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Raised for any other unexpected API/network failure. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Configuration (CLI > env > .env)
// ---------------------------------------------------------------------------

/** A simple KEY=VALUE map parsed from a .env file. */
export type EnvFileValues = Record<string, string>;

/** Resolved configuration after applying precedence. */
export interface ResolvedConfig {
  cloudHost: string | undefined;
  user: string | undefined;
  password: string | undefined;
  siteId: string | undefined;
  mfaCode: string | null;
  token: string | null;
}

/** Read a simple KEY=VALUE .env file into an object. Missing file -> {}. */
export function loadEnvFile(path: string = ".env"): EnvFileValues {
  const values: EnvFileValues = {};
  if (!path || !fs.existsSync(path)) {
    return values;
  }
  const text: string = fs.readFileSync(path, "utf-8");
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const idx: number = line.indexOf("=");
    const key: string = line.slice(0, idx).trim();
    let value: string = line.slice(idx + 1).trim();
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

/** CLI flag > OS environment variable > .env file. */
export function resolveConfig(
  cliArgs: CliArgs,
  envFileValues: EnvFileValues = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const pick = (
    cliValue: string | null | undefined,
    envKey: string,
  ): string | undefined => {
    if (cliValue !== undefined && cliValue !== null) {
      return cliValue;
    }
    if (env[envKey]) {
      return env[envKey];
    }
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
export function msToIso(ms: number | string | null | undefined): string {
  const n = Number(ms);
  if (ms === null || ms === undefined || Number.isNaN(n)) {
    return String(ms);
  }
  // "2026-06-12T14:30:00.000Z" -> "2026-06-12 14:30:00"
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i;
const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
  w: 604800000,
};

/**
 * Parse a duration like '30m', '24h', '7d', '2w' into milliseconds. A unit
 * suffix is required (s/m/h/d/w) so a bare number can't be misread.
 */
export function parseDuration(text: string): number {
  const match = DURATION_RE.exec(text || "");
  if (!match) {
    throw new RangeError(
      `Invalid duration '${text}'. Use a number + unit (s, m, h, d, w), e.g. 30m, 24h, 7d, 2w.`,
    );
  }
  const value = Number.parseFloat(match[1] as string);
  const unit = (match[2] as string).toLowerCase();
  return Math.trunc(value * (UNIT_MS[unit] as number));
}

/**
 * Parse an absolute time into epoch milliseconds. Accepts epoch milliseconds,
 * epoch seconds, or ISO 8601. Naive (timezone-less) times are treated as UTC.
 */
export function parseTime(text: string): number {
  text = (text || "").trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return text.length >= 13 ? n : n * 1000; // 13+ digits = ms
  }
  let s = text;
  const hasTz = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s);
  if (!hasTz && s.includes("T")) {
    s += "Z"; // naive time -> UTC
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new RangeError(
      `Invalid time '${text}'. Use ISO 8601 (e.g. 2026-06-10T14:00:00Z) or an epoch timestamp.`,
    );
  }
  return ms;
}

/** Options for {@link resolveWindow}. */
export interface WindowOptions {
  since?: string;
  start?: string | null;
  end?: string | null;
}

/**
 * Return [startMs, durationMs] from --since OR --start/--end. If --start is
 * given it wins (with --end defaulting to now); otherwise the window is the
 * last <since> ending now.
 */
export function resolveWindow(
  nowMs: number,
  { since = "24h", start = null, end = null }: WindowOptions = {},
): [number, number] {
  if (start) {
    const startMs = parseTime(start);
    const endMs = end ? parseTime(end) : nowMs;
    if (endMs < startMs) {
      throw new RangeError("--end is before --start.");
    }
    return [startMs, endMs - startMs];
  }
  const durationMs = parseDuration(since);
  return [nowMs - durationMs, durationMs];
}

/** Return the first present, truthy value among keys in object d. */
function first(d: Record<string, unknown> | undefined, ...keys: string[]): string {
  if (d && typeof d === "object") {
    for (const k of keys) {
      if (d[k]) {
        return String(d[k]);
      }
    }
  }
  return "";
}

/**
 * Flatten one v4 event-log record into a simple row for display. A record
 * is { timestampMs, eventData{}, actionData{}, ruleId, flags }; eventData /
 * actionData are maps keyed by manifest field names.
 */
export function normalizeEvent(record: EventRecord): EventRow {
  const eventData =
    record && typeof record === "object" ? record.eventData || {} : {};
  const actionData =
    record && typeof record === "object" ? record.actionData || {} : {};
  return {
    timeIso: msToIso(record && record.timestampMs),
    eventType: first(eventData, "eventType", "type"),
    resource: first(eventData, "caption", "resourceName", "eventResourceId", "source"),
    actionType: first(actionData, "actionType", "type"),
  };
}

export function formatEventsTable(events: EventRow[]): string {
  if (!events || events.length === 0) {
    return "No events in this time range.";
  }
  const rows: string[][] = [["TIME (UTC)", "EVENT", "ACTION", "RESOURCE"]];
  for (const ev of events) {
    rows.push([
      String(ev.timeIso ?? ""),
      String(ev.eventType ?? ""),
      String(ev.actionType ?? ""),
      String(ev.resource ?? ""),
    ]);
  }
  const header = rows[0] as string[];
  const widths = header.map((_, col) =>
    Math.max(...rows.map((r) => (r[col] as string).length)),
  );
  return rows
    .map((row) =>
      row.map((cell, col) => cell.padEnd(widths[col] as number)).join("  "),
    )
    .join("\n");
}

/**
 * Parse the v4 event-type manifest into a sorted [id, displayName] list. The
 * manifest is a JSON OBJECT MAP keyed by event-type id; each value has at least
 * `id` and `displayName`. Parse defensively: if a value lacks `id`, fall back to
 * the map key; if it lacks `displayName`, fall back to the id.
 */
export function normalizeManifest(
  data: EventManifest | null | undefined,
): Array<[string, string]> {
  if (!data || typeof data !== "object") {
    return [];
  }
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(data)) {
    const entry: Partial<ManifestEntry> =
      value && typeof value === "object" ? value : {};
    const id = entry.id || key;
    const displayName = entry.displayName || id;
    rows.push([id, displayName]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  return rows;
}

export function formatManifestTable(rows: Array<[string, string]>): string {
  if (!rows || rows.length === 0) {
    return "No event types reported by this site.";
  }
  const all: string[][] = [
    ["ID", "DISPLAY NAME"],
    ...rows.map(([id, name]) => [String(id), String(name)]),
  ];
  const header = all[0] as string[];
  const widths = header.map((_, col) =>
    Math.max(...all.map((r) => (r[col] as string).length)),
  );
  return all
    .map((row) =>
      row.map((cell, col) => cell.padEnd(widths[col] as number)).join("  "),
    )
    .join("\n");
}

/** Options for the v4 event-log query. */
export interface EventLogOptions {
  eventType?: string[] | string | null;
  actionType?: string[] | string | null;
  order?: "asc" | "desc";
  limit?: number;
}

/**
 * Assemble the v4 query parameters as a typed object. eventType/actionType are
 * arrays (repeatable query params built by toQueryString()).
 */
export function buildEventParams(
  startMs: number,
  durationMs: number,
  { eventType = null, actionType = null, order = "desc", limit = 50 }: EventLogOptions = {},
): EventLogQuery {
  const params: EventLogQuery = {
    startTimeMs: startMs,
    durationMs: durationMs,
    order,
    limit,
  };
  if (eventType) {
    params.eventType = Array.isArray(eventType) ? eventType : [eventType];
  }
  if (actionType) {
    params.actionType = Array.isArray(actionType) ? actionType : [actionType];
  }
  return params;
}

/** Turn the typed params into a query string, repeating array params. */
export function toQueryString(params: EventLogQuery): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => usp.append(key, String(v)));
    } else {
      usp.append(key, String(value));
    }
  }
  return usp.toString();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Options for the {@link NxCloudEventLogClient} constructor. */
export interface ClientOptions {
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
  timeout?: number;
}

export class NxCloudEventLogClient {
  cloudHost: string;
  siteId: string;
  fetchImpl: FetchImpl;
  timeout: number;
  token: string | null;
  lastRaw: unknown;

  constructor(
    cloudHost: string,
    siteId: string,
    { verifyTls = true, fetchImpl, timeout = 15000 }: ClientOptions = {},
  ) {
    this.cloudHost = (cloudHost || "").replace(/\/+$/, "");
    this.siteId = siteId;
    this.fetchImpl =
      fetchImpl ??
      (((...a: Parameters<FetchImpl>) => globalThis.fetch(...a)) as FetchImpl);
    this.timeout = timeout;
    this.token = null;
    this.lastRaw = null;
    if (!verifyTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  get relayUrl(): string {
    return `https://${this.siteId}${RELAY_SUFFIX}`;
  }

  /** fetchImpl wrapper that aborts the request after `this.timeout` ms. */
  async _fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async login(
    user: string,
    password: string,
    mfaCode: string | null = null,
  ): Promise<string> {
    const url = `${this.cloudHost}/cdb/oauth2/token`;
    const body: OAuthPasswordGrant = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: user,
      password: password,
      scope: `cloudSystemId=${this.siteId}`,
    };
    if (mfaCode) {
      body.mfaCode = mfaCode;
    }
    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      throw new ApiError(`Could not reach ${url}: ${message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}). Check credentials, the ` +
          "site id, and access; add --mfa-code for a 2FA account.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(
        `Token request failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    let data: TokenResponse;
    try {
      data = (await response.json()) as TokenResponse;
    } catch {
      throw new ApiError("Token response was not valid JSON.");
    }
    this.token = data.access_token;
    if (!this.token) {
      throw new ApiError("Token response did not contain an access_token.");
    }
    return this.token;
  }

  /** Use a scoped bearer token obtained elsewhere. */
  useToken(token: string): void {
    this.token = token;
  }

  _authHeader(): Record<string, string> {
    if (!this.token) {
      throw new ApiError("No token. Call login() or useToken() first.");
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * GET that follows 307 redirects MANUALLY, re-attaching the bearer. The relay
   * replies 307 pointing at the serving node. We resend the Authorization
   * header ourselves so it survives the cross-host hop. Query params only need
   * to go on the first request; the redirect Location carries them.
   */
  async getFollowingRedirects(
    baseUrl: string,
    query: string | null,
  ): Promise<Response> {
    const headers = this._authHeader();
    let url = query ? `${baseUrl}?${query}` : baseUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await this._fetchWithTimeout(url, { headers, redirect: "manual" });
      } catch (exc) {
        const message = exc instanceof Error ? exc.message : String(exc);
        throw new ApiError(`Could not reach ${url}: ${message}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new ApiError(
            `Redirect ${response.status} without a Location header.`,
          );
        }
        url = location; // params are already in the Location
        continue;
      }
      return response;
    }
    throw new ApiError("Too many redirects from the relay.");
  }

  async getEventLog(
    startMs: number,
    durationMs: number,
    { eventType = null, actionType = null, order = "desc", limit = 50 }: EventLogOptions = {},
  ): Promise<EventRow[]> {
    const baseUrl = `${this.relayUrl}${EVENTS_PATH}`;
    const params = buildEventParams(startMs, durationMs, {
      eventType,
      actionType,
      order,
      limit,
    });
    const response = await this.getFollowingRedirects(
      baseUrl,
      toQueryString(params),
    );

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The site rejected the token. Make sure it was scoped with cloudSystemId for THIS site.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(
        `Reading events failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Events response was not valid JSON.");
    }
    this.lastRaw = data;
    const records: EventRecord[] = Array.isArray(data)
      ? (data as EventRecord[])
      : [];
    return records.map((r) => normalizeEvent(r));
  }

  /**
   * Fetch the site's event-type manifest and return a sorted [id, displayName]
   * list. Same relay + 307 + scoped-token plumbing as getEventLog(); the
   * manifest is the live, per-site source of truth for which event types exist.
   */
  async getEventManifest(): Promise<Array<[string, string]>> {
    const baseUrl = `${this.relayUrl}${MANIFEST_PATH}`;
    const response = await this.getFollowingRedirects(baseUrl, null);

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The site rejected the token. Make sure it was scoped with cloudSystemId for THIS site.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(
        `Reading the manifest failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    let data: EventManifest;
    try {
      data = (await response.json()) as EventManifest;
    } catch {
      throw new ApiError("Manifest response was not valid JSON.");
    }
    this.lastRaw = data;
    return normalizeManifest(data);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Parsed CLI flags. */
export interface CliArgs {
  cloudHost: string | null;
  user: string | null;
  password: string | null;
  siteId: string | null;
  token: string | null;
  mfaCode: string | null;
  since: string;
  start: string | null;
  end: string | null;
  eventType: string[] | null;
  actionType: string[] | null;
  order: "asc" | "desc";
  limit: number;
  envFile: string;
  listEventTypes: boolean;
  insecure: boolean;
  debug: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
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
  const map: Record<string, keyof CliArgs> = {
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
  const appends: Record<string, keyof CliArgs> = {
    "--event-type": "eventType",
    "--action-type": "actionType",
  };
  const booleans: Record<string, keyof CliArgs> = {
    "--list-event-types": "listEventTypes",
    "--insecure": "insecure",
    "--debug": "debug",
  };
  for (let i = 0; i < argv.length; i++) {
    let arg: string = argv[i] as string;
    let inlineValue: string | null = null;
    if (arg.includes("=")) {
      const eq: number = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const valueOf = (): string =>
      inlineValue !== null ? inlineValue : (argv[++i] as string);
    if (arg in booleans) {
      const key = booleans[arg] as keyof CliArgs;
      (flags[key] as boolean) = true;
    } else if (arg === "--limit") {
      flags.limit = Number.parseInt(valueOf(), 10);
    } else if (arg in appends) {
      const key = appends[arg] as keyof CliArgs;
      const current = (flags[key] as string[] | null) || [];
      current.push(valueOf());
      (flags[key] as string[]) = current;
    } else if (arg in map) {
      const key = map[arg] as keyof CliArgs;
      (flags[key] as string) = valueOf();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`${message}\n`);
    return 2;
  }
  const config: ResolvedConfig = resolveConfig(args, loadEnvFile(args.envFile));

  for (const name of ["cloudHost", "siteId"] as Array<keyof ResolvedConfig>) {
    if (!config[name]) {
      process.stderr.write(`Missing config: ${name}. See the README.\n`);
      return 2;
    }
  }

  const client = new NxCloudEventLogClient(
    config.cloudHost as string,
    config.siteId as string,
    { verifyTls: !args.insecure },
  );

  const nowMs = Date.now();
  let startMs: number;
  let durationMs: number;
  try {
    [startMs, durationMs] = resolveWindow(nowMs, {
      since: args.since,
      start: args.start,
      end: args.end,
    });
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    process.stderr.write(`Error: ${message}\n`);
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
        process.stderr.write(
          JSON.stringify(client.lastRaw, null, 2).slice(0, 4000) + "\n",
        );
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
      process.stderr.write(
        JSON.stringify(client.lastRaw, null, 2).slice(0, 4000) + "\n",
      );
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

// Run only when invoked directly (not when imported by the tests).
const invokedDirectly: boolean =
  !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
