#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST Server API sample: the login session lifecycle on ONE mediaserver.
 *
 * Node.js port of ../../python/rest-get-token. Built-in `fetch` (Node 18+) and
 * `node:test`, no third-party dependencies.
 *
 * This is the smallest possible "how do I authenticate?" sample. It gets a
 * bearer token from the mediaserver, uses it on a real authenticated request,
 * gives it back, and then proves the token is dead. Nothing else — no cameras,
 * no events.
 *
 * The flow, on the latest v4 REST API:
 *
 *   1. Log in:   POST   /rest/v4/login/sessions          {username, password}
 *                -> {"id", "username", "token", "ageS", "expiresInS"}
 *   2. Use it:   GET    /rest/v4/login/sessions/current  (Authorization: Bearer <token>)
 *                The literal "current" (or "-") means "the token in my auth
 *                header", so this call both proves the token works AND shows
 *                what a session is.
 *   3. Log out:  DELETE /rest/v4/login/sessions/current  (release the session)
 *   4. Re-check: GET    /rest/v4/login/sessions/current  -> now fails, as it should.
 *
 * Step 4 exists so logout is something you can see rather than take on faith.
 *
 * The token goes in the `Authorization: Bearer <token>` header. All three calls
 * that need it address the session with the `current` sentinel, so the header
 * is what identifies the session.
 *
 * Tokens expire. `expiresInS` in the login response tells you how long you
 * have; plan on re-logging in rather than assuming a token lives forever.
 *
 * Want to see the token used on an actual resource? See the rest-list-cameras
 * sample, which takes this same token and lists the site's cameras with it.
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
// TLS warning
// ---------------------------------------------------------------------------

/**
 * Silence the one warning Node prints when TLS verification is turned off.
 *
 * Setting NODE_TLS_REJECT_UNAUTHORIZED=0 makes Node emit:
 *   "Warning: Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable
 *    to '0' makes TLS connections and HTTPS requests insecure..."
 *
 * With --insecure that is exactly what you asked for, and the warning only
 * buries the sample's own output. This is the Node counterpart of the Python
 * port's urllib3 InsecureRequestWarning suppression.
 *
 * Note it filters ONLY that message — every other warning still prints. Never
 * do this in production code: there the warning is the point.
 */
