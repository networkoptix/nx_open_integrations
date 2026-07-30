#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Set the SCHEDULE of an Nx event rule — the v4 modernization of Network Optix's
 * `python/examples/setup_rule_schedule.py`.
 *
 * The original example used the legacy `/ec2/getEventRules` + `/ec2/saveEventRule`
 * transactional API, where a rule's schedule was a packed HEX BITSTREAM that had
 * to be serialized/deserialized by hand (1-hour resolution). The latest
 * **`/rest/v4`** API replaces all of that:
 *
 *   - List rules:   GET   /rest/v4/events/rules            -> [ Rule, ... ]
 *   - Modify a rule: PATCH /rest/v4/events/rules/{id}       (partial body)
 *
 *   The schedule is now a STRUCTURED ARRAY (no bit-twiddling):
 *     schedule: [ { dayOfWeek, startTime, endTime }, ... ]
 *       dayOfWeek : 1=Mon .. 7=Sun
 *       startTime : seconds since 00:00 (0..endTime)
 *       endTime   : seconds since 00:00 (startTime..86400)
 *     An EMPTY array means "always enabled".
 *
 * TypeScript sample. Runs directly on Node 22.6+ via native type stripping — no
 * build step, zero runtime dependencies. Shared API shapes come from
 * ../nx-types.ts (type-only import, stripped at runtime).
 *
 * TWO things it can do (pick one):
 *   --list                 List every rule (id, enabled, comment, schedule).
 *   --rule-id <id> --preset <always|weekdays|weekend|24x7> [--start H --end H]
 *                          PATCH ONE rule's schedule to a preset.
 *
 * BOTH auth modes (same as the other rest- samples):
 *   --mode direct  Local login to one server (NX_SERVER_*).
 *   --mode cloud   Cloud account over the relay (NX_CLOUD_* + Site ID; token
 *                  scoped with cloudSystemId; relay 307 followed manually with
 *                  the bearer re-attached).
 *
 * Reference (legacy): https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/setup_rule_schedule.py
 * v4 API: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type {
  FetchImpl,
  OAuthPasswordGrant,
  TokenResponse,
  LoginRequest,
  LoginResponse,
} from "../nx-types.ts";

export const CLIENT_ID = "3rdParty";
export const RELAY_SUFFIX = ".relay.vmsproxy.com";
// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";
export const RULES_PATH = `${API}/events/rules`;

export const MODE_DIRECT = "direct";
export const MODE_CLOUD = "cloud";
export type Mode = typeof MODE_DIRECT | typeof MODE_CLOUD;

export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;
const MAX_REDIRECTS = 5;

// Schedule presets the CLI offers.
export const PRESETS = ["always", "weekdays", "weekend", "24x7"] as const;
export type Preset = (typeof PRESETS)[number];

// dayOfWeek: 1=Mon .. 7=Sun.
export const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [6, 7];

// ---------------------------------------------------------------------------
// Types specific to this sample (shared auth shapes come from ../nx-types.ts)
// ---------------------------------------------------------------------------

/** One schedule task on a rule (v4 structured form). */
export interface ScheduleTask {
  dayOfWeek: number; // 1=Mon .. 7=Sun
  startTime: number; // seconds since 00:00
  endTime: number; // seconds since 00:00
}

