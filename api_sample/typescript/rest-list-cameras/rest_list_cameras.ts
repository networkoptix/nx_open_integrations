#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST Server API sample: log in to ONE site and list its cameras.
 *
 * TypeScript port of ../../node/rest-list-cameras. Runs directly on Node 22.6+
 * via native type stripping (no build step). Built-in `fetch` (Node 18+) and
 * `node:test`, no third-party runtime dependencies.
 *
 * This talks to a single VMS server/site (not the cloud). It uses Network
 * Optix's recommended bearer-token authentication, on the **latest v4** REST API:
 *
 *   1. Log in:    POST /rest/v4/login/sessions  {username, password}  -> {"token": ...}
 *   2. List:      GET  /rest/v4/devices         (Authorization: Bearer <token>)
 *   3. Log out:   DELETE /rest/v4/login/sessions/<token>
 *
 * "Devices" are the cameras (and other media devices) attached to the site.
 *
 * Connecting to the server:
 *   --host is the server, e.g. https://192.168.1.10:7001 (https + port), or a
 *   cloud relay address like https://<siteId>.relay.vmsproxy.com. Local
 *   servers usually present a self-signed certificate, so use --insecure.
 *
 * Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type {
  FetchImpl,
  LoginRequest,
  LoginResponse,
  Camera,
  DeviceSummary,
} from "../nx-types.ts";

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

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
// Configuration (CLI > env > .env). Server vars are NX_SERVER_*.
// ---------------------------------------------------------------------------

export interface CliArgs {
  host: string | null;
  user: string | null;
  password: string | null;
  envFile: string;
  insecure: boolean;
}

export interface ResolvedConfig {
  host: string | undefined;
  user: string | undefined;
  password: string | undefined;
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
  cliArgs: Partial<CliArgs>,
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
    host: pick(cliArgs.host, "NX_SERVER_HOST"),
    user: pick(cliArgs.user, "NX_SERVER_USER"),
    password: pick(cliArgs.password, "NX_SERVER_PASSWORD"),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface NxServerClientOptions {
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
  timeout?: number;
}

export class NxServerClient {
  host: string;
  user: string;
  password: string;
  fetchImpl: FetchImpl;
  timeout: number;
  token: string | null;

  constructor(
    host: string,
    user: string,
    password: string,
    { verifyTls = true, fetchImpl = fetch, timeout = 15000 }: NxServerClientOptions = {},
  ) {
    this.host = (host || "").replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.token = null;
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

  /** Shared response validation -> typed errors + parsed JSON. */
  async _check(response: Response, what: string): Promise<unknown> {
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `${what} unauthorized (HTTP ${response.status}). Check the username/` +
          "password, and that you are using a local (not cloud) user.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`${what} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError(`${what}: response was not valid JSON.`);
    }
  }

  async login(): Promise<string> {
    const url = `${this.host}${API}/login/sessions`;
    const body: LoginRequest = {
      username: this.user,
      password: this.password,
      setCookie: false,
    };
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
    const data = (await this._check(response, "Login")) as LoginResponse;
    this.token = data.token;
    if (!this.token) throw new ApiError("Login response did not contain a token.");
    return this.token;
  }

  _authHeader(): Record<string, string> {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  async listCameras(): Promise<Camera[]> {
    const url = `${this.host}${API}/devices`;
    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    const data = await this._check(response, "Listing devices");
    // Some Nx versions wrap the array in a {"reply": [...]} envelope.
    if (
      data &&
      typeof data === "object" &&
      Array.isArray((data as { reply?: unknown }).reply)
    ) {
      return (data as { reply: Camera[] }).reply;
    }
    return Array.isArray(data) ? (data as Camera[]) : [];
  }

  /** DELETE the session so the token cannot be reused. Best-effort. */
  async logout(): Promise<void> {
    if (!this.token) return;
    const url = `${this.host}${API}/login/sessions/${this.token}`;
    try {
      await this._fetchWithTimeout(url, { method: "DELETE", headers: this._authHeader() });
    } catch {
      // Logout is cleanup; never let it crash the program.
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

export function formatCamerasTable(cameras: Camera[]): string {
  if (!cameras || cameras.length === 0) {
    return "No cameras found on this site.";
  }
  const rows: DeviceSummary[] = cameras.map((cam) => ({
    name: String(cam.name ?? ""),
    status: String(cam.status ?? ""),
    model: String(cam.model ?? ""),
    id: String(cam.id ?? ""),
  }));
  const grid: string[][] = [["NAME", "STATUS", "MODEL", "ID"]];
  for (const row of rows) {
    grid.push([row.name, row.status, row.model, row.id]);
  }
  const widths = grid[0]!.map((_, col) =>
    Math.max(...grid.map((r) => r[col]!.length)),
  );
  return grid
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
    envFile: ".env",
    insecure: false,
  };
  const map: Record<string, "host" | "user" | "password" | "envFile"> = {
    "--host": "host",
    "--user": "user",
    "--password": "password",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  const booleans: Record<string, "insecure"> = { "--insecure": "insecure" };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inlineValue: string | null = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) flags[booleans[arg]!] = true;
    else if (arg in map) flags[map[arg]!] = inlineValue !== null ? inlineValue : argv[++i]!;
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

  const missing = (["host", "user", "password"] as const).filter((n) => !config[n]);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy .env.example). See the README.\n",
    );
    return 2;
  }

  const client = new NxServerClient(config.host!, config.user!, config.password!, {
    verifyTls: !args.insecure,
  });

  try {
    await client.login();
    process.stdout.write(`Logged in to ${config.host} as ${config.user}\n\n`);
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
    await client.logout(); // always try to release the session token
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