export function suppressTlsWarning() {
  // Tag the replacement rather than tracking a module flag, so calling this
  // twice is harmless and it still works if something else swapped emitWarning.
  if (process.emitWarning.nxTlsFiltered) return;
  const original = process.emitWarning;
  const patched = (warning, ...rest) => {
    const text = typeof warning === "string" ? warning : (warning?.message ?? "");
    if (text.includes("NODE_TLS_REJECT_UNAUTHORIZED")) return;
    return original.call(process, warning, ...rest);
  };
  patched.nxTlsFiltered = true;
  process.emitWarning = patched;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxLoginClient {
  constructor(host, user, password, { verifyTls = true, fetchImpl = fetch, timeout = 15000 } = {}) {
    this.host = (host || "").replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.token = null;
    if (!verifyTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
      // --insecure is expected for local servers with self-signed certs;
      // don't spam the console with Node's TLS warning.
      suppressTlsWarning();
    }
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

  /** Build the bearer header. This is the ONLY place the token is used. */
  _authHeader(token = null) {
    const value = token || this.token;
    if (!value) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${value}` };
  }

  // -- step 1: get a token ---------------------------------------------------

  /**
   * POST credentials, receive a session (incl. its token), remember it.
   *
   * Returns the whole session object, not just the token, because the other
   * fields are the interesting part: `expiresInS` is how long you have.
   */
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
    return data;
  }

  // -- step 2: use the token -------------------------------------------------

  /**
   * GET the session that the bearer token in our header belongs to.
   *
   * The path literal "current" (the v4 API also accepts "-") means "whatever
   * token is in the Authorization header", so the request needs no token in
   * the path.
   *
   * A successful call here is the proof that the token works: the server only
   * answers if it recognises the token we sent.
   */
  async getCurrentSession() {
    const url = `${this.host}${API}/login/sessions/current`;
    let response;
    try {
      response = await this._fetchWithTimeout(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${exc.message}`);
    }
    return this._check(response, "Reading the current session");
  }

  // -- step 4: confirm the token really is dead ------------------------------

  /**
   * Probe the session endpoint with `token` and report whether it is live.
   *
   * Unlike getCurrentSession() this NEVER throws on a rejection: after logout a
   * 401 is the expected, correct answer, not a failure. Returns
   * {isLive, status}; status is null if the request never landed.
   */
  async tokenStillWorks(token) {
    const url = `${this.host}${API}/login/sessions/current`;
    let response;
    try {
      response = await this._fetchWithTimeout(url, { headers: this._authHeader(token) });
    } catch {
      // Can't reach the server, so we can't say. Report "not live".
      return { isLive: false, status: null };
    }
    return { isLive: response.ok, status: response.status };
  }

  // -- step 3: give the token back -------------------------------------------

  /**
   * DELETE the session so the token cannot be reused.
   *
   * Best-effort by design: this is cleanup, and cleanup failing should never be
   * the thing that crashes the program. Returns true if the server confirmed
   * it. Clears the remembered token either way.
   */
  async logout() {
    if (!this.token) return false;
    // Address the session with the "current" sentinel; the server takes the
    // token from the Authorization header.
    const url = `${this.host}${API}/login/sessions/current`;
    try {
      const response = await this._fetchWithTimeout(url, {
        method: "DELETE",
        headers: this._authHeader(),
      });
      return Boolean(response && response.ok);
    } catch {
      return false;
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

/** Build a plain-text block describing a session. Pure function = testable. */
export function formatSession(session) {
  const rows = [
    ["token", String(session.token ?? "")],
    ["session id", String(session.id ?? "")],
    ["username", String(session.username ?? "")],
  ];
  // ageS / expiresInS are seconds, per the v4 spec field names.
  if (session.ageS !== undefined && session.ageS !== null) {
    rows.push(["age", `${session.ageS} seconds`]);
  }
  if (session.expiresInS !== undefined && session.expiresInS !== null) {
    rows.push(["expires in", `${session.expiresInS} seconds`]);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)} : ${value}`).join("\n");
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

  const client = new NxLoginClient(config.host, config.user, config.password, {
    verifyTls: !args.insecure,
  });

  try {
    // 1. Trade the username/password for a token.
    const session = await client.login();
    process.stdout.write(`Logged in to ${config.host} as ${config.user}\n\n`);
    process.stdout.write(formatSession(session) + "\n");

    // 2. Use the token on a real authenticated request.
    process.stdout.write(`\nUsing the token: GET ${API}/login/sessions/current\n`);
    const live = await client.getCurrentSession();
    process.stdout.write(
      `  -> 200 OK, the server recognised the token. ` +
        `Session belongs to '${live.username ?? ""}'.\n`,
    );

    // 3. Hand the token back. Keep a copy so we can prove it stopped working.
    const spentToken = client.token;
    process.stdout.write(`\nLogging out: DELETE ${API}/login/sessions/current\n`);
    const confirmed = await client.logout();
    process.stdout.write(
      confirmed
        ? "  -> session deleted.\n"
        : "  -> the server did not confirm the delete (the session may still expire on its own).\n",
    );

    // 4. Show that the token really is gone. A rejection here is success.
    process.stdout.write(
      `\nRe-checking with the same token: GET ${API}/login/sessions/current\n`,
    );
    const { isLive, status } = await client.tokenStillWorks(spentToken);
    if (isLive) {
      process.stdout.write("  -> unexpectedly still accepted. The session was not released.\n");
    } else if (status === null) {
      process.stdout.write("  -> could not reach the server to confirm.\n");
    } else {
      process.stdout.write(
        `  -> HTTP ${status}, the token is rejected. ` +
          "That is the expected result: logout worked.\n",
      );
    }
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
    // If we bailed out early the session is still open; release it.
    await client.logout();
  }
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
