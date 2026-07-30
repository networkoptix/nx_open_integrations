#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx Cloud CDB API sample: get an OAuth2 bearer token (and nothing else).
 *
 * Node.js port of ../../python/cdb-get-token. Uses the built-in global `fetch`
 * (Node 18+) and no third-party dependencies.
 *
 * This is the smallest possible "how do I authenticate?" example. It performs
 * the single login call and prints the token. Once you have the token you put
 * it in an `Authorization: Bearer <token>` header on any other CDB / site
 * request.
 *
 * The one call:
 *
 *     POST {cloud}/cdb/oauth2/token
 *     Content-Type: application/json
 *     {
 *       "grant_type":    "password",
 *       "response_type": "token",
 *       "client_id":     "3rdParty",
 *       "username":      "<your cloud email>",
 *       "password":      "<your cloud password>"
 *     }
 *
 * Optional fields:
 *   - "mfaCode": "123456"             -> if your account has 2FA enabled
 *   - "scope":   "cloudSystemId=<id>" -> scope the token to ONE site (omit for
 *                                        a cloud-wide token)
 *
 * The response contains "access_token" (it begins with "nxcdb-").
 *
 * Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html
 *            https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/authentication/cloud_bearer.py
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

// A fixed client id Nx uses for third-party integrations in their examples.
export const CLIENT_ID = "3rdParty";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when the cloud rejects the login (bad credentials / 2FA). */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

/** Raised for any other unexpected API/network failure. */
export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Configuration (CLI flag > OS environment variable > .env file)
// ---------------------------------------------------------------------------

/** Read a simple KEY=VALUE .env file into an object. Missing file -> {}. */
export function loadEnvFile(path = ".env") {
  const values = {};
  if (!path || !fs.existsSync(path)) {
    return values;
  }
  const text = fs.readFileSync(path, "utf-8");
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    // Strip a single pair of surrounding quotes.
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
export function resolveConfig(cliArgs, envFileValues = {}, env = process.env) {
  const pick = (cliValue, envKey) => {
    if (cliValue !== undefined && cliValue !== null) {
      return cliValue;
    }
    if (env[envKey]) {
      return env[envKey];
    }
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
// The one function that matters: build the body and call the endpoint
// ---------------------------------------------------------------------------

/**
 * Return the exact JSON body sent to POST /cdb/oauth2/token.
 * Kept as its own function so it is easy to read and easy to test.
 */
export function buildTokenRequest(user, password, mfaCode, cloudSystemId) {
  const body = {
    grant_type: "password",
    response_type: "token",
    client_id: CLIENT_ID,
    username: user,
    password: password,
  };
  if (mfaCode) {
    body.mfaCode = mfaCode; // only when the account uses 2FA
  }
  if (cloudSystemId) {
    // Scope the token to one site. Omit for a cloud-wide token.
    body.scope = `cloudSystemId=${cloudSystemId}`;
  }
  return body;
}

/**
 * Perform the login and return the full token response (an object).
 * The access token itself is under the "access_token" key.
 *
 * `fetchImpl` is injectable so tests can run offline; it defaults to the
 * built-in global fetch.
 */
export async function getToken(
  host,
  user,
  password,
  {
    mfaCode = null,
    cloudSystemId = null,
    verifyTls = true,
    fetchImpl = fetch,
    timeout = 15000,
  } = {},
) {
  const url = `${host.replace(/\/+$/, "")}/cdb/oauth2/token`;
  const body = buildTokenRequest(user, password, mfaCode, cloudSystemId);

  // Node's fetch verifies TLS by default. To allow self-signed certs in a lab,
  // the CLI sets NODE_TLS_REJECT_UNAUTHORIZED=0 before any request is made.
  if (!verifyTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (exc) {
    throw new ApiError(`Could not reach ${url}: ${exc.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(
      `Login rejected (HTTP ${response.status}). Check your credentials; ` +
        "if 2FA is enabled, pass --mfa-code.",
    );
  }
  if (!response.ok) {
    let text = "";
    try {
      text = await response.text();
    } catch {
      // ignore
    }
    throw new ApiError(
      `Token request failed: HTTP ${response.status} ${text.slice(0, 200)}`,
    );
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ApiError("Token response was not valid JSON.");
  }

  if (!data || !data.access_token) {
    throw new ApiError("Token response did not contain an access_token.");
  }
  return data;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Minimal flag parser (no dependencies). Supports `--flag value`,
 * `--flag=value`, and boolean flags (`--insecure`, `--token-only`).
 */
export function parseArgs(argv) {
  const flags = {
    host: null,
    user: null,
    password: null,
    mfaCode: null,
    cloudSystemId: null,
    envFile: ".env",
    insecure: false,
    tokenOnly: false,
  };
  const map = {
    "--host": "host",
    "--user": "user",
    "--password": "password",
    "--mfa-code": "mfaCode",
    "--cloud-site-id": "cloudSystemId",
    // NOTE: the flag is `--dotenv`, NOT `--env-file`. Node 20.6+ reserves
    // `--env-file` as a built-in: it greedily scans every CLI argument (even
    // those after the script name) and aborts the whole process with a cryptic
    // "node: <path>: not found" if the file is missing — before our code runs.
    // Using a different name keeps this sample's error handling in our hands.
    "--dotenv": "envFile",
  };
  const booleans = { "--insecure": "insecure", "--token-only": "tokenOnly" };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) {
      flags[booleans[arg]] = true;
    } else if (arg in map) {
      flags[map[arg]] = inlineValue !== null ? inlineValue : argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
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

  const missing = ["host", "user", "password"].filter((name) => !config[name]);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy .env.example). See the README.\n",
    );
    return 2;
  }

  let data;
  try {
    data = await getToken(config.host, config.user, config.password, {
      mfaCode: config.mfaCode,
      cloudSystemId: config.cloudSystemId,
      verifyTls: !args.insecure,
    });
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

  const token = data.access_token;
  if (args.tokenOnly) {
    // Just the raw token, e.g. for: TOKEN=$(node cdb_get_token.mjs --token-only ...)
    process.stdout.write(`${token}\n`);
    return 0;
  }

  process.stdout.write("Token acquired.\n\n");
  process.stdout.write(`access_token : ${token}\n`);
  // expires_in is reported in seconds when present.
  if ("expires_in" in data) {
    process.stdout.write(`expires_in   : ${data.expires_in} seconds\n`);
  }
  process.stdout.write("\nUse it on later requests as a header:\n");
  process.stdout.write(`  Authorization: Bearer ${token}\n`);
  return 0;
}

// Run only when invoked directly (not when imported by the tests).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
