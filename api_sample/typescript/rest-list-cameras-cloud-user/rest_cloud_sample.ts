#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * List cameras on a SPECIFIC site using a CLOUD account.
 *
 * TypeScript port of ../../node/rest-list-cameras-cloud-user, on the latest
 * /rest/v4 API. Runs directly on Node 22.6+ via native type stripping — no
 * build step, zero runtime dependencies. Built-in `fetch` (Node 18+) and
 * `node:test`. Shared API shapes come from ../nx-types.ts (type-only import,
 * stripped at runtime).
 *
 * This is the cloud-user counterpart of ../rest-list-cameras (a local server
 * user). The key difference is the token:
 *
 *   - A cloud-wide token (no scope) is NOT accepted by an individual site.
 *   - To call a site's API you need a token SCOPED to that site, obtained from
 *     the cloud with  scope = "cloudSystemId=<your-site-id>".
 *
 * Flow (matches Network Optix's official cloud_bearer.py example):
 *
 *   1. Get a site-scoped token:
 *        POST {cloud}/cdb/oauth2/token
 *        { grant_type:password, response_type:token, client_id:3rdParty,
 *          username, password, scope:"cloudSystemId=<id>" }
 *   2. Reach the site through the Cloud relay:
 *        https://<site-id>.relay.vmsproxy.com
 *   3. List cameras:
 *        GET /rest/v4/devices   (Authorization: Bearer <site-token>)
 *   4. Delete the token on the cloud when done:
 *        DELETE {cloud}/cdb/oauth2/token/<site-token>
 *
 * Reference: https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/authentication/cloud_bearer.py
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type {
  FetchImpl,
  OAuthPasswordGrant,
  TokenResponse,
  Camera,
  DeviceSummary,
} from "../nx-types.ts";

export const CLIENT_ID = "3rdParty";
export const RELAY_SUFFIX = ".relay.vmsproxy.com";
// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";
// Most redirects we will follow when chasing the relay 307.
export const MAX_REDIRECTS = 5;

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
  cloudHost: string | null;
  user: string | null;
  password: string | null;
  siteId: string | null;
  mfaCode: string | null;
  envFile: string;
  insecure: boolean;
}

export interface ResolvedConfig {
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
  return {
    cloudHost: pick(cliArgs.cloudHost, "NX_CLOUD_HOST"),
    user: pick(cliArgs.user, "NX_CLOUD_USER"),
    password: pick(cliArgs.password, "NX_CLOUD_PASSWORD"),
    siteId: pick(cliArgs.siteId, "NX_CLOUD_SITE_ID"),
    mfaCode: cliArgs.mfaCode ?? null,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  mfaCode?: string | null;
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
  timeout?: number;
}

export class NxCloudSiteClient {
  cloudHost: string;
  user: string;
  password: string;
  siteId: string;
  mfaCode: string | null;
  fetchImpl: FetchImpl;
  timeout: number;
  token: string | null;

