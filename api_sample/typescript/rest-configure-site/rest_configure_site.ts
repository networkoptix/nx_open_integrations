#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST Server API sample: set up a new site and optionally connect it to the Cloud.
 *
 * Runs directly on Node 22.6+ via native type stripping (no build step).
 * Built-in `fetch` and `node:test`, no third-party runtime dependencies.
 *
 * This is the very first thing done to a factory-default server. It names the
 * site, sets the password of the local "admin" account, applies three site
 * settings, and, if you ask, connects the site to the Nx Cloud. The Cloud
 * account you connect with becomes the site owner, or the organization does if
 * you name one.
 *
 *   1. Check:     GET /rest/v4/site/info  (no login) -> localId, cloudId, name
 *                 A server whose reply has a localId already belongs to a site, and
 *                 the run stops there unless --yes is given.
 *   2. Set up (new server only):
 *        POST /rest/v4/login/sessions  {admin, admin}  (the factory account)
 *        POST /rest/v4/site/setup      {name, local.password, settings}
 *        With the Cloud, setup is a single call instead, after the Cloud
 *        registration in step 4: {name, settings, cloud: {authKey, owner, siteId
 *        [, organizationId]}}. The server binds the site as part of the setup and
 *        disables the local admin, so steps 3 to 5 are skipped.
 *   3. Log in:    POST /rest/v4/login/sessions  {admin, password}  -> {"token": ...}
 *   4. Cloud (only if NX_CONNECT_TO_CLOUD is true and the site is not bound yet):
 *        POST {cloud}/cdb/oauth2/token   -> Cloud bearer token
 *        POST {cloud}/cdb/systems/bind   -> site id and auth key (Cloud account)
 *        POST {cloud}/partners/api/v3/cloud_systems/
 *                                        -> site id and auth key (organization)
 *        POST /rest/v4/cloud/bind        {authKey, owner, siteId[, organizationId]}
 *   5. Settings:  PATCH /rest/v4/site/settings  (only what differs from now)
 *   6. Log out:   DELETE /rest/v4/login/sessions/<token>
 *                 DELETE {cloud}/cdb/oauth2/token/<token>  (when the Cloud was used)
 *
 * Where the configuration comes from:
 *   The server address (--host) and the admin password (--password) can be flags.
 *   Everything else is read from the environment or the .env file: NX_SITE_NAME,
 *   NX_CONNECT_TO_CLOUD, NX_ORGANIZATION_ID, NX_CLOUD_USER, NX_CLOUD_PASSWORD
 *   and, optionally, NX_CLOUD_HOST. Which Cloud to use and the customization to
 *   register under are read from the server itself (site/info), because a
 *   server can only join the Cloud it was built for. The three site settings live in
 *   site_settings.json, under the names the API uses.
 *
 * Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
 */

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

import type { FetchImpl } from "../nx-types.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Login was rejected: wrong credentials, or an account that may not do this. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** The server answered, but not with what the API contract promises. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** The configuration is missing or wrong. The run stops with exit code 2. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The server already belongs to a site and --yes was not given. */
export class ExistingSiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExistingSiteError";
  }
}

/** A 4xx or 5xx the sample does not handle itself. */
export class HttpError extends Error {
  status: number;
  url: string;
  constructor(status: number, method: string, url: string, reason = "") {
    // The URL is kept out of the message: its path or query can hold a
    // session token, the Cloud token or a two-factor code. The reason the
    // server or the Cloud gives in its error body is kept.
    super(reason ? `HTTP ${status}: ${reason}` : `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// The server address and password can be given as a flag. Everything else comes
// from the environment or the .env file only, so the order is
// CLI flag > environment variable > .env file for those two and
// environment variable > .env file for the rest.

export interface CliArgs {
  host: string | null;
  password: string | null;
  envFile: string;
  settingsFile: string;
  insecure: boolean;
  /** The one-time code for a Cloud account with two-factor authentication. */
  mfaCode: string | null;
  yes: boolean;
  help: boolean;
}

export interface Config {
  host: string;
  password: string;
  siteName: string;
  connectToCloud: boolean;
  // The rest is set only when connecting to the Cloud.
  /** Optional: only a check that the server belongs to this Cloud. */
  cloudHost?: string | null;
  cloudUser?: string;
  cloudPassword?: string;
  /** Set: the organization owns the site. Null: the Cloud account does. */
  organizationId?: string | null;
}

/**
 * The text of a configuration file, or null when there is no such file.
 *
 * A file that exists but cannot be read (a directory, or no permission) is a
 * ConfigError: carrying on without it would silently drop what it holds.
 */
function readConfigFile(path: string): string | null {
  if (!fs.existsSync(path)) return null;
  try {
    return fs.readFileSync(path, "utf-8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot read ${path}: ${reason}.`);
  }
}

/** Read a simple KEY=VALUE .env file into an object. Missing file gives {}. */
export function loadEnvFile(path: string = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
  const text = path ? readConfigFile(path) : null;
  if (text === null) return values;
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    // Every leading and trailing double quote goes, then every single quote.
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^"+|"+$/g, "")
      .replace(/^'+|'+$/g, "");
    values[key] = value;
  }
  return values;
}