/** An event rule (lenient — the API returns more fields than we touch). */
export interface Rule {
  id: string;
  comment?: string;
  enabled?: boolean;
  schedule?: ScheduleTask[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Schedule helpers (pure — the heart of the sample)
// ---------------------------------------------------------------------------

/**
 * Build a v4 schedule array from a preset.
 *   always  -> []                      (always enabled)
 *   24x7    -> all 7 days, full day
 *   weekdays-> Mon–Fri, startHour..endHour
 *   weekend -> Sat–Sun, startHour..endHour
 * startHour/endHour are whole hours in [0..24], startHour < endHour. They are
 * ignored for "always" and "24x7".
 */
export function buildSchedule(preset: Preset, startHour = 9, endHour = 18): ScheduleTask[] {
  if (preset === "always") return [];
  if (preset === "24x7") {
    return [1, 2, 3, 4, 5, 6, 7].map((d) => ({
      dayOfWeek: d,
      startTime: 0,
      endTime: SECONDS_PER_DAY,
    }));
  }
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || endHour > 24 || startHour >= endHour) {
    throw new ApiError(`Invalid hours: --start ${startHour} --end ${endHour} (need 0 <= start < end <= 24).`);
  }
  const days = preset === "weekdays" ? WEEKDAYS : WEEKEND;
  return days.map((d) => ({
    dayOfWeek: d,
    startTime: startHour * SECONDS_PER_HOUR,
    endTime: endHour * SECONDS_PER_HOUR,
  }));
}

function normalize(s: ScheduleTask[]): ScheduleTask[] {
  return [...s]
    .map((t) => ({ dayOfWeek: t.dayOfWeek, startTime: t.startTime, endTime: t.endTime }))
    .sort((x, y) => x.dayOfWeek - y.dayOfWeek || x.startTime - y.startTime);
}

function hhmm(seconds: number): string {
  const h = Math.floor(seconds / SECONDS_PER_HOUR);
  const m = Math.floor((seconds % SECONDS_PER_HOUR) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Human summary of a schedule for the --list table. */
export function summarizeSchedule(schedule: ScheduleTask[] | undefined): string {
  const tasks = schedule ?? [];
  if (tasks.length === 0) return "always";
  return normalize(tasks)
    .map((t) => `${DAY_NAMES[t.dayOfWeek] ?? t.dayOfWeek} ${hhmm(t.startTime)}-${hhmm(t.endTime)}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Configuration (CLI > env > .env)
// ---------------------------------------------------------------------------

export type EnvValues = Record<string, string>;

export function loadEnvFile(path = ".env"): EnvValues {
  const values: EnvValues = {};
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

export interface CliArgs {
  mode: string | null;
  serverHost: string | null;
  cloudHost: string | null;
  user: string | null;
  password: string | null;
  siteId: string | null;
  mfaCode: string | null;
  list: boolean;
  ruleId: string | null;
  preset: string | null;
  start: string | null;
  end: string | null;
  envFile: string;
  insecure: boolean;
}

export interface ResolvedConfig {
  mode: Mode;
  serverHost?: string;
  cloudHost?: string;
  user?: string;
  password?: string;
  siteId?: string;
  mfaCode: string | null;
}

export function resolveConfig(
  cliArgs: Partial<CliArgs>,
  envFileValues: EnvValues = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const pick = (cliValue: string | null | undefined, envKey: string): string | undefined => {
    if (cliValue !== undefined && cliValue !== null) return cliValue;
    if (env[envKey]) return env[envKey];
    return envFileValues[envKey];
  };
  const mode: Mode = (cliArgs.mode ?? env["NX_MODE"] ?? envFileValues["NX_MODE"]) === MODE_CLOUD
    ? MODE_CLOUD
    : MODE_DIRECT;
  return {
    mode,
    serverHost: pick(cliArgs.serverHost, "NX_SERVER_HOST"),
    cloudHost: pick(cliArgs.cloudHost, "NX_CLOUD_HOST") ?? "https://nxvms.com",
    user: pick(cliArgs.user, mode === MODE_CLOUD ? "NX_CLOUD_USER" : "NX_SERVER_USER"),
    password: pick(cliArgs.password, mode === MODE_CLOUD ? "NX_CLOUD_PASSWORD" : "NX_SERVER_PASSWORD"),
    siteId: pick(cliArgs.siteId, "NX_CLOUD_SITE_ID"),
    mfaCode: cliArgs.mfaCode ?? null,
  };
}

/** Which auth fields are missing for the chosen mode. */
export function missingFields(config: ResolvedConfig): string[] {
  const required: (keyof ResolvedConfig)[] =
    config.mode === MODE_CLOUD
      ? ["cloudHost", "user", "password", "siteId"]
      : ["serverHost", "user", "password"];
  return required.filter((k) => !config[k]);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  serverHost?: string;
  cloudHost?: string;
  siteId?: string;
  mfaCode?: string | null;
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
}

export class NxRuleClient {
  mode: Mode;
  user: string;
  password: string;
  serverHost: string;
  cloudHost: string;
  siteId: string;
  mfaCode: string | null;
  fetchImpl: FetchImpl;
  token: string | null;

  constructor(
    mode: Mode,
    user: string,
    password: string,
    {
      serverHost = "",
      cloudHost = "https://nxvms.com",
      siteId = "",
      mfaCode = null,
      verifyTls = true,
      fetchImpl = fetch,
    }: ClientOptions = {},
  ) {
    this.mode = mode;
    this.user = user;
    this.password = password;
    this.serverHost = (serverHost || "").replace(/\/+$/, "");
    this.cloudHost = (cloudHost || "").replace(/\/+$/, "");
    this.siteId = siteId;
    this.mfaCode = mfaCode;
    this.fetchImpl = fetchImpl;
    this.token = null;
    if (!verifyTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  /** The Cloud relay address for this site (cloud mode). */
  get relayUrl(): string {
    return `https://${this.siteId}${RELAY_SUFFIX}`;
  }

  /** Where rule requests go: the server directly, or the site relay. */
  get apiBase(): string {
    return this.mode === MODE_CLOUD ? this.relayUrl : this.serverHost;
  }

  _authHeader(): Record<string, string> {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  async login(): Promise<string> {
    return this.mode === MODE_CLOUD ? this._loginCloud() : this._loginDirect();
  }

  async _loginDirect(): Promise<string> {
    const url = `${this.serverHost}${API}/login/sessions`;
    const body: LoginRequest = { username: this.user, password: this.password, setCookie: false };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}). Check the username/password, ` +
          "and that it is a LOCAL server account (cloud users use --mode cloud).",
      );
    }
    if (!response.ok) {
      throw new ApiError(`Login failed: HTTP ${response.status} ${(await safeText(response)).slice(0, 200)}`);
    }
    const data = (await response.json()) as LoginResponse;
    this.token = data.token;
    if (!this.token) throw new ApiError("Login response did not contain a token.");
    return this.token;
  }

  async _loginCloud(): Promise<string> {
    const url = `${this.cloudHost}/cdb/oauth2/token`;
    const body: OAuthPasswordGrant = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
      scope: `cloudSystemId=${this.siteId}`,
    };
    if (this.mfaCode) body.mfaCode = this.mfaCode;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}). Check the cloud email/password, ` +
          "the site id, and that the account has access to that site. Add --mfa-code for 2FA.",
      );
    }
    if (!response.ok) {
      throw new ApiError(`Token request failed: HTTP ${response.status} ${(await safeText(response)).slice(0, 200)}`);
    }
    const data = (await response.json()) as TokenResponse;
    this.token = data.access_token;
    if (!this.token) throw new ApiError("Token response did not contain an access_token.");
    return this.token;
  }

