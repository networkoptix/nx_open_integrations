#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST Server API sample: copy one device's Device Agent (analytics
 * plugin) settings onto another device.
 *
 * Built-in `fetch` (Node 18+) and `node:test`, no third-party dependencies.
 *
 * Downloads the settings an analytics Engine keeps for one Device Agent, then
 * applies them to another device running the same (or a compatible) Engine.
 * Two subcommands, like rest-backup-site-database: "download" writes the
 * settings to a JSON file, "apply" loads that file and sends it to a target
 * device. Run "apply" once per target device; looping over many devices is a
 * shell loop around this command, not a flag on it.
 *
 *   download:
 *     1. Log in:  POST /rest/v4/login/sessions  {username, password} -> {"token": ...}
 *     2. Get:     GET /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
 *     3. Log out: DELETE /rest/v4/login/sessions/<token>
 *
 *   apply:
 *     1. Log in, as above.
 *     2. Set:     PUT /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
 *                 with the downloaded settings, minus deviceId and engineId:
 *                 those are read-only in the response and are not even in the
 *                 spec's PUT request body schema, because the URL already
 *                 identifies the device and engine. _error is dropped too: it
 *                 is the source device's error report, not configuration.
 *                 Everything else (values, model, analyzedStream,
 *                 disableStreamSelection) is forwarded unchanged. A 2xx whose
 *                 body carries a non-empty _error map means the Engine
 *                 rejected some values, which is reported as a failure.
 *     3. Log out, whatever happened in step 2.
 *
 * No request follows a redirect: a 3xx is reported as a failure.
 *
 * Connecting to the server:
 *   --host is the server, e.g. https://192.168.1.10:7001 (https + port).
 *   Local servers usually present a self-signed certificate, so for a lab
 *   server you will typically need --insecure.
 *
 * Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
 */

import fs from "node:fs";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// deviceId and engineId are read-only in the response and are not even in the
// spec's PUT request body schema: the URL identifies the device and engine,
// not the body. _error is the source device's error report; echoing it back
// would hand the target someone else's errors. Everything else is forwarded
// unchanged.
const NOT_FORWARDED_SETTINGS_FIELDS = new Set(["deviceId", "engineId", "_error"]);

/**
 * TLS handshake failures: the server's certificate was not trusted, or the
 * other end does not speak TLS. The connection was never made, so nothing
 * was sent. Any other code containing CERT or SELF_SIGNED counts too, but not
 * every code containing SSL: ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC, say,
 * can come mid-stream, after the request was sent.
 */
const TLS_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
]);

/**
 * fetch failures that happen before a byte of the request leaves: the
 * connection was refused, the name did not resolve, the route is down, the
 * connect timed out, or the TLS handshake failed. fetch reports them as a
 * TypeError with the socket error in `cause`. Anything else (a reset or drop
 * after connecting, a timeout waiting for the answer) may come after the
 * request was sent.
 */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  ...TLS_CODES,
]);

const CERTIFICATE_MESSAGE =
  "certificate verification failed. Local servers use a self-signed " +
  "certificate, add --insecure.";

/**
 * What a run in progress must undo if Ctrl-C ends the process: its session.
 * SIGINT kills the process before any catch or finally runs, so the entry
 * point's SIGINT handler runs these instead.
 */
const onInterrupt = new Set();

/**
 * The run's exit code once it has printed its result, null before that. Set
 * just before the final logout, so Ctrl-C during that logout keeps the result
 * instead of reporting the run as interrupted.
 */
let finishedCode = null;

/** True while the settings PUT is on the wire: Ctrl-C then leaves the outcome unknown. */
let applyInFlight = false;

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

/**
 * The settings PUT may have reached the server, but no answer came back: the
 * connection was lost or timed out after sending. Nobody knows whether the
 * settings were applied.
 */
export class OutcomeUnknownError extends Error {
  constructor() {
    super(
      "Outcome unknown: the connection was lost after the settings were sent. " +
        "Download the device's settings to check.",
    );
    this.name = "OutcomeUnknownError";
  }
}

/** Configuration is missing, which is exit code 2 rather than a call failure. */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
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