/** Collect the run's configuration from flags, the environment and .env. */
export function resolveConfig(
  cliArgs: Partial<Pick<CliArgs, "host" | "password" | "insecure">>,
  envFileValues: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): Config {
  // An empty flag (--host=) counts as unset.
  const pick = (envName: string, cliValue?: string | null): string => {
    if (cliValue) return cliValue;
    return env[envName] || envFileValues[envName] || "";
  };
  const stripSlashes = (text: string): string => text.replace(/\/+$/, "");

  const givenHost = pick("NX_SERVER_HOST", cliArgs.host);
  const host = stripSlashes(givenHost);
  const password = pick("NX_SERVER_PASSWORD", cliArgs.password);
  const siteName = pick("NX_SITE_NAME");
  requireValues([
    [host, "NX_SERVER_HOST"],
    [password, "NX_SERVER_PASSWORD"],
    [siteName, "NX_SITE_NAME"],
  ]);
  // Checked here, before any client is built, so nothing is sent to an address
  // that was only half understood.
  if (!isFullUrl(givenHost)) {
    throw new ConfigError(
      "The server address must be a full URL such as https://192.168.1.10:7001, " +
        `not ${JSON.stringify(givenHost)} (NX_SERVER_HOST or --host).`,
    );
  }
  // The server serves its login over plain http too, so the admin password
  // would go out in cleartext, and then refuses every Bearer call on http.
  if (!givenHost.toLowerCase().startsWith("https://")) {
    throw new ConfigError(
      "The server address must be an https:// address, because the admin " +
        `password is sent there, not ${JSON.stringify(givenHost)} (NX_SERVER_HOST or --host).`,
    );
  }

  const connectToCloud = parseBool(
    "NX_CONNECT_TO_CLOUD",
    pick("NX_CONNECT_TO_CLOUD") || "false",
  );
  const config: Config = { host, password, siteName, connectToCloud };
  if (connectToCloud) {
    const givenCloudHost = pick("NX_CLOUD_HOST");
    // Optional. The server says which Cloud it belongs to; this is only a
    // check that it is the Cloud you expect.
    config.cloudHost = stripSlashes(givenCloudHost) || null;
    config.cloudUser = pick("NX_CLOUD_USER");
    config.cloudPassword = pick("NX_CLOUD_PASSWORD");
    // Set: the organization owns the site. Unset: the Cloud account does.
    config.organizationId = pick("NX_ORGANIZATION_ID") || null;
    requireValues([
      [config.cloudUser, "NX_CLOUD_USER"],
      [config.cloudPassword, "NX_CLOUD_PASSWORD"],
    ]);
    if (givenCloudHost && !isFullUrl(givenCloudHost)) {
      throw new ConfigError(
        "NX_CLOUD_HOST must be a full URL such as https://nxvms.com, " +
          `not ${JSON.stringify(givenCloudHost)}.`,
      );
    }
    if (givenCloudHost && !givenCloudHost.toLowerCase().startsWith("https://")) {
      throw new ConfigError(
        "NX_CLOUD_HOST must be an https:// address, because the Cloud password is " +
          `sent there, not ${JSON.stringify(givenCloudHost)}.`,
      );
    }
    if (!givenCloudHost && cliArgs.insecure) {
      // With --insecure nothing proves the server is the real one, so the Cloud
      // it names cannot be trusted with the Cloud password.
      throw new ConfigError(
        "With --insecure, set NX_CLOUD_HOST to the Cloud the server belongs to, " +
          "for example https://nxvms.com. The server's certificate is not checked, " +
          "so the sample will not send the Cloud password to a Cloud address that " +
          "only the server reported.",
      );
    }
  }
  return config;
}

