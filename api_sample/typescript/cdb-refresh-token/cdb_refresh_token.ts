#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx Cloud CDB API sample: keep a token-based session alive with refresh tokens.
 *
 * TypeScript port of ../../node/cdb-refresh-token. Runs directly on Node 22.6+
 * via native type stripping (no build step). Built-in `fetch`, built-in
 * `node:test`, no third-party runtime dependencies.
 *
 * THE IDEA (read this if you are new to token auth)
 * --------------------------------------------------
 * With token-based auth you do NOT send your password on every request. Instead:
 *
 *   * You log in once and receive two things:
 *       - an ACCESS token  -> short-lived. Sent on every API call as
 *                             "Authorization: Bearer <access token>".
 *       - a REFRESH token  -> long-lived. Used ONLY to get new access tokens.
 *   * When the access token is about to expire, you call the token endpoint
 *     again with grant_type=refresh_token to get a fresh access token.
 *   * Some servers ROTATE the refresh token: the refresh response contains a NEW
 *     refresh token and the old one stops working. You must store the new one.
 *
 * So "the session" is really: {accessToken, refreshToken, expiry}. This file
 * wraps that state in a TokenSession class and shows the three things you must
 * do to keep it healthy:
 *
 *   1. PROACTIVE refresh  - refresh shortly BEFORE the access token expires.
 *   2. REACTIVE refresh   - if a call still returns 401, refresh once and retry.
 *   3. ROTATION + STORAGE - always keep the latest refresh token (and optionally
 *                           persist it to disk so the session survives a restart).
 *
 * Reference: https://nxvms.com/cdb/docs/api/v1/swagger/index.html (RFC 6749 §6)
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type {
  FetchImpl,
  OAuthPasswordGrant,
  OAuthRefreshGrant,
  TokenResponse,
} from "../nx-types.ts";

export const CLIENT_ID = "3rdParty";
// If the server doesn't tell us a lifetime, assume this many seconds.
export const DEFAULT_EXPIRES_IN_S = 3600;
// Refresh this many seconds BEFORE the access token actually expires.
export const REFRESH_SAFETY_MARGIN_S = 60;

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
// Configuration (CLI flag > OS environment variable > .env file)
// ---------------------------------------------------------------------------

export interface CliArgs {
  host?: string | null;
  user?: string | null;
  password?: string | null;
  mfaCode?: string | null;
  refreshToken?: string | null;
  store?: string | null;
  forceRefresh?: boolean;
  envFile?: string | null;
  insecure?: boolean;
  debug?: boolean;
}

export interface ResolvedConfig {
  host?: string | null;
  user?: string | null;
  password?: string | null;
  mfaCode?: string | null;
  refreshToken?: string | null;
}

