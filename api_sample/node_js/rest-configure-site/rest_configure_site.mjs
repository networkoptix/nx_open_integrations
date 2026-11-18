#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST Server API sample: set up a new site and optionally connect it to the Cloud.
 *
 * Built-in `node:http(s)` and `node:test`, no third-party dependencies.
 *
 * This is the very first thing done to a factory-default server. It names the site,
 * sets the password of the local "admin" account, applies three site settings, and,
 * if you ask, connects the site to the Nx Cloud. The Cloud account you connect with
 * becomes the site owner, or the organization does if you name one.
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
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Login was rejected: wrong credentials, or an account that may not do this. */
export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthError";
  }
}

/** The server answered, but not with what the API contract promises. */
export class ApiError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiError";
  }
}

/** The configuration is missing or wrong. The run stops with exit code 2. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The server already belongs to a site and --yes was not given. */
export class ExistingSiteError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExistingSiteError";
  }
}

/**
 * An unexpected HTTP status from a call that has no better message of its own.
 * `url` is the request that got it, so main can name the server or the Cloud.
 * `reason` is what the server or the Cloud said in its error body, if anything;
 * the message never includes the URL.
 */
export class HttpError extends Error {
  constructor(status, url = null, reason = "") {
    super(reason ? `HTTP ${status}: ${reason}` : `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// The server address and password can be given as a flag. Everything else comes
// from the environment or the .env file only, so the order is
// CLI flag > environment variable > .env file for those two and
// environment variable > .env file for the rest.

/**
 * Read a file the user named. A path that exists but cannot be read (a
 * directory, or no permission) is a configuration mistake, not a crash.
 */
function readConfigFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new ConfigError(`Cannot read ${filePath}: ${error.message}.`);
  }
}

/** Read a simple KEY=VALUE .env file into an object. Missing file gives {}. */
export function loadEnvFile(envPath = ".env") {
  const values = {};
  if (!envPath || !fs.existsSync(envPath)) return values;
  for (let line of readConfigFile(envPath).split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    // Every leading and trailing quote goes.
    const value = line.slice(idx + 1).trim().replace(/^"+|"+$/g, "").replace(/^'+|'+$/g, "");
    values[key] = value;
  }
  return values;
}

/** Collect the run's configuration from flags, the environment and .env. */
export function resolveConfig(cliArgs, envFileValues = {}, env = process.env) {
  // An empty flag (--host=) counts as unset.
  const pick = (envName, cliValue = null) => {
    if (cliValue) return cliValue;
    return env[envName] || envFileValues[envName] || "";
  };

  const rawHost = pick("NX_SERVER_HOST", cliArgs.host);
  const config = {
    host: rawHost.replace(/\/+$/, ""),
    password: pick("NX_SERVER_PASSWORD", cliArgs.password),
    siteName: pick("NX_SITE_NAME"),
  };
  requireValues(config, [
    ["host", "NX_SERVER_HOST"],
    ["password", "NX_SERVER_PASSWORD"],
    ["siteName", "NX_SITE_NAME"],
  ]);
  if (!isHttpUrl(rawHost)) {
    throw new ConfigError(
      "The server address must be a full URL such as https://192.168.1.10:7001, " +
        `not ${JSON.stringify(rawHost)} (NX_SERVER_HOST or --host).`,
    );
  }
  // The server serves its login over plain http too, so the admin password
  // would go out in cleartext, and then refuses every Bearer call on http.
  if (!rawHost.toLowerCase().startsWith("https://")) {
    throw new ConfigError(
      "The server address must be an https:// address, because the admin " +
        `password is sent there, not ${JSON.stringify(rawHost)} (NX_SERVER_HOST or --host).`,
    );
  }

  config.connectToCloud = parseBool(
    "NX_CONNECT_TO_CLOUD",
    pick("NX_CONNECT_TO_CLOUD") || "false",
  );
  if (config.connectToCloud) {
    const rawCloudHost = pick("NX_CLOUD_HOST");
    Object.assign(config, {
      // Optional. The server says which Cloud it belongs to; this is only
      // a check that it is the Cloud you expect.
      cloudHost: rawCloudHost.replace(/\/+$/, "") || null,
      cloudUser: pick("NX_CLOUD_USER"),
      cloudPassword: pick("NX_CLOUD_PASSWORD"),
      // Set: the organization owns the site. Unset: the Cloud account does.
      organizationId: pick("NX_ORGANIZATION_ID") || null,
    });
    requireValues(config, [
      ["cloudUser", "NX_CLOUD_USER"],
      ["cloudPassword", "NX_CLOUD_PASSWORD"],
    ]);
    if (rawCloudHost && !isHttpUrl(rawCloudHost)) {
      throw new ConfigError(
        "NX_CLOUD_HOST must be a full URL such as https://nxvms.com, " +
          `not ${JSON.stringify(rawCloudHost)}.`,
      );
    }
    if (rawCloudHost && !/^https:\/\//i.test(rawCloudHost)) {
      throw new ConfigError(
        "NX_CLOUD_HOST must be an https:// address, because the Cloud " +
          `password is sent there, not ${JSON.stringify(rawCloudHost)}.`,
      );
    }
    if (!rawCloudHost && cliArgs.insecure) {
      // With --insecure nothing proves the server is the real one, so the
      // Cloud it names cannot be trusted with the Cloud password.
      throw new ConfigError(
        "With --insecure, set NX_CLOUD_HOST to the Cloud the server belongs " +
          "to, for example https://nxvms.com. The server's certificate is not " +
          "checked, so the sample will not send the Cloud password to a Cloud " +
          "address that only the server reported.",
      );
    }
  }
  return config;
}

/**
 * True for an absolute http or https URL that names a host.
 */
function isHttpUrl(value) {
  if (/\s/.test(value) || !/^https?:\/\//i.test(value)) return false;
  try {
    return Boolean(new URL(value).hostname);
  } catch {
    return false;
  }
}

function parseBool(name, text) {
  const lowered = text.trim().toLowerCase();
  if (lowered === "true" || lowered === "1") return true;
  if (lowered === "false" || lowered === "0") return false;
  throw new ConfigError(`${name} must be true, false, 1 or 0, not '${text}'.`);
}

/** Throw ConfigError naming every required value that is empty. */
function requireValues(config, required) {
  const missing = required.filter(([key]) => !config[key]).map(([, envName]) => envName);
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

// The key is the API name, used unchanged in the settings file and on the wire.
// Each one defaults to on. The site has many more settings than these three, see
// the README for how to add one.
export const DEFAULT_SETTINGS = {
  autoDiscoveryEnabled: true,
  cameraSettingsOptimization: true,
  statisticsAllowed: true,
};

// Looked up next to this script, so the sample runs from any directory.
export const DEFAULT_SETTINGS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "site_settings.json",
);

/**
 * Read the settings file and return the settings it names, checked.
 *
 * Only what the file names is returned. A new site gets DEFAULT_SETTINGS for
 * the rest (see configureSite), while on an existing site a setting the file
 * leaves out is left as it is. A file that does not exist names nothing.
 */
export function loadSettings(settingsPath) {
  const settings = {};
  if (!fs.existsSync(settingsPath)) return settings;

  const text = readConfigFile(settingsPath);
  let fromFile;
  try {
    fromFile = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ConfigError(`${settingsPath} is not valid JSON: ${error.message}`);
    }
    throw error;
  }
  if (fromFile === null || typeof fromFile !== "object" || Array.isArray(fromFile)) {
    throw new ConfigError(
      `${settingsPath} must hold a JSON object such as {"statisticsAllowed": false}.`,
    );
  }

  for (const [name, value] of Object.entries(fromFile)) {
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
  }

  return { ...settings, ...fromFile };
}

// ---------------------------------------------------------------------------
// Transport
//
// The sample needs --insecure to apply to the server only, never to the Cloud.
// fetch can only skip certificate checks process-wide, so each client gets its
// own small node:http(s) transport instead. It is injectable, which is what
// keeps the tests offline.
// ---------------------------------------------------------------------------

/**
 * Build a fetch-like function: (url, {method, headers, body, timeout}) resolves
 * to {status, ok, headers, json(), text()}, where `headers` has lower-case
 * names. `timeout` (ms) is an idle limit.
 */
export function makeFetch({ verifyTls = true } = {}) {
  return (url, { method = "GET", headers = {}, body, timeout = 30000 } = {}) =>
    new Promise((resolve, reject) => {
      const target = new URL(url);
      const { request } = target.protocol === "https:" ? https : http;
      const req = request(
        target,
        { method, headers, rejectUnauthorized: verifyTls },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode;
            resolve({
              status,
              ok: status >= 200 && status < 300,
              headers: res.headers,
              text: async () => text,
              json: async () => JSON.parse(text),
            });
          });
        },
      );
      req.setTimeout(timeout, () =>
        req.destroy(Object.assign(new Error(`no answer within ${timeout / 1000} s`), { code: "ETIMEDOUT" })),
      );
      req.on("error", reject);
      req.end(body);
    });
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

/**
 * What the server and the Cloud client share: one transport and one token.
 *
 * Deliberately small, with no retry logic. The point is to show the calls, not
 * to be a library.
 */
class BearerClient {
  constructor(host, { verifyTls = true, fetchImpl = null } = {}) {
    this.host = host.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl ?? makeFetch({ verifyTls });
    this.headers = {}; // sent with every request, holds the bearer token
    this.token = null;
  }

  /** Keep the token and send it as a bearer header from now on. */
  _storeToken(token) {
    this.token = token;
    this.headers.Authorization = `Bearer ${token}`;
  }

  _requireLogin() {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
  }

  /**
   * One request, JSON in and a fetch-like response out. A 3xx is an ApiError.
   */
  async _send(method, url, body = undefined) {
    const headers = { ...this.headers };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        timeout: 30000,
      });
    } catch (error) {
      // Remember which request failed, so main names the server or the Cloud.
      // This covers TLS errors too: a certificate failure says which host.
      if (error && typeof error === "object" && !error.url) error.url = url;
      throw error;
    }
    // Kept on the reply for raiseForStatus, for the same reason.
    if (!response.url) response.url = url;
    if (response.status >= 300 && response.status < 400) {
      // Only origins: the path and query can hold the Cloud token or a
      // two-factor code (see _confirmSecondFactor).
      const location = response.headers?.location;
      const target = location ? originOf(location, url) : "";
      throw new ApiError(
        `${originOf(url)} answered with a redirect (HTTP ${response.status}` +
          `${target ? ` to ${target}` : ""}). Check the address: it must be ` +
          "the server or the Cloud itself, with the right scheme and port.",
      );
    }
    return response;
  }
}

/** Throw on a 4xx or 5xx, with the reason from the error body if there is one. */
async function raiseForStatus(response) {
  if (response.status >= 400) {
    throw new HttpError(response.status, response.url ?? null, await errorText(response));
  }
}

/**
 * The reason the server or the Cloud gives in its JSON error body
 * ("errorString" from the server, "errorText" from the Cloud), if any.
 */
export async function errorText(response) {
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    return "";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  for (const key of ["errorString", "errorText", "detail"]) {
    if (typeof body[key] === "string" && body[key]) return body[key].slice(0, MAX_DETAIL_CHARS);
  }
  // The Channel Partners API: {"errors": [{"detail": ...}]}.
  const first = Array.isArray(body.errors) ? body.errors[0] : null;
  if (first && typeof first.detail === "string" && first.detail) {
    return first.detail.slice(0, MAX_DETAIL_CHARS);
  }
  return "";
}

/**
 * Parse a reply body as a JSON object. A 200 that is not JSON (the HTML page of
 * a proxy, say), or that is JSON but not an object, means the other end is not
 * the API, which is an ApiError and not a bug. `what` names the reply in the
 * message.
 */
async function readJson(response, what) {
  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApiError(`${what} was not valid JSON.`);
    throw error;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(`${what} was not a JSON object.`);
  }
  return body;
}

/** A non-empty string, the only shape an id or a key may have here. */
function isText(value) {
  return typeof value === "string" && value.length > 0;
}

/** A client for one VMS server. */
export class NxServerClient extends BearerClient {
  /**
   * GET site/info -> what the server says about its site. No login needed.
   *
   * The two fields this sample reads: "localId" is absent while the server is
   * factory-default and present once it belongs to a site, and "cloudId" is
   * present once the site is bound to the Cloud. "name" is the site's real name.
   */
  async getSiteInfo() {
    const response = await this._send("GET", `${this.host}${API}/site/info`);
    await raiseForStatus(response);
    return readJson(response, "Site info response");
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
  async setup(siteName, adminPassword, settings, cloud = null) {
    this._requireLogin();
    const body = { name: siteName, settings };
    if (cloud) {
      body.cloud = cloud;
    } else {
      body.local = { password: adminPassword };
    }
    const response = await this._send("POST", `${this.host}${API}/site/setup`, body);
    // Only a 2xx means the site was set up. A 3xx is not success either: it
    // would mean a proxy or a wrong address answered instead of the server.
    if (!(response.status >= 200 && response.status < 300)) {
      throw new ApiError(
        `Site setup was refused (HTTP ${response.status}: ` +
          `${((await response.text()) || "").slice(0, MAX_DETAIL_CHARS)}).`,
      );
    }
  }

  /** POST login/sessions -> bearer token, stored on this client. */
  async login(username, password) {
    const response = await this._send("POST", `${this.host}${API}/login/sessions`, {
      username,
      password,
    });
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
    await raiseForStatus(response);

    const token = (await readJson(response, "Login response")).token;
    if (!token) throw new ApiError("Login response did not contain a token.");

    this._storeToken(token);
    return token;
  }

  /** GET site/settings -> every site setting and its current value. */
  async getSettings() {
    this._requireLogin();
    const response = await this._send("GET", `${this.host}${API}/site/settings`);
    await raiseForStatus(response);
    return readJson(response, "Settings response");
  }

  /**
   * PATCH site/settings with the settings that differ from the current ones.
   *
   * Setup already sent these on a new site, so this is what makes a re-run
   * on an existing site converge. Returns the object that was sent, which is
   * empty when nothing needed to change (no PATCH is made then).
   */
  async applySettings(wanted) {
    const current = await this.getSettings();
    const changes = Object.fromEntries(
      Object.entries(wanted).filter(([name, value]) => current[name] !== value),
    );
    if (Object.keys(changes).length) {
      const response = await this._send("PATCH", `${this.host}${API}/site/settings`, changes);
      await raiseForStatus(response);
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
  async cloudBind(authKey, owner, siteId, organizationId = null) {
    this._requireLogin();
    const body = { authKey, owner, siteId };
    if (organizationId) body.organizationId = organizationId;
    const response = await this._send("POST", `${this.host}${API}/cloud/bind`, body);
    await raiseForStatus(response);
  }

  /** DELETE the session so the token is not left valid. Safe to call twice. */
  async logout() {
    if (!this.token) return;
    await this._send("DELETE", `${this.host}${API}/login/sessions/${this.token}`);
    this.token = null;
    delete this.headers.Authorization;
  }
}

// ---------------------------------------------------------------------------
// Cloud client
// ---------------------------------------------------------------------------

// A fixed client id Nx uses for third-party integrations in its examples.
export const CLIENT_ID = "3rdParty";

/** A client for the Nx Cloud (the CDB API). */
export class NxCloudClient extends BearerClient {
  /**
   * POST /cdb/oauth2/token -> bearer token, stored on this client.
   *
   * An account with two-factor authentication gets a token that must first be
   * confirmed with a one-time code (see _confirmSecondFactor). getMfaCode()
   * returns that code, or is null when there is no way to get one.
   *
   * No scope is sent, so the token is cloud-wide. That is what registering a
   * new site needs: a token scoped to one site cannot create another.
   */
  async login(username, password, getMfaCode = null) {
    const response = await this._send("POST", `${this.host}/cdb/oauth2/token`, {
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
    await raiseForStatus(response);

    const reply = await readJson(response, "Cloud login response");
    const token = reply.access_token;
    if (!token) throw new ApiError("Cloud login response did not contain an access_token.");

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
      await this._confirmSecondFactor(token, code);
    }

    this._storeToken(token);
    return token;
  }

  /**
   * GET /cdb/account/self/2fa/totp/key/{code}?token=<token>.
   *
   * Confirms the login token with a one-time code (TOTP). From then on the
   * same token works for every call. The token goes in the query string here:
   * this call does not accept it as a bearer header.
   */
  async _confirmSecondFactor(token, code) {
    const response = await this._send(
      "GET",
      `${this.host}/cdb/account/self/2fa/totp/key/` +
        `${encodeURIComponent(String(code).trim())}?token=${encodeURIComponent(token)}`,
    );
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new AuthError(
        `The two-factor code was not accepted (HTTP ${response.status}). A code is only ` +
          "valid for about 30 seconds, so run again with a fresh one.",
      );
    }
    await raiseForStatus(response);
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
  async registerSite(siteName, customization, organizationId = null) {
    this._requireLogin();

    const body = { name: siteName, customization, opaque: "" };
    let url;
    if (organizationId) {
      body.organization = organizationId;
      url = `${this.host}/partners/api/v3/cloud_systems/`;
    } else {
      url = `${this.host}/cdb/systems/bind`;
    }
    const response = await this._send("POST", url, body);
    await raiseForStatus(response);

    const reply = await readJson(response, "Cloud bind reply");
    if (!isText(reply.id) || !isText(reply.authKey)) {
      throw new ApiError("The Cloud bind reply did not contain both an id and an authKey.");
    }
    return { siteId: reply.id, authKey: reply.authKey };
  }

  /**
   * DELETE /cdb/oauth2/token/{token}: revoke the Cloud token, which has no
   * scope and so gives full access to the account. Safe to call twice.
   */
  async logout() {
    if (!this.token) return;
    await this._send("DELETE", `${this.host}/cdb/oauth2/token/${encodeURIComponent(this.token)}`);
    this.token = null;
    delete this.headers.Authorization;
  }
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

// Setup creates this account, so it is the one to log in with.
export const LOCAL_ADMIN = "admin";

/**
 * The Cloud URL and customization to register the site with, from site/info.
 *
 * A server can only be bound to the Cloud it was built for, under its own
 * customization (a white-label build has its own), so both come from the
 * server. NX_CLOUD_HOST, when set, must name the same Cloud.
 */
export function cloudTarget(config, info) {
  let reported = String(info.cloudHost || "").trim().replace(/\/+$/, "");
  const customization = info.customization || "";
  if (!reported || !customization) {
    throw new ApiError(
      "The server's site/info did not report its cloudHost and " +
        "customization, so the sample cannot tell which Cloud to " +
        "register the site with.",
    );
  }
  if (!reported.includes("://")) reported = `https://${reported}`;
  if (!/^https:\/\//i.test(reported) || !isHttpUrl(reported)) {
    throw new ApiError(
      `The server reports its Cloud as ${JSON.stringify(reported)}, which is not an ` +
        "https:// address, so the sample will not send the Cloud password there.",
    );
  }
  const wanted = config.cloudHost;
  if (wanted && hostAndPort(wanted) !== hostAndPort(reported)) {
    throw new ApiError(
      `NX_CLOUD_HOST is ${wanted}, but this server belongs to the Cloud at ${reported}. A ` +
        "server can only be connected to its own Cloud. Remove NX_CLOUD_HOST " +
        `or set it to ${reported}.`,
    );
  }
  return { url: reported, customization };
}

function hostAndPort(url) {
  // host[:port] in lower case.
  try {
    return new URL(url).host;
  } catch {
    return url.toLowerCase();
  }
}

/**
 * The "cloud" object of site/setup: what the Cloud registration returned,
 * plus the owner the API requires and the organization, if any.
 */
function cloudAuth(registered, config) {
  const auth = {
    authKey: registered.authKey,
    owner: config.cloudUser,
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
  config, settings, server, makeCloud, { allowExisting = false, getMfaCode = null } = {},
) {
  const info = await server.getSiteInfo();
  const isNew = !info.localId;
  const cloudId = info.cloudId || null;

  // Worked out before anything changes, so a Cloud mismatch stops the run
  // while the server is still untouched.
  const connecting = Boolean(config.connectToCloud && !cloudId);
  const target = connecting ? cloudTarget(config, info) : null;

  if (!isNew && !allowExisting) {
    const cloudPart = connecting ? " and it is connected to the Cloud" : "";
    throw new ExistingSiteError(
      `${config.host} already belongs to the site ` +
        `${JSON.stringify(info.name || config.siteName)}. ` +
        `Refusing to change it without --yes. With --yes its settings are updated${cloudPart}.`,
    );
  }

  // Log in to the Cloud before the server is changed, so a wrong Cloud
  // password (or a wrong two-factor code) stops the run
  // while the server is still untouched.
  let cloud = null;
  if (connecting) {
    cloud = makeCloud(target.url);
    await cloud.login(config.cloudUser, config.cloudPassword, getMfaCode);
  }

  let siteName;
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
    if (connecting) {
      // One site/setup that also binds the site to the Cloud: nothing is
      // left half done if the bind fails, and no local admin password is
      // set (the server disables the local admin of a Cloud site).
      const registered = await cloud.registerSite(
        siteName,
        target.customization,
        config.organizationId,
      );
      await server.setup(siteName, null, allSettings, cloudAuth(registered, config));
      await server.logout();
      return {
        siteName,
        setUp: true,
        cloud: "connected",
        cloudId,
        cloudUrl: target.url,
        settingsChanged: {},
      };
    }
    await server.setup(siteName, config.password, allSettings);
    // The password just changed, so start a new session with the new one.
    await server.logout();
  } else {
    siteName = info.name || config.siteName;
  }

  await server.login(LOCAL_ADMIN, config.password);

  let cloudState;
  if (connecting) {
    const registered = await cloud.registerSite(
      siteName,
      target.customization,
      config.organizationId,
    );
    await server.cloudBind(
      registered.authKey,
      config.cloudUser,
      registered.siteId,
      config.organizationId,
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
    cloudUrl: connecting ? target.url : null,
    settingsChanged: changed,
  };
}

/** Render the outcome as the text to print. */
export function formatSummary(config, summary) {
  const setupLine = summary.setUp ? "yes" : "no, the server already belonged to a site";

  let cloudLine;
  if (summary.cloud === "connected") {
    const owner = config.organizationId
      ? `organization ${config.organizationId}`
      : config.cloudUser;
    cloudLine = `connected to ${summary.cloudUrl}, owned by ${owner}`;
  } else if (summary.cloud === "already") {
    cloudLine = `already connected (Cloud id ${summary.cloudId}), left as it was`;
  } else {
    cloudLine = "not connected";
  }

  const entries = Object.entries(summary.settingsChanged);
  const changedLine = entries.length
    ? entries.map(([name, value]) => `${name}=${String(value).toLowerCase()}`).join(", ")
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

const USAGE = `Usage: rest_configure_site.mjs [--host URL] [--password PASSWORD]
                              [--dotenv PATH] [--settings-file PATH] [--insecure]
                              [--mfa-code CODE] [--yes]

Set up a new site and optionally connect it to the Cloud.

  --host            https://<server>:7001 of a factory-default server
  --password        the local admin password to set
  --dotenv          path to the shared .env (default: ./.env)
  --settings-file   JSON file with the site settings
                    (default: site_settings.json next to this script)
  --insecure        skip TLS verification (normal for a lab server's
                    self-signed certificate)
  --mfa-code        the one-time code from your authenticator app, for a Cloud
                    account with two-factor authentication. Without it, the
                    sample asks for one when it runs in a terminal
  --yes             also change a server that already belongs to a site (its
                    settings, and its Cloud connection if it has none)
`;

/** Parse the command line. Throws Error with a message on a bad one (exit 2). */
export function parseArgs(argv) {
  const flags = {
    host: null,
    password: null,
    envFile: ".env", // NOT --env-file (a Node built-in)
    settingsFile: DEFAULT_SETTINGS_FILE,
    insecure: false,
    mfaCode: null,
    yes: false,
    help: false,
  };
  const valued = {
    "--host": "host",
    "--password": "password",
    "--dotenv": "envFile",
    "--settings-file": "settingsFile",
    "--mfa-code": "mfaCode",
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === "--insecure" || arg === "--yes") {
      if (inlineValue !== null) throw new Error(`${arg} takes no value`);
      flags[arg.slice(2)] = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg in valued) {
      if (inlineValue === null && i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      flags[valued[arg]] = inlineValue !== null ? inlineValue : argv[++i];
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return flags;
}

/**
 * Where a two-factor code comes from, if the Cloud asks for one: the
 * --mfa-code flag, else a prompt when the sample runs in a terminal, else
 * nowhere (null). It is only called when the account needs it. `stdin` and
 * `ask(prompt)` are there for the tests.
 */
export function mfaCodeSource(args, config, { stdin = process.stdin, ask = askLine } = {}) {
  if (args.mfaCode) return () => args.mfaCode;
  if (stdin && stdin.isTTY) {
    return async () => String(await ask(`Two-factor code for ${config.cloudUser}: `)).trim();
  }
  return null;
}

/** Ask one question on the terminal and return the answer. */
async function askLine(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/**
 * TLS certificate failures, on the error itself or in its cause. Other TLS
 * errors, such as https pointed at an http port, are not: --insecure would not
 * help.
 */
function isTlsFailure(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === "string" && (code.includes("CERT") || code.includes("SELF_SIGNED"));
}

/**
 * scheme://host:port of the request that failed (the server or the Cloud), so
 * the message names the right one. `fallback` when that is not known.
 */
function where(error, fallback) {
  const url = error?.url ?? error?.cause?.url;
  return (url && originOf(url)) || fallback;
}

/**
 * scheme://host[:port] of `url` (resolved against `base`, if given), without
 * user info, path or query, which can hold a token or a two-factor code. ""
 * when it cannot be parsed or has no host.
 */
function originOf(url, base = undefined) {
  try {
    const origin = new URL(url, base).origin;
    return origin === "null" ? "" : origin;
  } catch {
    return "";
  }
}

/**
 * What to do about a certificate that could not be verified: --insecure for
 * the server, nothing the sample can skip for the Cloud.
 */
function certificateMessage(failedAt, serverHost) {
  if (hostAndPort(failedAt) === hostAndPort(serverHost)) {
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
 * A request that did not go through: an unexpected status, or a socket error,
 * which Node marks with a `code` (ECONNREFUSED, ETIMEDOUT) on the error or on
 * its cause. Nothing else counts. A TypeError with no code is a bug in this
 * program, and main() lets it through with its stack trace.
 */
function isRequestFailure(error) {
  return error instanceof HttpError || typeof (error?.code ?? error?.cause?.code) === "string";
}

/**
 * main() takes optional `deps` (env, stdin, stdout, stderr and the two client
 * factories) so the tests never stub anything global. Returns the exit code.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const makeServer =
    deps.makeServer ?? ((host, { verifyTls }) => new NxServerClient(host, { verifyTls }));
  const newCloud = deps.makeCloud ?? ((host) => new NxCloudClient(host));
  const clouds = []; // the Cloud client, once the flow has made it
  const makeCloud = (host) => {
    const cloud = newCloud(host);
    clouds.push(cloud);
    return cloud;
  };

  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`ERROR: ${error.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }

  let config;
  let settings;
  try {
    config = resolveConfig(args, loadEnvFile(args.envFile), env);
    settings = loadSettings(args.settingsFile);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    stderr.write(`ERROR: ${error.message}\n`);
    return 2;
  }

  if (!fs.existsSync(args.settingsFile)) {
    // Not an error: a new site gets the defaults, and an existing one keeps
    // its settings. But a mistyped path would otherwise be ignored without a
    // word.
    stderr.write(
      `Note: ${args.settingsFile} not found. A new site gets the default settings, ` +
        "an existing one keeps its own.\n",
    );
  }

  const server = makeServer(config.host, { verifyTls: !args.insecure });
  try {
    const summary = await configureSite(config, settings, server, makeCloud, {
      allowExisting: args.yes,
      getMfaCode: mfaCodeSource(args, config, { stdin: deps.stdin ?? process.stdin }),
    });
    stdout.write(`${formatSummary(config, summary)}\n`);
  } catch (error) {
    if (
      error instanceof AuthError ||
      error instanceof ApiError ||
      error instanceof ExistingSiteError
    ) {
      stderr.write(`ERROR: ${error.message}\n`);
      return 1;
    }
    if (isTlsFailure(error)) {
      stderr.write(`ERROR: ${certificateMessage(where(error, config.host), config.host)}\n`);
      return 1;
    }
    if (isRequestFailure(error)) {
      stderr.write(`ERROR: could not complete a request to ${where(error, config.host)}: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    // Always release the server session and revoke the Cloud token, even
    // when a step failed.
    for (const client of [server, ...clouds]) {
      try {
        await client.logout();
      } catch {
        // A logout that cannot be delivered is not a reason to report failure.
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
  // exitCode, not process.exit(): exit() can cut off output still queued.
  main().then((code) => {
    process.exitCode = code;
  });
}