/** True for an absolute http or https URL that names a host. */
function isFullUrl(text: string): boolean {
  if (!/^https?:\/\//i.test(text) || /\s/.test(text)) return false;
  try {
    return new URL(text).hostname !== "";
  } catch {
    return false; // for example "http://[abc", a broken IPv6 address
  }
}

function parseBool(name: string, text: string): boolean {
  const lowered = text.trim().toLowerCase();
  if (lowered === "true" || lowered === "1") return true;
  if (lowered === "false" || lowered === "0") return false;
  throw new ConfigError(`${name} must be true, false, 1 or 0, not '${text}'.`);
}

/** Throw ConfigError naming every required value that is empty. */
function requireValues(required: Array<[string, string]>): void {
  const missing = required.filter(([value]) => !value).map(([, envName]) => envName);
  if (missing.length) {
    throw new ConfigError(
      `Missing configuration: ${missing.join(", ")}. Set it in the environment ` +
        "or in the .env file.",
    );
  }
}

// ---------------------------------------------------------------------------
// The site settings this sample handles
// ---------------------------------------------------------------------------

export type Settings = Record<string, boolean>;

// The key is the API name, used unchanged in the settings file and on the wire.
// Each one defaults to on. The site has many more settings than these three, see
// the README for how to add one.
export const DEFAULT_SETTINGS: Readonly<Settings> = {
  autoDiscoveryEnabled: true,
  cameraSettingsOptimization: true,
  statisticsAllowed: true,
};

// Looked up next to this script, so the sample runs from any directory.
export const DEFAULT_SETTINGS_FILE = fileURLToPath(
  new URL("./site_settings.json", import.meta.url),
);

/**
 * Read the settings file and return the settings it names, checked.
 *
 * Only what the file names is returned. A new site gets DEFAULT_SETTINGS for
 * the rest (see configureSite), while on an existing site a setting the file
 * leaves out is left as it is. A file that does not exist names nothing.
 */
export function loadSettings(path: string): Settings {
  const settings: Settings = {};
  const text = readConfigFile(path);
  if (text === null) return settings;

  let fromFile: unknown;
  try {
    fromFile = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ConfigError(`${path} is not valid JSON: ${error.message}`);
  }
  if (fromFile === null || typeof fromFile !== "object" || Array.isArray(fromFile)) {
    throw new ConfigError(
      `${path} must hold a JSON object such as {"statisticsAllowed": false}.`,
    );
  }

  const entries = Object.entries(fromFile as Record<string, unknown>);
  for (const [name, value] of entries) {
    if (!Object.hasOwn(DEFAULT_SETTINGS, name)) {
      throw new ConfigError(
        `${name} is not a setting this sample handles (it handles: ` +
          `${Object.keys(DEFAULT_SETTINGS).join(", ")}). The site has many more ` +
          "settings, and the README explains how to add one.",
      );
    }
    if (typeof value !== "boolean") {
      throw new ConfigError(`${name} must be true or false, not ${JSON.stringify(value)}.`);
    }
    settings[name] = value;
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Server client
// ---------------------------------------------------------------------------

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// How much of an error response body is kept for a message.
export const MAX_DETAIL_CHARS = 300;

// What a factory-default server's local "admin" account logs in with. site/setup
// needs an administrator, and before setup this is the only account there is.
export const FACTORY_PASSWORD = "admin";

// Every request gives up after this many milliseconds without an answer.
const REQUEST_TIMEOUT_MS = 30000;

/**
 * A fetch built on node:http and node:https, with its own TLS setting.
 *
 * Node's global fetch has no per-client switch for certificate checks, and the
 * process-wide NODE_TLS_REJECT_UNAUTHORIZED would switch them off for every
 * client. Each client gets its own makeFetch instead, so --insecure can apply to
 * the server only while the Cloud client always verifies.
 *
 * Only what this sample reads is returned: status, ok, headers, text() and
 * json(), cast to Response. The timeout is an idle limit.
 */
export function makeFetch({ verifyTls = true }: { verifyTls?: boolean } = {}): FetchImpl {
  return ((input: string | URL | Request, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      const target = new URL(String(input));
      const { request } = target.protocol === "https:" ? https : http;
      const req = request(
        target,
        {
          method: init.method ?? "GET",
          headers: (init.headers ?? {}) as Record<string, string>,
          rejectUnauthorized: verifyTls,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode ?? 0;
            const headers = new Headers();
            for (const [name, value] of Object.entries(res.headers ?? {})) {
              if (typeof value === "string") headers.set(name, value);
              else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
            }
            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers,
              text: async () => text,
              json: async () => JSON.parse(text) as unknown,
            } as unknown as Response);
          });
        },
      );
      req.setTimeout(REQUEST_TIMEOUT_MS, () =>
        req.destroy(
          Object.assign(new Error(`no answer within ${REQUEST_TIMEOUT_MS / 1000} s`), {
            code: "ETIMEDOUT",
          }),
        ),
      );
      req.on("error", reject);
      req.end(typeof init.body === "string" ? init.body : undefined);
    })) as FetchImpl;
}

/**
 * What site/info says about the server's site. "localId" is absent while the
 * server is factory-default, "cloudId" is present once the site is bound to the
 * Cloud, and "name" is the site's real name.
 */
export type SiteInfo = Record<string, unknown>;

/** The "cloud" object of site/setup, from the Cloud registration. */
export interface CloudAuth {
  authKey: string;
  owner: string;
  siteId: string;
  organizationId?: string;
}

/** What the flow needs from a server client. The tests stand in for it. */
export interface ServerApi {
  getSiteInfo(): Promise<SiteInfo>;
  setup(
    siteName: string,
    adminPassword: string | null,
    settings: Settings,
    cloud?: CloudAuth,
  ): Promise<void>;
  login(username: string, password: string): Promise<string>;
  cloudBind(
    authKey: string,
    owner: string,
    siteId: string,
    organizationId?: string | null,
  ): Promise<void>;
  applySettings(wanted: Settings): Promise<Settings>;
  logout(): Promise<void>;
}

/**
 * Where a two-factor code comes from when the Cloud asks for one: the
 * --mfa-code flag or a prompt. It may be async (a prompt), and returns an
 * empty string when there is no code.
 */
export type MfaCodeSource = () => string | Promise<string>;

/** What the flow needs from a Cloud client. The tests stand in for it. */
export interface CloudApi {
  login(username: string, password: string, getMfaCode?: MfaCodeSource | null): Promise<string>;
  registerSite(
    siteName: string,
    customization: string,
    organizationId?: string | null,
  ): Promise<{ siteId: string; authKey: string }>;
  logout(): Promise<void>;
}

export interface ClientOptions {
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * scheme://host[:port] of a URL, resolved against base if given, without user
 * info, path or query, which can hold a session token, the Cloud token or a
 * two-factor code. Empty when it cannot be parsed or has no host.
 */
function origin(url: string, base?: string): string {
  try {
    const parsed = new URL(url, base);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : "";
  } catch {
    return "";
  }
}

/** A non-empty string, the only shape an id or a key may have here. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

/**
 * What the server and the Cloud client share: one token and one fetch.
 *
 * Deliberately small, with no retry logic. The point is to show the calls, not
 * to be a library.
 */
class BearerClient {
  host: string;
  fetchImpl: FetchImpl;
  token: string | null;

  constructor(host: string, { verifyTls = true, fetchImpl }: ClientOptions = {}) {
    this.host = (host || "").replace(/\/+$/, "");
    // --insecure is expected for local servers with self-signed certs, so it
    // reaches the server client only. The transport is per client.
    this.fetchImpl = fetchImpl ?? makeFetch({ verifyTls });
    this.token = null;
  }