export function loadEnvFile(path: string = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
  if (!path || !fs.existsSync(path)) {
    return values;
  }
  for (let line of fs.readFileSync(path, "utf-8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
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
  ): string | null | undefined => {
    if (cliValue !== undefined && cliValue !== null) return cliValue;
    if (env[envKey]) return env[envKey];
    return envFileValues[envKey];
  };
  return {
    host: pick(cliArgs.host, "NX_CLOUD_HOST"),
    user: pick(cliArgs.user, "NX_CLOUD_USER"),
    password: pick(cliArgs.password, "NX_CLOUD_PASSWORD"),
    mfaCode: cliArgs.mfaCode,
    refreshToken: pick(cliArgs.refreshToken, "NX_CLOUD_REFRESH_TOKEN"),
  };
}

// ---------------------------------------------------------------------------
// Request bodies (own functions so the exact payloads are easy to read/test)
// ---------------------------------------------------------------------------

export function buildPasswordRequest(
  user: string,
  password: string,
  mfaCode?: string | null,
): OAuthPasswordGrant {
  const body: OAuthPasswordGrant = {
    grant_type: "password",
    response_type: "token",
    client_id: CLIENT_ID,
    username: user,
    password: password,
  };
  if (mfaCode) body.mfaCode = mfaCode;
  return body;
}

export function buildRefreshRequest(refreshToken: string): OAuthRefreshGrant {
  return {
    grant_type: "refresh_token",
    response_type: "token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  };
}

// ---------------------------------------------------------------------------
// The session: holds the tokens and the logic to keep them valid
// ---------------------------------------------------------------------------

export interface TokenSessionOptions {
  storePath?: string | null;
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
  timeout?: number;
  timeFn?: () => number;
}

export class TokenSession {
  host: string;
  storePath: string | null;
  timeout: number;
  timeFn: () => number;
  fetchImpl: FetchImpl;
  verifyTls: boolean;

  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number; // epoch seconds when the access token expires
  lastRaw: TokenResponse | null; // raw JSON of the last token response (--debug)

  /**
   * Inject `fetchImpl` (for tests) and `timeFn` (to make expiry testable, in
   * seconds). Pass `storePath` to persist the refresh token across runs.
   */
  constructor(host: string, options: TokenSessionOptions = {}) {
    const {
      storePath = null,
      verifyTls = true,
      fetchImpl = fetch,
      timeout = 15000,
      timeFn = () => Date.now() / 1000,
    } = options;
    this.host = (host || "").replace(/\/+$/, "");
    this.storePath = storePath;
    this.timeout = timeout;
    this.timeFn = timeFn;
    this.fetchImpl = fetchImpl;
    this.verifyTls = verifyTls;

    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0; // epoch seconds when the access token expires
    this.lastRaw = null; // raw JSON of the last token response (for --debug)

    if (!verifyTls) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
    if (storePath) {
      this._load();
    }
  }

  // -- persistence --------------------------------------------------------

  _load(): void {
    try {
      const saved = JSON.parse(
        fs.readFileSync(this.storePath as string, "utf-8"),
      );
      this.accessToken = saved.access_token ?? null;
      this.refreshToken = saved.refresh_token ?? null;
      this.expiresAt = Number(saved.expires_at || 0) || 0;
    } catch {
      // no/invalid store yet -> start fresh
    }
  }

  _save(): void {
    if (!this.storePath) return;
    const data = {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      expires_at: this.expiresAt,
    };
    fs.writeFileSync(this.storePath, JSON.stringify(data), { mode: 0o600 });
    try {
      fs.chmodSync(this.storePath, 0o600); // owner read/write only
    } catch {
      // best effort
    }
  }

  // -- core http ----------------------------------------------------------

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

  async _postToken(
    body: OAuthPasswordGrant | OAuthRefreshGrant,
    what: string,
  ): Promise<TokenResponse> {
    const url = `${this.host}/cdb/oauth2/token`;
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
        `${what} rejected (HTTP ${response.status}). Check credentials / ` +
          "refresh token; add --mfa-code for a 2FA login.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(
        `${what} failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    let data: TokenResponse;
    try {
      data = (await response.json()) as TokenResponse;
    } catch {
      throw new ApiError(`${what}: response was not valid JSON.`);
    }
    if (!data || !data.access_token) {
      throw new ApiError(`${what}: response did not contain an access_token.`);
    }
    return data;
  }

  /**
   * Update session state from a token response, then persist it. This is where
   * ROTATION happens: if the response carries a new refresh token we adopt it.
   */
  _absorb(data: TokenResponse): void {
    this.lastRaw = data;
    this.accessToken = data.access_token;
    const expiresIn = Number.parseInt(
      String(data.expires_in ?? DEFAULT_EXPIRES_IN_S),
      10,
    );
    this.expiresAt = this.timeFn() + expiresIn;
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token; // <-- keep the latest
    }
    this._save();
  }

  // -- public api ---------------------------------------------------------

  async login(
    user: string,
    password: string,
    mfaCode: string | null = null,
  ): Promise<TokenResponse> {
    const data = await this._postToken(
      buildPasswordRequest(user, password, mfaCode),
      "Login",
    );
    this._absorb(data);
    return data;
  }

  async refresh(): Promise<TokenResponse> {
    if (!this.refreshToken) {
      throw new ApiError("No refresh token available. Log in first.");
    }
    const data = await this._postToken(
      buildRefreshRequest(this.refreshToken),
      "Refresh",
    );
    this._absorb(data);
    return data;
  }

  secondsUntilExpiry(): number {
    return this.expiresAt - this.timeFn();
  }

  isExpiring(margin: number = REFRESH_SAFETY_MARGIN_S): boolean {
    return this.secondsUntilExpiry() <= margin;
  }

  /**
   * PROACTIVE refresh: return a usable access token, refreshing if needed.
   * Cheap to call right before every API request.
   */
  async ensureValid(): Promise<string | null> {
    if (!this.accessToken && !this.refreshToken) {
      throw new ApiError("No session yet. Call login() first.");
    }
    if (this.isExpiring()) {
      await this.refresh();
    }
    return this.accessToken;
  }

  authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  /**
   * GET an API path with the bearer token. Demonstrates BOTH refresh
   * strategies: ensureValid() refreshes proactively, and if the server still
   * answers 401 we refresh once and retry (reactive).
   */
  async authorizedGet(path: string): Promise<Response> {
    await this.ensureValid();
    const url = `${this.host}${path}`;
    let response = await this._fetchWithTimeout(url, { headers: this.authHeader() });
    if (response.status === 401) {
      await this.refresh(); // reactive refresh
      response = await this._fetchWithTimeout(url, { headers: this.authHeader() });
    }
    return response;
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
// Printing helpers
// ---------------------------------------------------------------------------

export function short(token: string | null): string {
  if (!token) return "";
  return token.length > 27 ? `${token.slice(0, 24)}...` : token;
}

function printState(label: string, sess: TokenSession): void {
  process.stdout.write(
    `${label}: access_token=${short(sess.accessToken)}  ` +
      `~${Math.trunc(sess.secondsUntilExpiry())}s to expiry  ` +
      `refresh_token=${short(sess.refreshToken)}\n`,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): Required<CliArgs> {
  const flags: Required<CliArgs> = {
    host: null,
    user: null,
    password: null,
    mfaCode: null,
    refreshToken: null,
    store: null,
    forceRefresh: false,
    envFile: ".env",
    insecure: false,
    debug: false,
  };
  const map: Record<string, keyof CliArgs> = {
    "--host": "host",
    "--user": "user",
    "--password": "password",
    "--mfa-code": "mfaCode",
    "--refresh-token": "refreshToken",
    "--store": "store",
    // `--dotenv`, NOT `--env-file`: Node 20.6+ reserves `--env-file` as a
    // built-in and aborts the process if the file is missing, before our code.
    "--dotenv": "envFile",
  };
  const booleans: Record<string, keyof CliArgs> = {
    "--force-refresh": "forceRefresh",
    "--insecure": "insecure",
    "--debug": "debug",
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] as string;
    let inlineValue: string | null = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) {
      (flags[booleans[arg] as keyof CliArgs] as boolean) = true;
    } else if (arg in map) {
      (flags[map[arg] as keyof CliArgs] as string) =
        inlineValue !== null ? inlineValue : (argv[++i] as string);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

function dump(sess: TokenSession): void {
  process.stderr.write("--- raw token response ---\n");
  process.stderr.write(
    JSON.stringify(sess.lastRaw, null, 2).slice(0, 4000) + "\n",
  );
  process.stderr.write("--- end raw ---\n");
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  let args: Required<CliArgs>;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`${(exc as Error).message}\n`);
    return 2;
  }
  const config = resolveConfig(args, loadEnvFile(args.envFile ?? undefined));

  if (!config.host) {
    process.stderr.write(
      "Missing config: host. Provide --host or NX_CLOUD_HOST.\n",
    );
    return 2;
  }

  const sess = new TokenSession(config.host, {
    storePath: args.store,
    verifyTls: !args.insecure,
  });

  // A refresh token can come from the CLI/env even without a --store file.
  if (config.refreshToken) {
    sess.refreshToken = config.refreshToken;
  }

  try {
    if (sess.refreshToken && !(config.user && config.password)) {
      process.stdout.write(
        "Resuming session from a refresh token (no password)...\n",
      );
      await sess.refresh();
      if (args.debug) dump(sess);
      printState("resumed", sess);
    } else if (config.user && config.password) {
      await sess.login(config.user, config.password, config.mfaCode);
      if (args.debug) dump(sess);
      printState("login  ", sess);
    } else {
      process.stderr.write(
        "Provide --user/--password to log in, or --refresh-token to resume.\n",
      );
      return 2;
    }

    if (args.forceRefresh) {
      const before = sess.refreshToken;
      await sess.refresh();
      if (args.debug) dump(sess);
      printState("refresh", sess);
      process.stdout.write(
        `refresh token rotated: ${sess.refreshToken !== before}\n`,
      );
    }

    if (args.store) {
      process.stdout.write(
        `\nSession saved to ${args.store} — re-run without a password to resume.\n`,
      );
    }
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