/** Apply the house precedence: CLI flag > environment variable > .env file. */
export function resolveConfig(cliArgs, envFileValues = {}, env = process.env) {
  const pick = (cliValue, envKey) => {
    if (cliValue) return cliValue;
    return env[envKey] || envFileValues[envKey] || "";
  };
  return {
    host: pick(cliArgs.host, "NX_SERVER_HOST").replace(/\/+$/, ""),
    user: pick(cliArgs.user, "NX_SERVER_USER"),
    password: pick(cliArgs.password, "NX_SERVER_PASSWORD"),
    deviceId: pick(cliArgs.deviceId, "NX_DEVICE_ID"),
    engineId: pick(cliArgs.engineId, "NX_ANALYTICS_ENGINE_ID"),
  };
}

// ---------------------------------------------------------------------------
// Client
//
// A minimal bearer-token client for one VMS server. Deliberately small: one
// token, no retry logic. The point is to show the calls, not to be a library.
// ---------------------------------------------------------------------------

export class NxServerClient {
  constructor(host, { verifyTls = true, fetchImpl = fetch, timeout = 30000 } = {}) {
    this.host = (host || "").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.token = null;
    if (!verifyTls) {
      // --insecure is expected for local servers with self-signed certs.
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    }
  }

  /**
   * One request, answer body included, aborted after `this.timeout` ms.
   *
   * Resolves to { status, ok, redirect, text }. The body is read inside the
   * timer, so a server that sends headers and then stalls is cut off too.
   * redirect: "manual" means a 3xx comes back as itself: followed, a 302
   * would silently turn the PUT into a GET of somewhere else.
   */
  async _request(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await response.text();
      const status = response.status;
      return {
        status,
        ok: status >= 200 && status < 300,
        redirect: status >= 300 && status < 400,
        text,
      };
    } catch (exc) {
      if (controller.signal.aborted) {
        throw Object.assign(
          new Error(`no answer within ${this.timeout / 1000} s`),
          { code: "TIMEOUT" },
        );
      }
      throw exc;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST login/sessions -> bearer token, stored on this client. */
  async login(username, password) {
    const url = `${this.host}${API}/login/sessions`;
    const response = await this._request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login unauthorized (HTTP ${response.status}). Check the password, and ` +
          "note that a cloud account cannot log in here. It needs the OAuth2 flow.",
      );
    }
    if (!response.ok) {
      throw new ApiError(`Login failed: ${describeStatus(response)}.`);
    }

    let data;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new ApiError("Login failed: the response was not valid JSON.");
    }
    const token = isPlainObject(data) ? data.token : undefined;
    if (typeof token !== "string" || !token) {
      throw new ApiError("Login failed: the response did not contain a token.");
    }

    this.token = token;
    return token;
  }

  _authHeader() {
    return { Authorization: `Bearer ${this.token}` };
  }

  _settingsUrl(engineId, deviceId) {
    return `${this.host}${API}/analytics/engines/${encodeURIComponent(engineId)}/deviceAgents/${encodeURIComponent(deviceId)}/settings`;
  }

  /**
   * GET a Device Agent's settings -> the bare settings object.
   *
   * Your account needs Power User (or better) on this site.
   */
  async downloadSettings(engineId, deviceId) {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    const response = await this._request(this._settingsUrl(engineId, deviceId), {
      headers: this._authHeader(),
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Reading settings was refused (HTTP ${response.status}). This endpoint ` +
          "needs Power User or better.",
      );
    }
    if (!response.ok) {
      throw new ApiError(`Reading settings failed: ${describeStatus(response)}.`);
    }