  /** The bearer header, or nothing before a login. */
  authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /** One request, given up after 30 s. JSON bodies are sent as JSON. */
  protected async send(method: string, url: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { ...this.authHeaders() };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      // Note which request failed (the server or the Cloud), so main() can
      // name the right host. TLS errors too: a certificate failure needs it to
      // say whether --insecure can help.
      if (error instanceof Error && !("url" in error)) {
        (error as Error & { url?: string }).url = url;
      }
      throw error;
    }
    if (response.status >= 300 && response.status < 400) {
      // Only the addresses' origins are named, never a path or query: the
      // two-factor call carries the code and the Cloud token in its URL.
      const location = response.headers?.get("location");
      const target = location ? origin(location, url) : "";
      throw new ApiError(
        `${origin(url)} answered with a redirect (HTTP ${response.status}` +
          `${target ? " to " + target : ""}). Check the address: it must be the ` +
          "server or the Cloud itself, with the right scheme and port.",
      );
    }
    return response;
  }

  /** A 4xx or 5xx becomes an error, with the reason from its body if any. */
  protected async raiseForStatus(response: Response, method: string, url: string): Promise<void> {
    if (response.status >= 400) {
      throw new HttpError(response.status, method, url, await errorText(response));
    }
  }

  /**
   * The reply body as a JSON object. A proxy or captive portal answering with
   * an HTML page, or a body that is JSON but not an object, is an ApiError
   * ("<what> was not valid JSON." / "...was not a JSON object."), not a crash.
   */
  protected async readObject(response: Response, what: string): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(`${what} was not valid JSON.`);
    }
    if (!isPlainObject(data)) throw new ApiError(`${what} was not a JSON object.`);
    return data;
  }

  protected storeToken(token: string): void {
    this.token = token;
  }

  protected requireLogin(): void {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
  }
}

/**
 * The reason the server or the Cloud gives in its JSON error body
 * ("errorString" from the server, "errorText" from the Cloud), if any.
 */
async function errorText(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return "";
  }
  if (!isPlainObject(body)) return "";
  for (const key of ["errorString", "errorText", "detail"]) {
    const value = body[key];
    if (typeof value === "string" && value) return value.slice(0, MAX_DETAIL_CHARS);
  }
  // The Channel Partners API: {"errors": [{"detail": ...}]}.
  const errors = body["errors"];
  const first: unknown = Array.isArray(errors) ? errors[0] : null;
  if (isPlainObject(first) && typeof first["detail"] === "string" && first["detail"]) {
    return first["detail"].slice(0, MAX_DETAIL_CHARS);
  }
  return "";
}

/** A client for one VMS server. */
export class NxServerClient extends BearerClient implements ServerApi {
  /**
   * GET site/info -> what the server says about its site. No login needed.
   *
   * The two fields this sample reads: "localId" is absent while the server
   * is factory-default and present once it belongs to a site, and "cloudId"
   * is present once the site is bound to the Cloud. "name" is the site's
   * real name.
   */
  async getSiteInfo(): Promise<SiteInfo> {
    const url = this.host + API + "/site/info";
    const response = await this.send("GET", url);
    await this.raiseForStatus(response, "GET", url);
    return this.readObject(response, "Site info response");
  }

  /**
   * POST site/setup: turn a factory-default server into a new site.
   *
   * Needs an administrator on a fresh session, which on a factory-default
   * server means logging in as admin with the factory password first.
   *
   * Local site: the body sets the site name, the new password of the local
   * "admin" account and the initial settings.
   *
   * Cloud site: instead of "local" the body carries "cloud", the auth key,
   * owner, site id (and organization id) from the Cloud registration. The
   * server binds the site to the Cloud as part of the setup, rolls the setup
   * back if the bind fails, and disables the local "admin" account, so the
   * site is used through the Cloud only.
   */
  async setup(
    siteName: string,
    adminPassword: string | null,
    settings: Settings,
    cloud?: CloudAuth,
  ): Promise<void> {
    this.requireLogin();
    const body: Record<string, unknown> = { name: siteName, settings };
    if (cloud) {
      body.cloud = cloud;
    } else {
      body.local = { password: adminPassword };
    }
    const response = await this.send("POST", this.host + API + "/site/setup", body);
    // Only a 2xx means the site was set up.
    if (response.status < 200 || response.status >= 300) {
      const detail = ((await response.text()) || "").slice(0, MAX_DETAIL_CHARS);
      throw new ApiError(`Site setup was refused (HTTP ${response.status}: ${detail}).`);
    }
  }

  /** POST login/sessions -> bearer token, stored on this client. */
  async login(username: string, password: string): Promise<string> {
    const url = this.host + API + "/login/sessions";
    const response = await this.send("POST", url, { username, password });
    if (response.status === 401) {
      throw new AuthError(
        "Login rejected (HTTP 401). Check the user name and password. " +
          "A Cloud account cannot log in to a server here.",
      );
    }
    if (response.status === 403) {
      throw new AuthError(
        "Login forbidden (HTTP 403). This account may not do this. " +
          "Changing site settings needs an administrator.",
      );
    }
    await this.raiseForStatus(response, "POST", url);

    const token = (await this.readObject(response, "Login response")).token;
    if (!token || typeof token !== "string") {
      throw new ApiError("Login response did not contain a token.");
    }
    this.storeToken(token);
    return token;
  }

  /** GET site/settings -> every site setting and its current value. */
  async getSettings(): Promise<Record<string, unknown>> {
    this.requireLogin();
    const url = this.host + API + "/site/settings";
    const response = await this.send("GET", url);
    await this.raiseForStatus(response, "GET", url);
    return this.readObject(response, "Settings response");
  }