  /**
   * Issue a request following the relay's 307 MANUALLY, re-attaching the bearer
   * (and preserving method + body — a 307 keeps both) on each hop. Auto-follow
   * can drop the Authorization header across hosts.
   */
  async _requestFollowing(url: string, init: RequestInit): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await this.fetchImpl(current, { ...init, redirect: "manual" });
      } catch (exc) {
        throw new ApiError(`Could not reach ${current}: ${(exc as Error).message}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return response;
        current = new URL(location, current).toString();
        continue;
      }
      return response;
    }
    throw new ApiError(`Too many redirects (>${MAX_REDIRECTS}) chasing the relay.`);
  }

  async _checkAuthOk(response: Response, what: string): Promise<void> {
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `${what} unauthorized (HTTP ${response.status}). In cloud mode make sure the ` +
          "token was scoped with cloudSystemId for THIS site.",
      );
    }
    if (!response.ok) {
      throw new ApiError(`${what} failed: HTTP ${response.status} ${(await safeText(response)).slice(0, 200)}`);
    }
  }

  /** GET every event rule. */
  async listRules(): Promise<Rule[]> {
    const url = `${this.apiBase}${RULES_PATH}`;
    const response = await this._requestFollowing(url, { headers: this._authHeader() });
    await this._checkAuthOk(response, "Listing rules");
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Rules response was not valid JSON.");
    }
    if (data && typeof data === "object" && Array.isArray((data as { reply?: unknown }).reply)) {
      return (data as { reply: Rule[] }).reply;
    }
    return Array.isArray(data) ? (data as Rule[]) : [];
  }

  /** PATCH one rule's schedule. Returns the modified rule (if the API echoes it). */
  async patchSchedule(ruleId: string, schedule: ScheduleTask[]): Promise<Rule> {
    if (!ruleId) throw new ApiError("A rule id is required to PATCH a schedule.");
    const url = `${this.apiBase}${RULES_PATH}/${encodeURIComponent(ruleId)}`;
    const response = await this._requestFollowing(url, {
      method: "PATCH",
      headers: { ...this._authHeader(), "Content-Type": "application/json" },
      body: JSON.stringify({ schedule }),
    });
    await this._checkAuthOk(response, "Patching rule");
    try {
      return (await response.json()) as Rule;
    } catch {
      // Some servers answer 200 with an empty body; treat as success.
      return { id: ruleId, schedule };
    }
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    const url =
      this.mode === MODE_CLOUD
        ? `${this.cloudHost}/cdb/oauth2/token/${this.token}`
        : `${this.serverHost}${API}/login/sessions/${this.token}`;
    try {
      await this.fetchImpl(url, { method: "DELETE", headers: { Authorization: `Bearer ${this.token}` } });
    } catch {
      // best effort
    } finally {
      this.token = null;
    }
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
// Pretty printing
// ---------------------------------------------------------------------------

export function formatRulesTable(rules: Rule[]): string {
  if (!rules || rules.length === 0) return "No event rules found on this site.";
  const grid: string[][] = [["ID", "ENABLED", "COMMENT", "SCHEDULE"]];
  for (const r of rules) {
    grid.push([
      String(r.id ?? ""),
      r.enabled === false ? "no" : "yes",
      String(r.comment ?? ""),
      summarizeSchedule(r.schedule),
    ]);
  }
  const widths = grid[0]!.map((_, col) => Math.max(...grid.map((row) => row[col]!.length)));
  return grid.map((row) => row.map((cell, col) => cell.padEnd(widths[col]!)).join("  ")).join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
    mode: null,
    serverHost: null,
    cloudHost: null,
    user: null,
    password: null,
    siteId: null,
    mfaCode: null,
    list: false,
    ruleId: null,
    preset: null,
    start: null,
    end: null,
    envFile: ".env",
    insecure: false,
  };
  const map: Record<string, keyof CliArgs> = {
    "--mode": "mode",
    "--server-host": "serverHost",
    "--cloud-host": "cloudHost",
    "--user": "user",
    "--password": "password",
    "--site-id": "siteId",
    "--mfa-code": "mfaCode",
    "--rule-id": "ruleId",
    "--preset": "preset",
    "--start": "start",
    "--end": "end",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  const booleans: Record<string, keyof CliArgs> = {
    "--list": "list",
    "--insecure": "insecure",
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inlineValue: string | null = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) (flags[booleans[arg]!] as boolean) = true;
    else if (arg in map) (flags[map[arg]!] as string) = inlineValue !== null ? inlineValue : argv[++i]!;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}

/** Validate the requested preset string. */
export function normalizePreset(value: string | null | undefined): Preset {
  const s = (value ?? "").trim().toLowerCase();
  if ((PRESETS as readonly string[]).includes(s)) return s as Preset;
  throw new ApiError(`Unknown --preset "${value}". Choose one of: ${PRESETS.join(", ")}.`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`${(exc as Error).message}\n`);
    return 2;
  }

  // Exactly one action must be chosen.
  const actions = [args.list, Boolean(args.ruleId)].filter(Boolean).length;
  if (actions !== 1) {
    process.stderr.write(
      "Choose exactly one action: --list, or --rule-id <id> --preset <preset>.\n",
    );
    return 2;
  }

  const config = resolveConfig(args, loadEnvFile(args.envFile));
  const missing = missingFields(config);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy ../../.env.example). See the README.\n",
    );
    return 2;
  }

  // Validate the set-by-id action up front (before any network call).
  let preset: Preset | null = null;
  let startHour = 9;
  let endHour = 18;
  if (args.ruleId) {
    try {
      preset = normalizePreset(args.preset);
      if (args.start !== null) startHour = Number(args.start);
      if (args.end !== null) endHour = Number(args.end);
      // buildSchedule validates the hour range; call it once to surface errors.
      buildSchedule(preset, startHour, endHour);
    } catch (exc) {
      process.stderr.write(`${(exc as Error).message}\n`);
      return 2;
    }
  }

  const client = new NxRuleClient(config.mode, config.user!, config.password!, {
    serverHost: config.serverHost,
    cloudHost: config.cloudHost,
    siteId: config.siteId,
    mfaCode: config.mfaCode,
    verifyTls: !args.insecure,
  });

  try {
    await client.login();

    if (args.list) {
      process.stdout.write(formatRulesTable(await client.listRules()) + "\n");
      return 0;
    }

    // Set one rule by id.
    const schedule = buildSchedule(preset!, startHour, endHour);
    const updated = await client.patchSchedule(args.ruleId!, schedule);
    process.stdout.write(
      `Set rule ${args.ruleId} schedule -> ${summarizeSchedule(updated.schedule ?? schedule)}\n`,
    );
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
    await client.logout();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