    let data;
    try {
      data = unwrapReply(JSON.parse(response.text));
    } catch {
      data = undefined;
    }
    if (!isPlainObject(data)) {
      throw new ApiError("Reading settings failed: the server did not return a JSON object.");
    }
    return data;
  }

  /**
   * PUT a Device Agent's settings. body should come from buildApplyBody().
   *
   * Resolves to the Engine's error map: {} when the settings were applied,
   * otherwise { settingName: message, ... } for the values it rejected.
   * Throws OutcomeUnknownError when the request may have been sent but no
   * answer arrived; a failure to connect at all is rethrown as it is.
   */
  async applySettings(engineId, deviceId, body) {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    let response;
    applyInFlight = true;
    try {
      response = await this._request(this._settingsUrl(engineId, deviceId), {
        method: "PUT",
        headers: { ...this._authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      if (wasNotSent(exc)) throw exc;
      throw new OutcomeUnknownError();
    } finally {
      applyInFlight = false;
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Applying settings was refused (HTTP ${response.status}). This endpoint ` +
          "needs Power User or better.",
      );
    }
    if (!response.ok) {
      // A 3xx or 4xx was refused as a whole. A 5xx may have failed halfway,
      // after some values were stored, so it cannot promise "not applied".
      let outcome;
      if (response.redirect) {
        outcome = "The settings were not applied.";
      } else if (response.status < 500) {
        outcome =
          "The settings were not applied. The target device may not be running this Engine.";
      } else {
        outcome =
          "The server may have applied some of them; download the device's settings to check.";
      }
      throw new ApiError(`Applying settings failed: ${describeStatus(response)}. ${outcome}`);
    }

    // An empty body, or one that is not JSON, is a plain success: only a JSON
    // object with a non-empty _error map says the Engine refused something.
    if (!response.text.trim()) return {};
    let data;
    try {
      data = unwrapReply(JSON.parse(response.text));
    } catch {
      return {};
    }
    const errors = isPlainObject(data) ? data._error : undefined;
    return isPlainObject(errors) ? errors : {};
  }

  /** DELETE the session so the token is not left valid. Safe to call twice. */
  async logout() {
    if (!this.token) return;
    const token = this.token;
    this.token = null;
    const response = await this._request(`${this.host}${API}/login/sessions/${token}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new ApiError(`Logout failed: ${describeStatus(response)}.`);
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "HTTP 500", or "HTTP 302 (redirect not followed)". */
function describeStatus(response) {
  return response.redirect
    ? `HTTP ${response.status} (redirect not followed)`
    : `HTTP ${response.status}`;
}

/**
 * Some Nx versions wrap a single-object reply in {"reply": {...}}, the same
 * way list endpoints wrap an array.
 */
function unwrapReply(data) {
  return isPlainObject(data) && isPlainObject(data.reply) ? data.reply : data;
}

/** The socket error code: on the error itself, or on fetch's `cause`. */
function errorCode(error) {
  const code = error?.code ?? error?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/** A TLS handshake failure (see TLS_CODES): the certificate message applies. */
export function isTlsFailure(error) {
  const code = errorCode(error);
  if (code === undefined) return false;
  return (
    TLS_CODES.has(code) ||
    code.includes("CERT") ||
    code.includes("SELF_SIGNED")
  );
}

/**
 * True when a failed request certainly never left this machine: refused,
 * unresolvable, unroutable, a connect timeout, a TLS handshake that failed,
 * or a URL fetch would not even try.
 */
export function wasNotSent(error) {
  const code = errorCode(error);
  if (code !== undefined && NOT_SENT_CODES.has(code)) return true;
  if (isTlsFailure(error)) return true;
  // fetch rejects a malformed URL or header with a TypeError and no cause,
  // before it opens any connection.
  return error instanceof TypeError && error.cause === undefined;
}

// ---------------------------------------------------------------------------
// Settings file <-> PUT body
// ---------------------------------------------------------------------------

/**
 * Drop the fields the URL already identifies (deviceId, engineId) and the
 * source's error report (_error); forward the rest of the downloaded settings
 * unchanged (values, model, analyzedStream, disableStreamSelection).
 *
 * A field absent from `settings` (a hand-edited or partial file) stays absent
 * from the body rather than being sent as null, so it is not mistaken for
 * "clear this setting".
 *
 * `settings` must be a JSON object. An array or a scalar is refused rather
 * than quietly turned into an empty body that would wipe the target.
 */
export function buildApplyBody(settings) {
  if (!isPlainObject(settings)) {
    throw new TypeError("the settings must be a JSON object");
  }
  const body = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!NOT_FORWARDED_SETTINGS_FIELDS.has(key)) body[key] = value;
  }
  return body;
}

/**
 * Build a filename that says which device the settings came from, and when.
 *
 * The timestamp is UTC so that downloads taken in different time zones still
 * sort into the order they were taken.
 */
export function defaultOutputName(deviceId, now = new Date()) {
  const when = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `nx-device-agent-settings-${deviceId}-${when}.json`;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

/**
 * Write the downloaded settings object as pretty-printed JSON, keys sorted.
 *
 * The JSON goes to a side file first, <path>.<random>.partial, created
 * exclusively and owner-only (0600), and is moved into place only once it is
 * whole. An existing file is replaced only with `overwrite` (--force); without
 * it, the move is a link(), which fails atomically if `path` appeared in the
 * meantime, where a rename would silently replace it. The side file never
 * stays behind. Everything here is synchronous, so Ctrl-C cannot land in the
 * middle of it and needs no cleanup of its own.
 *
 * `link` is fs.linkSync; the tests swap it for one that fails.
 */
export function saveSettingsFile(path, settings, { overwrite = false, link = fs.linkSync } = {}) {
  const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
  const removePartial = () => fs.rmSync(partial, { force: true });
  try {
    fs.writeFileSync(partial, `${JSON.stringify(sortKeysDeep(settings), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (overwrite) {
      fs.renameSync(partial, path);
    } else {
      let linked = true;
      try {
        link(partial, path);
      } catch (exc) {
        if (exc.code === "EEXIST") throw new ApiError(`${path} already exists; use --force`);
        // No hard links here (FAT/exFAT, some network shares, EPERM, EXDEV,
        // ...). Fall back to check-then-rename. That leaves a small window:
        // a file created between the check and the rename is replaced.
        linked = false;
      }
      if (linked) {
        removePartial();
      } else {
        if (exists(path)) throw new ApiError(`${path} already exists; use --force`);
        fs.renameSync(partial, path);
      }
    }
  } catch (exc) {
    removePartial();
    throw exc;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  rest_copy_device_agent_settings.mjs download [--out PATH] [--force] [options]
  rest_copy_device_agent_settings.mjs apply <file> --yes [options]

Options: --host --user --password --device-id --engine-id --dotenv --insecure
`;


/**
 * A failed file operation. Node puts the path and syscall on the error itself;
 * a failed fetch is a TypeError with the socket error tucked in `cause`.
 */
function isLocalFileError(error) {
  return typeof error?.syscall === "string" && typeof error?.path === "string";
}

/**
 * True when anything is at `path`, a dangling symlink included: existsSync
 * follows the link and says no, and the move would then replace the link.
 */
function exists(path) {
  return fs.lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function isDirectory(path) {
  return fs.statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

export function parseArgs(argv) {
  const flags = {
    command: null,
    file: null,
    host: null,
    user: null,
    password: null,
    deviceId: null,
    engineId: null,
    envFile: ".env",
    insecure: false,
    out: null,
    force: false,
    yes: false,
  };
  const valued = {
    "--host": "host",
    "--user": "user",
    "--password": "password",
    "--device-id": "deviceId",
    "--engine-id": "engineId",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
    "--out": "out",
  };
  const booleans = {
    "--insecure": "insecure",
    "--force": "force",
    "--yes": "yes",
  };

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) {
      // --yes=no must not mean yes: a boolean flag takes no value at all.
      if (inlineValue !== null) throw new Error(`${arg} takes no value`);
      flags[booleans[arg]] = true;
    } else if (arg in valued) {
      // A missing value is an error, not undefined: "--out" at the end, or
      // followed by another flag, would otherwise pass silently.
      const value = inlineValue !== null ? inlineValue : argv[++i];
      if (value === undefined || value === "" || (inlineValue === null && value.startsWith("--"))) {
        throw new Error(`Missing value for ${arg}`);
      }
      flags[valued[arg]] = value;
    } else if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown argument: ${arg}`);
    else if (flags.command === null) flags.command = arg;
    else if (flags.file === null) flags.file = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return flags;
}

function resolveOrFail(args) {
  const config = resolveConfig(args, loadEnvFile(args.envFile));
  const missing = ["host", "user", "password", "deviceId", "engineId"].filter(
    (name) => !config[name],
  );
  if (missing.length) {
    throw new ConfigError(
      `missing configuration: ${missing.join(", ")}. Set it with a flag, an NX_* ` +
        `environment variable, or in ${args.envFile}.`,
    );
  }
  return config;
}

/** `text` with exactly one final period: "a" and "a.." both become "a.". */
function withPeriod(text) {
  return `${String(text).replace(/\.+$/, "")}.`;
}

/** What a failed request says went wrong, ending in exactly one period. */
function describeFailure(exc) {
  if (isTlsFailure(exc)) return CERTIFICATE_MESSAGE;
  if (errorCode(exc) === "UND_ERR_CONNECT_TIMEOUT") {
    // fetch's own connect timeout: "Connect Timeout Error (attempted address:
    // ..., timeout: 10000ms)". Say what happened, in seconds.
    const ms = /timeout: (\d+)\s*ms/.exec(exc?.cause?.message ?? exc?.message ?? "")?.[1];
    return `no connection within ${ms ? Number(ms) / 1000 : 10} s.`;
  }
  return withPeriod(exc?.cause?.message || (exc instanceof Error ? exc.message : String(exc)));
}

/**
 * The OS's description of a failed file operation, without the path or the
 * code: "ENOENT: no such file or directory, open 'x'" -> "No such file or
 * directory".
 */
function describeFileError(exc) {
  const text = /^[A-Z0-9_]+: ([^,]+)/.exec(exc?.message ?? "")?.[1] ?? exc?.code ?? String(exc);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Log out once the run has printed its result. A failure here is not the
 * run's result, so it is only a warning; the exit code stands.
 */
async function logoutAfterResult(client, stderr) {
  try {
    await client.logout();
  } catch (exc) {
    stderr.write(`WARNING: could not log out: ${describeFailure(exc)}\n`);
  }
}

/**
 * Log out after the run failed. The real error is what the user needs to
 * see, so a failed logout stays silent.
 */
async function logoutQuietly(client) {
  try {
    await client.logout();
  } catch {
    // The run's own error is already on its way.
  }
}

/** End the session: warn on failure only if the run printed its result. */
function endSession(client, stderr) {
  return finishedCode !== null ? logoutAfterResult(client, stderr) : logoutQuietly(client);
}

async function runDownload(args, deps, stdout, stderr) {
  const config = resolveOrFail(args);
  const outPath = args.out ?? defaultOutputName(config.deviceId);
  if (isDirectory(outPath)) {
    stderr.write(`ERROR: ${outPath} is a directory. Give --out a file path.\n`);
    return 1;
  }
  // Checked again when the file is moved into place, in case it appears
  // during the download; this early check just saves a pointless login.
  if (exists(outPath) && !args.force) {
    stderr.write(`ERROR: ${outPath} already exists; use --force\n`);
    return 1;
  }

  const client = new NxServerClient(config.host, {
    verifyTls: !args.insecure,
    fetchImpl: deps.fetchImpl,
  });
  const logoutOnInterrupt = () => client.logout();
  onInterrupt.add(logoutOnInterrupt);
  try {
    await client.login(config.user, config.password);
    stdout.write(`Logged in to ${config.host} as ${config.user}\n\n`);

    const settings = await client.downloadSettings(config.engineId, config.deviceId);
    try {
      saveSettingsFile(outPath, settings, { overwrite: args.force });
    } catch (exc) {
      // Name the path the user asked for, never the internal side file.
      if (!isLocalFileError(exc)) throw exc;
      throw new ApiError(`could not use ${outPath}: ${describeFileError(exc)}.`);
    }
    stdout.write(
      `Downloaded Device Agent settings for device ${config.deviceId} ` +
        `(engine ${config.engineId}) -> ${outPath}\n`,
    );
    finishedCode = 0;
    return 0;
  } finally {
    await endSession(client, stderr);
    onInterrupt.delete(logoutOnInterrupt);
  }
}

/** Read and check the settings file, before anything is sent. */
function loadSettingsFile(source) {
  if (!fs.existsSync(source)) throw new ApiError(`No such settings file: ${source}`);
  if (isDirectory(source)) throw new ApiError(`${source} is a directory, not a settings file.`);
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(source, "utf-8"));
  } catch (exc) {
    if (isLocalFileError(exc)) throw exc;
    throw new ApiError(`${source} is not valid JSON: ${exc.message.replace(/\.+$/, "")}.`);
  }
  if (!isPlainObject(settings)) throw new ApiError(`${source} does not hold a JSON object.`);
  return settings;
}

async function runApply(args, deps, stdout, stderr) {
  if (!args.yes) {
    stderr.write(
      "ERROR: Refusing to apply without --yes. This overwrites the target " +
        "device's existing Device Agent settings.\n",
    );
    return 1;
  }
  const body = buildApplyBody(loadSettingsFile(args.file ?? ""));

  const config = resolveOrFail(args);

  const client = new NxServerClient(config.host, {
    verifyTls: !args.insecure,
    fetchImpl: deps.fetchImpl,
  });
  const logoutOnInterrupt = () => client.logout();
  onInterrupt.add(logoutOnInterrupt);
  try {
    await client.login(config.user, config.password);
    stdout.write(`Logged in to ${config.host} as ${config.user}\n\n`);

    const errors = await client.applySettings(config.engineId, config.deviceId, body);
    const names = Object.keys(errors);
    if (names.length) {
      stderr.write("ERROR: The server took the settings but the Engine reported errors:\n");
      for (const name of names) {
        const message = errors[name];
        stderr.write(`  ${name}: ${typeof message === "string" ? message : JSON.stringify(message)}\n`);
      }
      finishedCode = 1;
      return 1;
    }
    stdout.write(
      `Applied Device Agent settings to device ${config.deviceId} (engine ${config.engineId}).\n`,
    );
    finishedCode = 0;
    return 0;
  } finally {
    await endSession(client, stderr);
    onInterrupt.delete(logoutOnInterrupt);
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  // stdout and stderr are injectable so the tests never stub the real streams.
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  finishedCode = null;

  let args;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    stderr.write(`ERROR: ${exc instanceof Error ? exc.message : String(exc)}\n`);
    return 2;
  }

  if (args.command !== "download" && args.command !== "apply") {
    stderr.write(USAGE);
    return 2;
  }

  try {
    if (args.command === "download") return await runDownload(args, deps, stdout, stderr);
    return await runApply(args, deps, stdout, stderr);
  } catch (exc) {
    if (exc instanceof ConfigError) {
      stderr.write(`ERROR: ${exc.message}\n`);
      return 2;
    }
    if (
      exc instanceof AuthError ||
      exc instanceof ApiError ||
      exc instanceof OutcomeUnknownError
    ) {
      stderr.write(`ERROR: ${exc.message}\n`);
      return 1;
    }
    if (isLocalFileError(exc)) {
      stderr.write(`ERROR: ${exc.message}\n`);
      return 1;
    }
    // Only a request that never left can end up here during apply (see
    // applySettings), so saying "not applied" is the truth.
    const notApplied = args.command === "apply" ? " The settings were not applied." : "";
    if (isTlsFailure(exc)) {
      stderr.write(`ERROR: ${CERTIFICATE_MESSAGE}${notApplied}\n`);
      return 1;
    }
    stderr.write(`ERROR: could not reach the server: ${describeFailure(exc)}${notApplied}\n`);
    return 1;
  }
}

// Compare real paths: run through a symlink (npm's bin link, npx), argv[1] is
// the link while import.meta.url is the file, and a plain === never matches.
const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // null until main() has finished and printed its result.
  let mainCode = null;
  main().then((code) => {
    mainCode = code;
    process.exitCode = code;
  });
  process.once("SIGINT", async () => {
    // Read before the cleanup below: the PUT may answer while it runs.
    const outcomeUnknown = applyInFlight;
    // The result is printed and only the final logout is in flight: the run
    // stands, the logout is what got interrupted.
    if (finishedCode !== null && mainCode === null) {
      process.stderr.write("WARNING: could not log out: interrupted.\n");
      process.exit(finishedCode);
    }
    // Undo what the run in progress would have in its finally: end its
    // session (given a few seconds at most).
    for (const cleanup of onInterrupt) {
      await Promise.race([
        Promise.resolve().then(cleanup).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    // main() may have printed its result while the logout above was in
    // flight: that result stands, not "Interrupted.".
    if (mainCode !== null || finishedCode !== null) process.exit(mainCode ?? finishedCode);
    process.stderr.write(
      outcomeUnknown
        ? "Interrupted. Outcome unknown: the settings may have been sent. Download the device's settings to check.\n"
        : "Interrupted.\n",
    );
    process.exit(130);
  });
}