  /**
   * PATCH site/settings with the settings that differ from the current ones.
   *
   * Setup already sent these on a new site, so this is what makes a re-run
   * on an existing site converge. Returns the object that was sent, which is
   * empty when nothing needed to change (no PATCH is made then).
   */
  async applySettings(wanted: Settings): Promise<Settings> {
    const current = await this.getSettings();
    const changes: Settings = {};
    for (const [name, value] of Object.entries(wanted)) {
      if (current[name] !== value) changes[name] = value;
    }
    if (Object.keys(changes).length) {
      const url = this.host + API + "/site/settings";
      const response = await this.send("PATCH", url, changes);
      await this.raiseForStatus(response, "PATCH", url);
    }
    return changes;
  }

  /**
   * POST cloud/bind: tell the server it now belongs to a Cloud site record.
   *
   * authKey and siteId come from the Cloud's own bind call (see
   * NxCloudClient.registerSite). owner is the e-mail of the Cloud account
   * that registered the site; the server requires it, also for a site bound
   * to an organization, and adds that account as a local administrator.
   * organizationId is sent for a site bound to an organization.
   */
  async cloudBind(
    authKey: string,
    owner: string,
    siteId: string,
    organizationId: string | null = null,
  ): Promise<void> {
    this.requireLogin();
    const body: Record<string, string> = { authKey, owner, siteId };
    if (organizationId) body.organizationId = organizationId;
    const url = this.host + API + "/cloud/bind";
    const response = await this.send("POST", url, body);
    await this.raiseForStatus(response, "POST", url);
  }

  /** DELETE the session so the token is not left valid. Safe to call twice. */
  async logout(): Promise<void> {
    if (!this.token) return;
    await this.send("DELETE", this.host + API + "/login/sessions/" + this.token);
    this.token = null;
  }
}

// ---------------------------------------------------------------------------
// Cloud client
// ---------------------------------------------------------------------------

// A fixed client id Nx uses for third-party integrations in its examples.
export const CLIENT_ID = "3rdParty";

