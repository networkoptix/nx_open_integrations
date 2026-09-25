#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx Cloud CDB API sample (OAuth2 bearer-token flow): log in and list Sites.
 *
 * TypeScript port of ../../node/cdb-oauth2-list-systems. Runs directly on Node
 * 22.6+ via native type stripping — no build step. Built-in `fetch` (Node 18+)
 * and `node:test`, no third-party runtime dependencies. The only dev deps are
 * typescript + @types/node, used for type-checking (see ../tsconfig.json).
 *
 * This project uses bearer-token authentication only (no HTTP Basic). The flow:
 *
 *   1. Log in once: POST /cdb/oauth2/token  -> receive a short-lived bearer token.
 *   2. Use that token (Authorization: Bearer ...) for the actual work.
 *   3. List your Sites:  GET /cdb/systems.
 *
 * Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type {
  FetchImpl,
  OAuthPasswordGrant,
  TokenResponse,
  Site,
} from "../nx-types.ts";

// A fixed client id Nx uses for third-party integrations in their examples.
export const CLIENT_ID = "3rdParty";

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
// Configuration (CLI > env > .env)
// ---------------------------------------------------------------------------

export interface CliArgs {
  host: string | null;
  user: string | null;
  password: string | null;
  mfaCode: string | null;
  cloudSystemId: string | null;
  envFile: string;
  insecure: boolean;
  debug: boolean;
}

export interface ResolvedConfig {
  host?: string;
  user?: string;
  password?: string;
  mfaCode: string | null;
  cloudSystemId?: string;
}

export function loadEnvFile(path: string = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
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

export function resolveConfig(
  cliArgs: CliArgs,
  envFileValues: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const pick = (
    cliValue: string | null | undefined,
    envKey: string,
  ): string | undefined => {
    if (cliValue !== undefined && cliValue !== null) return cliValue;
    if (env[envKey]) return env[envKey];
    return envFileValues[envKey];
  };
  return {
    host: pick(cliArgs.host, "NX_CLOUD_HOST"),
    user: pick(cliArgs.user, "NX_CLOUD_USER"),
    password: pick(cliArgs.password, "NX_CLOUD_PASSWORD"),
    mfaCode: cliArgs.mfaCode,
    cloudSystemId: pick(cliArgs.cloudSystemId, "NX_CLOUD_SITE_ID"),
  };
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

// Keys the CDB might use if it wraps the sites array inside an object.
const SYSTEM_LIST_KEYS = ["sites", "reply", "results", "items", "data"];

/**
 * Pull the list of sites out of the response, whatever its shape: a bare
 * array, or an object wrapping the array under a known key, or (last resort)
 * the first list-of-objects value found. Returns [] only when there is none.
 */
export function extractSystems(data: unknown): Site[] {
  if (Array.isArray(data)) return data as Site[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of SYSTEM_LIST_KEYS) {
      const value = obj[key];
      if (Array.isArray(value)) return value as Site[];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = extractSystems(value);
        if (nested.length) return nested;
      }
    }
    for (const value of Object.values(obj)) {
      if (
        Array.isArray(value) &&
        (value.length === 0 || (value[0] && typeof value[0] === "object"))
      ) {
        return value as Site[];
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  mfaCode?: string | null;
  cloudSystemId?: string | null;
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
  timeout?: number;
}

export class NxCloudOAuthClient {
  host: string;
  user: string;
  password: string;
  mfaCode: string | null;
  // Token scope:
  //   cloudSystemId null -> a CLOUD (cdb) token. Use it for account-level CDB
  //     calls such as listing Sites (what this sample does).
  //   cloudSystemId set  -> a SITE-SCOPED token, required to operate against
  //     ONE site. See ../rest-list-cameras-cloud-user for that flow.
  cloudSystemId: string | null;
  fetchImpl: FetchImpl;
  timeout: number;
  token: string | null;
  lastRaw: unknown;

  constructor(
    host: string,
    user: string,
    password: string,
    {
      mfaCode = null,
      cloudSystemId = null,
      verifyTls = true,
      fetchImpl = (...a: Parameters<FetchImpl>) => globalThis.fetch(...a),
      timeout = 15000,
    }: ClientOptions = {},
  ) {
    this.host = (host || "").replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.mfaCode = mfaCode;
    this.cloudSystemId = cloudSystemId;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.token = null;
    this.lastRaw = null;
    if (!verifyTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
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

  async login(): Promise<string> {
    const url = `${this.host}/cdb/oauth2/token`;
    const body: OAuthPasswordGrant = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
    };
    if (this.mfaCode) body.mfaCode = this.mfaCode;
    // Adding a scope ties the token to ONE site. Omit it for a cloud-wide token.
    if (this.cloudSystemId) body.scope = `cloudSystemId=${this.cloudSystemId}`;

    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}). Check your credentials; ` +
          "if 2FA is enabled, pass --mfa-code.",
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

  _authHeader(): Record<string, string> {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  async listSystems(): Promise<Site[]> {
    const url = `${this.host}/cdb/systems`;
    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError("Token was rejected. It may have expired; log in again.");
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(
        `Listing sites failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Sites response was not valid JSON.");
    }
    this.lastRaw = data;
    return extractSystems(data);
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

export function formatSystemsTable(sites: Site[]): string {
  if (!sites || sites.length === 0) {
    return "No Sites found on this account.";
  }
  const rows: string[][] = [["NAME", "STATUS", "VERSION", "ID"]];
  for (const site of sites) {
    rows.push([
      String(site.name ?? ""),
      String(site.status ?? ""),
      String(site.version ?? ""),
      String(site.id ?? ""),
    ]);
  }
  const widths = rows[0]!.map((_, col) =>
    Math.max(...rows.map((r) => r[col]!.length)),
  );
  return rows
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col]!)).join("  "))
    .join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
    host: null,
    user: null,
    password: null,
    mfaCode: null,
    cloudSystemId: null,
    envFile: ".env",
    insecure: false,
    debug: false,
  };
  const map: Record<string, keyof CliArgs> = {
    "--host": "host",
    "--user": "user",
    "--password": "password",
    "--mfa-code": "mfaCode",
    "--cloud-site-id": "cloudSystemId",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  const booleans: Record<string, keyof CliArgs> = {
    "--insecure": "insecure",
    "--debug": "debug",
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inlineValue: string | null = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) {
      (flags[booleans[arg]!] as boolean) = true;
    } else if (arg in map) {
      (flags[map[arg]!] as string) = inlineValue !== null ? inlineValue : argv[++i]!;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`${(exc as Error).message}\n`);
    return 2;
  }
  const config = resolveConfig(args, loadEnvFile(args.envFile));

  const missing = (["host", "user", "password"] as const).filter(
    (n) => !config[n],
  );
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy .env.example). See the README.\n",
    );
    return 2;
  }

  const client = new NxCloudOAuthClient(
    config.host!,
    config.user!,
    config.password!,
    {
      mfaCode: config.mfaCode,
      cloudSystemId: config.cloudSystemId,
      verifyTls: !args.insecure,
    },
  );

  try {
    await client.login();
    process.stdout.write(`Logged in as: ${config.user} (bearer token acquired)\n\n`);
    const sites = await client.listSystems();
    if (args.debug) {
      process.stderr.write("--- raw /cdb/systems response ---\n");
      process.stderr.write(
        JSON.stringify(client.lastRaw, null, 2).slice(0, 4000) + "\n",
      );
      process.stderr.write("--- end raw ---\n\n");
    }
    process.stdout.write(formatSystemsTable(sites) + "\n");
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
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
