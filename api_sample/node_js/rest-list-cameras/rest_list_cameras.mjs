#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST Server API sample: log in to ONE site and list its cameras.
 *
 * Node.js port of ../../python/rest-list-cameras. Built-in `fetch` (Node 18+)
 * and `node:test`, no third-party dependencies.
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

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

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
// Configuration (CLI > env > .env). Server vars are NX_SERVER_*.
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
    host: pick(cliArgs.host, "NX_SERVER_HOST"),
    user: pick(cliArgs.user, "NX_SERVER_USER"),
    password: pick(cliArgs.password, "NX_SERVER_PASSWORD"),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxServerClient {
  constructor(host, user, password, { verifyTls = true, fetchImpl = fetch, timeout = 15000 } = {}) {
    this.host = (host || "").replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.token = null;
    if (!verifyTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
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

  /** Shared response validation -> typed errors + parsed JSON. */
  async _check(response, what) {
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

  async login() {
    const url = `${this.host}${API}/login/sessions`;
    const body = { username: this.user, password: this.password, setCookie: false };
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
    const data = await this._check(response, "Login");
    this.token = data.token;
    if (!this.token) throw new ApiError("Login response did not contain a token.");
    return this.token;
  }

  _authHeader() {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  async listCameras() {
    const url = `${this.host}${API}/devices`;
    let response;
    try {
      response = await this._fetchWithTimeout(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${exc.message}`);
    }
    const data = await this._check(response, "Listing devices");
    // Some Nx versions wrap the array in a {"reply": [...]} envelope.
    if (data && typeof data === "object" && Array.isArray(data.reply)) return data.reply;
    return Array.isArray(data) ? data : [];
  }

  /** DELETE the session so the token cannot be reused. Best-effort. */
  async logout() {
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

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

export function formatCamerasTable(cameras) {
  if (!cameras || cameras.length === 0) {
    return "No cameras found on this site.";
  }
  const rows = [["NAME", "STATUS", "MODEL", "ID"]];
  for (const cam of cameras) {
    rows.push([
      String(cam.name ?? ""),
      String(cam.status ?? ""),
      String(cam.model ?? ""),
      String(cam.id ?? ""),
    ]);
  }
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows
    .map((row) => row.map((cell, col) => cell.padEnd(widths[col])).join("  "))
    .join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = { host: null, user: null, password: null, envFile: ".env", insecure: false };
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
    if (arg in booleans) flags[booleans[arg]] = true;
    else if (arg in map) flags[map[arg]] = inlineValue !== null ? inlineValue : argv[++i];
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

  const missing = ["host", "user", "password"].filter((n) => !config[n]);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy .env.example). See the README.\n",
    );
    return 2;
  }

  const client = new NxServerClient(config.host, config.user, config.password, {
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