  constructor(
    cloudHost: string,
    user: string,
    password: string,
    siteId: string,
    { mfaCode = null, verifyTls = true, fetchImpl = fetch, timeout = 15000 }: ClientOptions = {},
  ) {
    this.cloudHost = (cloudHost || "").replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.siteId = siteId;
    this.mfaCode = mfaCode;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.token = null; // The SITE-SCOPED token.
    if (!verifyTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  /** The Cloud relay address for this specific site. */
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

  async login(): Promise<string> {
    const url = `${this.cloudHost}/cdb/oauth2/token`;
    const body: OAuthPasswordGrant = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
      // THIS scope is what makes the token usable against the site.
      scope: `cloudSystemId=${this.siteId}`,
    };
    if (this.mfaCode) body.mfaCode = this.mfaCode;

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
        `Login rejected (HTTP ${response.status}). Check credentials, the ` +
          "site id, and that the account has access to that site. " +
          "Add --mfa-code for a 2FA account.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Token request failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data: TokenResponse;
    try {
      data = (await response.json()) as TokenResponse;
    } catch {
      throw new ApiError("Token response was not valid JSON.");
    }
    this.token = data.access_token;
    if (!this.token) throw new ApiError("Token response did not contain an access_token.");
    return this.token;
  }

  _authHeader(): Record<string, string> {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  /** GET that follows 307 redirects MANUALLY, re-attaching the bearer.
   *
   * The relay replies 307 pointing at the serving node. `redirect: "manual"`
   * stops fetch from auto-following (which would drop the Authorization
   * header across hosts), so we resend it ourselves.
   */
  async _getFollowingRedirects(url: string): Promise<Response> {
    const headers = this._authHeader();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await this._fetchWithTimeout(url, { headers, redirect: "manual" });
      } catch (exc) {
        throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new ApiError(`Redirect ${response.status} without a Location header.`);
        }
        url = location;
        continue;
      }
      return response;
    }
    throw new ApiError(`Too many redirects (>${MAX_REDIRECTS}) chasing the relay.`);
  }

  async listCameras(): Promise<Camera[]> {
    const url = `${this.relayUrl}${API}/devices`;
    const response = await this._getFollowingRedirects(url);
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The site rejected the token. Make sure it was scoped with " +
          "cloudSystemId for THIS site.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Listing devices failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Devices response was not valid JSON.");
    }
    if (data && typeof data === "object" && Array.isArray((data as { reply?: unknown }).reply)) {
      return (data as { reply: Camera[] }).reply;
    }
    return Array.isArray(data) ? (data as Camera[]) : [];
  }

  /** Delete the scoped token on the cloud. Best-effort cleanup. */
  async logout(): Promise<void> {
    if (!this.token) return;
    const url = `${this.cloudHost}/cdb/oauth2/token/${this.token}`;
    try {
      await this._fetchWithTimeout(url, { method: "DELETE", headers: this._authHeader() });
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
// Pretty printing (same camera table as the local-user sample)
// ---------------------------------------------------------------------------

export function formatCamerasTable(cameras: Camera[]): string {
  if (!cameras || cameras.length === 0) {
    return "No cameras found on this site.";
  }
  const rows: string[][] = [["NAME", "STATUS", "MODEL", "ID"]];
  for (const cam of cameras) {
    const summary: DeviceSummary = {
      name: String(cam.name ?? ""),
      status: String(cam.status ?? ""),
      model: String(cam.model ?? ""),
      id: String(cam.id ?? ""),
    };
    rows.push([summary.name, summary.status, summary.model, summary.id]);
  }
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((r) => r[col]!.length)));
  return rows
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col]!)).join("  "))
    .join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
    cloudHost: null,
    user: null,
    password: null,
    siteId: null,
    mfaCode: null,
    envFile: ".env",
    insecure: false,
  };
  const map: Record<string, keyof CliArgs> = {
    "--cloud-host": "cloudHost",
    "--user": "user",
    "--password": "password",
    "--site-id": "siteId",
    "--mfa-code": "mfaCode",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  const booleans: Record<string, keyof CliArgs> = { "--insecure": "insecure" };
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`${(exc as Error).message}\n`);
    return 2;
  }
  const config = resolveConfig(args, loadEnvFile(args.envFile));

  const required = ["cloudHost", "user", "password", "siteId"] as const;
  const missing = required.filter((n) => !config[n]);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy .env.example). See the README.\n",
    );
    return 2;
  }

  const client = new NxCloudSiteClient(
    config.cloudHost!,
    config.user!,
    config.password!,
    config.siteId!,
    { mfaCode: config.mfaCode, verifyTls: !args.insecure },
  );

  try {
    await client.login();
    process.stdout.write(`Got site-scoped token for ${config.siteId}\n\n`);
    process.stdout.write(formatCamerasTable(await client.listCameras()) + "\n");
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