/** A client for the Nx Cloud (the CDB API). */
export class NxCloudClient extends BearerClient implements CloudApi {
  /**
   * POST /cdb/oauth2/token -> bearer token, stored on this client.
   *
   * An account with two-factor authentication gets a token that must first
   * be confirmed with a one-time code (see confirmSecondFactor).
   * getMfaCode() returns that code, or is null when there is no way to get
   * one.
   *
   * No scope is sent, so the token is cloud-wide. That is what registering a
   * new site needs: a token scoped to one site cannot create another.
   */
  async login(
    username: string,
    password: string,
    getMfaCode: MfaCodeSource | null = null,
  ): Promise<string> {
    const url = this.host + "/cdb/oauth2/token";
    const response = await this.send("POST", url, {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username,
      password,
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Cloud login rejected (HTTP ${response.status}). Check NX_CLOUD_USER and ` +
          "NX_CLOUD_PASSWORD.",
      );
    }
    await this.raiseForStatus(response, "POST", url);

    const reply = await this.readObject(response, "Cloud login response");
    const token = reply.access_token;
    if (!token || typeof token !== "string") {
      throw new ApiError("Cloud login response did not contain an access_token.");
    }

    // An account with two-factor authentication gets HTTP 200 and a token,
    // plus this error. Every other call refuses that token until it is
    // confirmed with a code from the account's authenticator app.
    if (reply.error === "second_factor_required") {
      const code = getMfaCode ? await getMfaCode() : null;
      if (!code) {
        throw new AuthError(
          `Cloud login for ${username} needs a two-factor code. Run again with ` +
            "--mfa-code <the 6-digit code from your authenticator app>, or " +
            "run it in a terminal to be asked for one.",
        );
      }
      await this.confirmSecondFactor(token, code);
    }

    this.storeToken(token);
    return token;
  }

  /**
   * GET /cdb/account/self/2fa/totp/key/{code}?token=<token>.
   *
   * Confirms the login token with a one-time code (TOTP). From then on the
   * same token works for every call. The token goes in the query string
   * here: this call does not accept it as a bearer header.
   */
  private async confirmSecondFactor(token: string, code: string): Promise<void> {
    const url =
      this.host +
      "/cdb/account/self/2fa/totp/key/" +
      encodeURIComponent(code.trim()) +
      "?token=" +
      encodeURIComponent(token);
    const response = await this.send("GET", url);
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new AuthError(
        `The two-factor code was not accepted (HTTP ${response.status}). A code is only ` +
          "valid for about 30 seconds, so run again with a fresh one.",
      );
    }
    await this.raiseForStatus(response, "GET", url);
  }

  /**
   * Create the site's record in the Cloud.
   *
   * Without an organizationId: POST /cdb/systems/bind. The account that is
   * logged in becomes the owner.
   *
   * With an organizationId: POST /partners/api/v3/cloud_systems/ (the
   * Channel Partners API), which binds the site to the organization. The
   * organization owns the site and its members get access through it.
   *
   * Both replies carry the site id and an auth key. They go to the server in
   * NxServerClient.cloudBind, which is what completes the connection.
   *
   * "opaque" is a free-text field the Cloud stores for the VMS. It is a
   * required field in the spec and this sample has nothing to put in it.
   */
  async registerSite(
    siteName: string,
    customization: string,
    organizationId: string | null = null,
  ): Promise<{ siteId: string; authKey: string }> {
    this.requireLogin();

    const body: Record<string, string> = { name: siteName, customization, opaque: "" };
    let url: string;
    if (organizationId) {
      body.organization = organizationId;
      url = this.host + "/partners/api/v3/cloud_systems/";
    } else {
      url = this.host + "/cdb/systems/bind";
    }
    const response = await this.send("POST", url, body);
    await this.raiseForStatus(response, "POST", url);

    const reply = await this.readObject(response, "Cloud bind reply");
    const id = reply.id;
    const authKey = reply.authKey;
    if (!isText(id) || !isText(authKey)) {
      throw new ApiError("The Cloud bind reply did not contain both an id and an authKey.");
    }
    return { siteId: id, authKey };
  }

  /**
   * DELETE /cdb/oauth2/token/{token}: revoke the Cloud token, which has no
   * scope and so gives full access to the account. Safe to call twice.
   */
  async logout(): Promise<void> {
    if (!this.token) return;
    await this.send(
      "DELETE",
      this.host + "/cdb/oauth2/token/" + encodeURIComponent(this.token),
    );
    this.token = null;
  }
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

// Setup creates this account, so it is the one to log in with.
export const LOCAL_ADMIN = "admin";

export interface Summary {
  /** The site's real name: NX_SITE_NAME for a new site, site/info's for an existing one. */
  siteName: string;
  setUp: boolean;
  /** "connected" now, "already" connected before the run, or "not connected". */
  cloud: "connected" | "already" | "not connected";
  cloudId: string | null;
  /** The Cloud the site was connected to in this run, else null. */
  cloudUrl: string | null;
  settingsChanged: Settings;
}

/**
 * The Cloud URL and customization to register the site with, from site/info.
 *
 * A server can only be bound to the Cloud it was built for, under its own
 * customization (a white-label build has its own), so both come from the
 * server. NX_CLOUD_HOST, when set, must name the same Cloud.
 */
export function cloudTarget(
  config: Config,
  info: SiteInfo,
): { cloudUrl: string; customization: string } {
  let reported = (typeof info.cloudHost === "string" ? info.cloudHost : "")
    .trim()
    .replace(/\/+$/, "");
  const customization = typeof info.customization === "string" ? info.customization : "";
  if (!reported || !customization) {
    throw new ApiError(
      "The server's site/info did not report its cloudHost and customization, so " +
        "the sample cannot tell which Cloud to register the site with.",
    );
  }
  if (!reported.includes("://")) reported = "https://" + reported;
  if (!reported.toLowerCase().startsWith("https://") || !isFullUrl(reported)) {
    throw new ApiError(
      `The server reports its Cloud as ${JSON.stringify(reported)}, which is not an ` +
        "https:// address, so the sample will not send the Cloud password there.",
    );
  }
  const wanted = config.cloudHost;
  if (wanted && hostPort(wanted) !== hostPort(reported)) {
    throw new ApiError(
      `NX_CLOUD_HOST is ${wanted}, but this server belongs to the Cloud at ${reported}. A ` +
        "server can only be connected to its own Cloud. Remove NX_CLOUD_HOST " +
        `or set it to ${reported}.`,
    );
  }
  return { cloudUrl: reported, customization };
}

function hostPort(url: string): string {
  // host[:port] in lower case.
  try {
    return new URL(url).host;
  } catch {
    return url.toLowerCase(); // a broken address: compare the text as written
  }
}

/**
 * The "cloud" object of site/setup: what the Cloud registration returned,
 * plus the owner the API requires and the organization, if any.
 */
export function cloudAuth(
  registered: { siteId: string; authKey: string },
  config: Config,
): CloudAuth {
  const auth: CloudAuth = {
    authKey: registered.authKey,
    owner: config.cloudUser ?? "",
    siteId: registered.siteId,
  };
  if (config.organizationId) auth.organizationId = config.organizationId;
  return auth;
}

/**
 * Run the steps in order and return a summary. Any failure stops the run.
 *
 * site/info decides the path. A factory-default server is set up. A server
 * that already belongs to a site is left alone unless allowExisting (--yes)
 * is set, because NX_SERVER_HOST and NX_SERVER_PASSWORD are shared with the
 * other samples and may well point at a site in use. A site that is already
 * bound to the Cloud is not registered again.
 *
 * makeCloud(url) returns the Cloud client. It is called only once site/info
 * has said which Cloud the server belongs to.
 */
export async function configureSite(
  config: Config,
  settings: Settings,
  server: ServerApi,
  makeCloud: ((url: string) => CloudApi) | null,
  allowExisting: boolean = false,
  getMfaCode: MfaCodeSource | null = null,
): Promise<Summary> {
  const info = await server.getSiteInfo();
  const isNew = !info.localId;
  const cloudId = typeof info.cloudId === "string" && info.cloudId ? info.cloudId : null;

  // Worked out before anything changes, so a Cloud mismatch stops the run
  // while the server is still untouched.
  const connecting = config.connectToCloud && !cloudId;
  const target = connecting ? cloudTarget(config, info) : null;

  if (!isNew && !allowExisting) {
    const name = typeof info.name === "string" && info.name ? info.name : config.siteName;
    const cloudPart = connecting ? " and it is connected to the Cloud" : "";
    throw new ExistingSiteError(
      `${config.host} already belongs to the site ${JSON.stringify(name)}. ` +
        `Refusing to change it without --yes. With --yes its settings are updated${cloudPart}.`,
    );
  }

  // Log in to the Cloud before the server is changed, so a wrong Cloud
  // password (or a wrong two-factor code) stops the run
  // while the server is still untouched.
  let cloud: CloudApi | null = null;
  if (target) {
    if (!makeCloud) throw new ApiError("Connecting to the Cloud needs a Cloud client.");
    cloud = makeCloud(target.cloudUrl);
    await cloud.login(config.cloudUser ?? "", config.cloudPassword ?? "", getMfaCode);
  }

  let siteName: string;
  if (isNew) {
    siteName = config.siteName;
    try {
      await server.login(LOCAL_ADMIN, FACTORY_PASSWORD);
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      throw new ApiError(
        "The server has not been set up, but its factory login " +
          "(admin/admin) was rejected, so the sample cannot set it up.",
      );
    }
    // A new site gets every setting this sample handles: the file's values,
    // and the defaults for what it leaves out.
    const allSettings = { ...DEFAULT_SETTINGS, ...settings };
    if (target && cloud) {
      // One site/setup that also binds the site to the Cloud: nothing is
      // left half done if the bind fails, and no local admin password is
      // set (the server disables the local admin of a Cloud site).
      const registered = await cloud.registerSite(
        siteName,
        target.customization,
        config.organizationId ?? null,
      );
      await server.setup(siteName, null, allSettings, cloudAuth(registered, config));
      await server.logout();
      return {
        siteName,
        setUp: true,
        cloud: "connected",
        cloudId,
        cloudUrl: target.cloudUrl,
        settingsChanged: {},
      };
    }
    await server.setup(siteName, config.password, allSettings);
    // The password just changed, so start a new session with the new one.
    await server.logout();
  } else {
    siteName = typeof info.name === "string" && info.name ? info.name : config.siteName;
  }

  await server.login(LOCAL_ADMIN, config.password);

  let cloudState: Summary["cloud"];
  if (target && cloud) {
    const registered = await cloud.registerSite(
      siteName,
      target.customization,
      config.organizationId ?? null,
    );
    await server.cloudBind(
      registered.authKey,
      config.cloudUser ?? "",
      registered.siteId,
      config.organizationId ?? null,
    );
    cloudState = "connected";
  } else if (cloudId) {
    cloudState = "already";
  } else {
    cloudState = "not connected";
  }

  // Only the settings the file names. On an existing site the others stay as
  // an administrator left them.
  const changed = Object.keys(settings).length ? await server.applySettings(settings) : {};
  return {
    siteName,
    setUp: isNew,
    cloud: cloudState,
    cloudId,
    cloudUrl: target ? target.cloudUrl : null,
    settingsChanged: changed,
  };
}

/** Render the outcome as the text to print. */
export function formatSummary(config: Config, summary: Summary): string {
  const setupLine = summary.setUp ? "yes" : "no, the server already belonged to a site";

  let cloudLine: string;
  if (summary.cloud === "connected") {
    const owner = config.organizationId
      ? "organization " + config.organizationId
      : (config.cloudUser ?? "");
    cloudLine = `connected to ${summary.cloudUrl}, owned by ${owner}`;
  } else if (summary.cloud === "already") {
    cloudLine = `already connected (Cloud id ${summary.cloudId}), left as it was`;
  } else {
    cloudLine = "not connected";
  }

  const changes = Object.entries(summary.settingsChanged);
  const changedLine = changes.length
    ? changes.map(([name, value]) => `${name}=${String(value).toLowerCase()}`).join(", ")
    : "none, the site already had them";

  return [
    `Site name       : ${summary.siteName}`,
    `Set up          : ${setupLine}`,
    `Cloud           : ${cloudLine}`,
    `Settings changed: ${changedLine}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
    host: null,
    password: null,
    envFile: ".env",
    settingsFile: DEFAULT_SETTINGS_FILE,
    insecure: false,
    mfaCode: null,
    yes: false,
    help: false,
  };
  const valued: Record<string, "host" | "password" | "envFile" | "settingsFile" | "mfaCode"> = {
    "--host": "host",
    "--password": "password",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
    "--settings-file": "settingsFile",
    "--mfa-code": "mfaCode",
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inlineValue: string | null = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === "--insecure" || arg === "--yes" || arg === "-h" || arg === "--help") {
      if (inlineValue !== null) throw new Error(`${arg} takes no value`);
      if (arg === "--insecure") flags.insecure = true;
      else if (arg === "--yes") flags.yes = true;
      else flags.help = true;
    } else if (arg in valued) {
      if (inlineValue === null && i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      flags[valued[arg]!] = inlineValue !== null ? inlineValue : argv[++i]!;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return flags;
}

const USAGE = `Usage:
  rest_configure_site.ts [--host URL] [--password PASSWORD] [--dotenv PATH]
                         [--settings-file PATH] [--insecure]
                         [--mfa-code CODE] [--yes]

  --host           https://<server>:7001 of a factory-default server
  --password       the local admin password to set
  --dotenv         path to the shared .env (default: ./.env)
  --settings-file  JSON file with the site settings
                   (default: site_settings.json next to this script)
  --insecure       skip TLS verification (normal for a lab server's
                   self-signed certificate)
  --mfa-code       the one-time code from your authenticator app, for a Cloud
                   account with two-factor authentication. Without it, the
                   sample asks for one when it runs in a terminal
  --yes            also change a server that already belongs to a site (its
                   settings, and its Cloud connection if it has none)
`;

/**
 * TLS trust failures: the certificate could not be verified, not other TLS
 * errors such as https pointed at an http port. On the error itself or in its
 * cause (fetch).
 */
function isTlsFailure(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && (code.includes("CERT") || code.includes("SELF_SIGNED"));
}

/**
 * What to do about a certificate that could not be verified: --insecure for the
 * server, nothing the sample can skip for the Cloud.
 */
function certificateMessage(failedAt: string, serverHost: string): string {
  if (hostPort(failedAt) === hostPort(serverHost)) {
    return (
      `certificate verification failed for ${failedAt}. A local server uses a ` +
      "self-signed certificate, so add --insecure."
    );
  }
  return (
    `certificate verification failed for ${failedAt}. --insecure applies to the ` +
    "server only; the Cloud's certificate is always checked. A proxy that " +
    "inspects TLS traffic can cause this."
  );
}

/**
 * A request that did not work: a status the sample does not handle, or a socket
 * error. Node marks socket errors with a `code` (ECONNREFUSED, ETIMEDOUT), on
 * the error itself or, with fetch, in its cause.
 */
function isRequestFailure(error: unknown): boolean {
  if (error instanceof HttpError) return true;
  const e = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  return typeof (e?.code ?? e?.cause?.code) === "string";
}

/**
 * scheme://host:port of the request that failed (the server or the Cloud), so
 * the message names the right one. HttpError carries its url, and send() adds
 * it to fetch's own errors.
 */
function where(error: unknown, fallback: string): string {
  const url = (error as { url?: unknown } | undefined)?.url;
  if (typeof url !== "string" || !url) return fallback;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return fallback;
  }
}

/** The message of an error, with the socket error fetch tucks into `cause`. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
}

/** Asks a question on the terminal and returns the answer. */
async function askOnTerminal(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * Where a two-factor code comes from, if the Cloud asks for one: the
 * --mfa-code flag, else a prompt when the sample runs in a terminal, else
 * nowhere (null). It is only called when the account needs it.
 */
export function mfaCodeSource(
  args: Pick<CliArgs, "mfaCode">,
  config: Partial<Pick<Config, "cloudUser">>,
  {
    stdin = process.stdin,
    ask = askOnTerminal,
  }: { stdin?: { isTTY?: boolean } | null; ask?: (prompt: string) => string | Promise<string> } = {},
): MfaCodeSource | null {
  const flag = args.mfaCode;
  if (flag) return () => flag;
  if (stdin?.isTTY) {
    return async () => (await ask(`Two-factor code for ${config.cloudUser}: `)).trim();
  }
  return null;
}

export interface MainDeps {
  fetchImpl?: FetchImpl;
  /** Injectable so tests never have to stub the real process streams. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Injectable so tests do not read the NX_* variables of the machine. */
  env?: NodeJS.ProcessEnv;
  /** Stand-ins for the two clients, so the tests can run the whole of main(). */
  makeServer?: (host: string, verifyTls: boolean) => ServerApi;
  makeCloud?: (url: string) => CloudApi;
  /** Stand-ins for the terminal, so the tests never prompt for a real code. */
  stdin?: { isTTY?: boolean } | null;
  ask?: (prompt: string) => string | Promise<string>;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: MainDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    stderr.write(`ERROR: ${exc instanceof Error ? exc.message : String(exc)}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }

  let config: Config;
  let settings: Settings;
  try {
    config = resolveConfig(args, loadEnvFile(args.envFile), deps.env ?? process.env);
    settings = loadSettings(args.settingsFile);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    stderr.write(`ERROR: ${error.message}\n`);
    return 2;
  }

  if (!fs.existsSync(args.settingsFile)) {
    // Not an error: a new site gets the defaults, and an existing one keeps
    // its settings. But a mistyped path would otherwise be ignored without
    // a word.
    stderr.write(
      `Note: ${args.settingsFile} not found. A new site gets the default settings, ` +
        "an existing one keeps its own.\n",
    );
  }

  const makeServer =
    deps.makeServer ??
    ((host: string, verifyTls: boolean): ServerApi =>
      new NxServerClient(host, { verifyTls, fetchImpl: deps.fetchImpl }));
  const newCloud =
    deps.makeCloud ??
    ((url: string): CloudApi => new NxCloudClient(url, { fetchImpl: deps.fetchImpl }));
  const clouds: CloudApi[] = []; // the Cloud client, once the flow has made it
  const makeCloud = (url: string): CloudApi => {
    const cloud = newCloud(url);
    clouds.push(cloud);
    return cloud;
  };
  const server = makeServer(config.host, !args.insecure);
  try {
    const summary = await configureSite(
      config,
      settings,
      server,
      makeCloud,
      args.yes,
      mfaCodeSource(args, config, { stdin: deps.stdin, ask: deps.ask }),
    );
    stdout.write(formatSummary(config, summary) + "\n");
  } catch (exc) {
    if (exc instanceof AuthError || exc instanceof ApiError || exc instanceof ExistingSiteError) {
      stderr.write(`ERROR: ${exc.message}\n`);
    } else if (isTlsFailure(exc)) {
      stderr.write(`ERROR: ${certificateMessage(where(exc, config.host), config.host)}\n`);
    } else if (isRequestFailure(exc)) {
      stderr.write(`ERROR: could not complete a request to ${where(exc, config.host)}: ${describe(exc)}\n`);
    } else {
      // Anything else is a bug in the sample, and a bug must show its stack
      // trace, not pass for a failed request.
      throw exc;
    }
    return 1;
  } finally {
    // Always release the server session and revoke the Cloud token, even
    // when a step failed.
    for (const client of [server, ...clouds]) {
      try {
        await client.logout();
      } catch {
        // A logout that cannot be delivered is not a reason to fail.
      }
    }
  }
  return 0;
}

// Compare real paths: run through a symlink (npm's bin link, npx), argv[1] is
// the link while import.meta.url is the file, and a plain === never matches.
const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // exitCode, not process.exit(): exit() would cut off output still queued.
  main().then((code) => {
    process.exitCode = code;
  });
}
