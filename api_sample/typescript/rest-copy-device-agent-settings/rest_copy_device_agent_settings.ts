#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST Server API sample: copy one device's Device Agent (analytics
 * plugin) settings onto another device.
 *
 * Runs directly on Node 22.6+ via native type stripping. Built-in `fetch` and
 * `node:test`, no third-party dependencies.
 *
 * Downloads the settings an analytics Engine keeps for one Device Agent, then
 * applies them to another device running the same (or a compatible) Engine.
 * Two subcommands: "download" writes the settings to a JSON file, "apply"
 * loads that file and sends it to a target device. Run "apply" once per target
 * device; looping over many devices is a shell loop around this command, not a
 * flag on it.
 *
 *   download:
 *     1. Log in:  POST /rest/v4/login/sessions  {username, password} -> {"token": ...}
 *     2. Get:     GET /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
 *     3. Log out: DELETE /rest/v4/login/sessions/<token>
 *
 *   apply:
 *     1. Log in, as above.
 *     2. Set:     PUT /rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
 *                 with the downloaded settings, minus deviceId, engineId and
 *                 _error. The first two are read-only in the response: the
 *                 URL already identifies the device and engine. _error is the
 *                 source Engine's own error report, which must not be echoed
 *                 back. Everything else (values, model, analyzedStream,
 *                 disableStreamSelection, ...) is forwarded unchanged.
 *                 A 2xx answer can still carry an `_error` map: the server
 *                 took the settings, but the Engine rejected some of them.
 *     3. Log out. This runs whether the call succeeded or not.
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

import type { FetchImpl } from "../nx-types.ts";

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

/**
 * Fields of a downloaded settings file that are not sent back on apply.
 * deviceId and engineId are read-only in the response: the URL identifies the
 * device and engine, not the body. _error is the source Engine's error report
 * for the source device, and echoing it back to another device means nothing.
 */
const NOT_SENT_ON_APPLY = new Set(["deviceId", "engineId", "_error"]);

/**
 * TLS handshake failures: the server's certificate was not trusted, or the
 * two sides never agreed on TLS. Any other code naming CERT or SELF_SIGNED
 * counts too (see isTlsFailure). A code that only names SSL does not: an
 * error such as ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC can come
 * mid-stream, after the request was sent.
 */
const TLS_FAILURE_CODES = new Set([
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
 * Failures that mean the connection was never made, so nothing was sent: the
 * socket-level ones below, plus every TLS failure. fetch rejects with a
 * TypeError and puts the real code in `cause`.
 */
const NEVER_CONNECTED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
  ...TLS_FAILURE_CODES,
]);

/** What to print for a TLS failure, on any request. */
const CERTIFICATE_MESSAGE =
  "certificate verification failed. Local servers use a self-signed certificate, add --insecure.";

/**
 * What a run in progress must undo if Ctrl-C ends the process: its session.
 * SIGINT kills the process before any catch or finally runs, so the entry
 * point's SIGINT handler runs these instead. (The side file needs no entry:
 * saveSettingsFile is synchronous, so Ctrl-C never lands while it exists.)
 */
const onInterrupt = new Set<() => unknown>();

/**
 * The run's exit code, set once its result is printed and only the final
 * logout is left. Ctrl-C from then on cannot undo the work, so the SIGINT
 * handler keeps this code instead of saying "Interrupted.".
 */
let resultCode: number | undefined;

/** True while the settings PUT is on the wire: Ctrl-C then leaves the outcome unknown. */
let applyInFlight = false;

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

/** Configuration is missing, which is exit code 2 rather than a call failure. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Configuration (CLI > env > .env). Server vars are NX_SERVER_*.
// ---------------------------------------------------------------------------

export interface CliArgs {
  command: string | null;
  file: string | null;
  host: string | null;
  user: string | null;
  password: string | null;
  deviceId: string | null;
  engineId: string | null;
  envFile: string;
  insecure: boolean;
  out: string | null;
  force: boolean;
  yes: boolean;
  /** --help or -h as a flag of its own, not as another flag's value. */
  help: boolean;
}

export interface ResolvedConfig {
  host: string;
  user: string;
  password: string;
  deviceId: string;
  engineId: string;
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

/** Apply the house precedence: CLI flag > environment variable > .env file. */
export function resolveConfig(
  cliArgs: Partial<CliArgs>,
  envFileValues: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const pick = (cliValue: string | null | undefined, envKey: string): string => {
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

/**
 * A Device Agent's settings, as the GET/PUT endpoint shapes it: a JSON object.
 * The sample looks at three of its fields only. `deviceId` and `engineId` are
 * echoed back for reference and `_error` is the Engine's per-setting error
 * map (see NOT_SENT_ON_APPLY). The rest is opaque, plugin-defined
 * configuration this sample never inspects, so it is not typed here.
 */
export type DeviceAgentSettings = Record<string, unknown>;

/** The per-setting errors an Engine reports, as `name: message` pairs. */
export type EngineErrors = Record<string, string>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "HTTP 500", or "HTTP 302 (redirect not followed)" for a 3xx. */
function describeStatus(status: number): string {
  if (status >= 300 && status < 400) return `HTTP ${status} (redirect not followed)`;
  return `HTTP ${status}`;
}

/** The socket-level code of a failed fetch: on the error, or in its cause. */
function errorCode(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * TLS handshake failures, which fetch reports as a TypeError with a cause.
 * Only handshake codes: they all mean the request was never sent.
 */
function isTlsFailure(error: unknown): boolean {
  const code = errorCode(error);
  return (
    code !== undefined &&
    (TLS_FAILURE_CODES.has(code) || code.includes("CERT") || code.includes("SELF_SIGNED"))
  );
}

/** `text` as a sentence: with one final period, never two. */
function sentence(text: string): string {
  return `${text.replace(/\.+$/, "")}.`;
}

/** True when the request failed before anything could have been sent. */
function isConnectFailure(error: unknown): boolean {
  const code = errorCode(error);
  return isTlsFailure(error) || (code !== undefined && NEVER_CONNECTED_CODES.has(code));
}

/**
 * The most useful message: fetch's own is just "fetch failed". A TLS failure
 * gets the certificate message, whichever request it ended.
 */
function describeError(error: unknown): string {
  if (isTlsFailure(error)) return CERTIFICATE_MESSAGE;
  const e = error as { message?: unknown; cause?: { message?: unknown } } | undefined;
  const message = e?.cause?.message ?? e?.message ?? error;
  if (errorCode(error) === "UND_ERR_CONNECT_TIMEOUT") {
    // fetch's own connect timeout: "Connect Timeout Error (attempted address:
    // ..., timeout: 10000ms)". Say what happened, in seconds.
    const ms = /timeout: (\d+)\s*ms/.exec(String(message))?.[1];
    return `no connection within ${ms ? Number(ms) / 1000 : 10} s`;
  }
  return String(message);
}

/**
 * The OS's description of a failed file operation, without the path or the
 * code: "ENOENT: no such file or directory, open 'x'" -> "No such file or
 * directory".
 */
function describeFileError(error: unknown): string {
  const e = error as { message?: unknown; code?: unknown } | undefined;
  const text = /^[A-Z0-9_]+: ([^,]+)/.exec(String(e?.message ?? ""))?.[1] ?? String(e?.code ?? error);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A whole HTTP answer: the status and the body, read to the end. */
export interface HttpReply {
  status: number;
  ok: boolean;
  text: string;
}

/** Parse a body as JSON, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Some Nx versions wrap a single-object reply in {"reply": {...}}. */
function unwrapReply(data: unknown): unknown {
  if (isPlainObject(data) && isPlainObject(data.reply)) return data.reply;
  return data;
}

export interface NxServerClientOptions {
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
  timeout?: number;
}

export class NxServerClient {
  host: string;
  fetchImpl: FetchImpl;
  timeout: number;
  token: string | null;

  constructor(
    host: string,
    { verifyTls = true, fetchImpl = fetch, timeout = 30000 }: NxServerClientOptions = {},
  ) {
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
   * One request, answer read to the end, all within `this.timeout` ms.
   *
   * redirect: "manual" means a 3xx comes back as itself, to be reported as a
   * failure, instead of fetch quietly re-sending the request (and its bearer
   * token) somewhere else. Settings are small JSON, so reading the whole body
   * here is fine.
   */
  async _request(url: string, init: RequestInit = {}): Promise<HttpReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, ok: response.ok, text };
    } catch (exc) {
      if (controller.signal.aborted) {
        throw Object.assign(new Error(`no answer within ${this.timeout / 1000} s`), {
          code: "TIMEOUT",
        });
      }
      throw exc;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST login/sessions -> bearer token, stored on this client. */
  async login(username: string, password: string): Promise<string> {
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
      throw new ApiError(`Login failed: ${describeStatus(response.status)}.`);
    }

    const data = parseJson(response.text);
    if (data === undefined) {
      throw new ApiError("Login failed: the response was not valid JSON.");
    }
    const token = isPlainObject(data) ? data.token : undefined;
    if (typeof token !== "string" || !token) {
      throw new ApiError("Login failed: the response did not contain a token.");
    }

    this.token = token;
    return token;
  }

  _authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  _settingsUrl(engineId: string, deviceId: string): string {
    return `${this.host}${API}/analytics/engines/${encodeURIComponent(engineId)}/deviceAgents/${encodeURIComponent(deviceId)}/settings`;
  }

  /**
   * GET a Device Agent's settings -> the bare settings object.
   *
   * Your account needs Power User (or better) on this site.
   */
  async downloadSettings(engineId: string, deviceId: string): Promise<DeviceAgentSettings> {
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
      throw new ApiError(`Reading settings failed: ${describeStatus(response.status)}.`);
    }

    const data = unwrapReply(parseJson(response.text));
    if (!isPlainObject(data)) {
      throw new ApiError("Reading settings failed: the server did not return a JSON object.");
    }
    return data;
  }

  /**
   * PUT a Device Agent's settings. body should come from buildApplyBody().
   *
   * Resolves to the Engine's per-setting errors: empty when the settings were
   * applied cleanly, non-empty when the server took them but the Engine
   * reported a problem with some of them.
   */
  async applySettings(
    engineId: string,
    deviceId: string,
    body: Record<string, unknown>,
  ): Promise<EngineErrors> {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    let response: HttpReply;
    applyInFlight = true;
    try {
      response = await this._request(this._settingsUrl(engineId, deviceId), {
        method: "PUT",
        headers: { ...this._authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      if (isTlsFailure(exc)) {
        throw new ApiError(`${CERTIFICATE_MESSAGE} The settings were not applied.`);
      }
      if (isConnectFailure(exc)) {
        throw new ApiError(
          `could not reach the server: ${sentence(describeError(exc))} The settings were not applied.`,
        );
      }
      // A timeout, or a connection lost once it was made: the PUT may have
      // reached the server, so nobody can say whether it was applied.
      throw new ApiError(
        "Outcome unknown: the connection was lost after the settings were sent. " +
          "Download the device's settings to check.",
      );
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
      const failed = `Applying settings failed: ${describeStatus(response.status)}.`;
      // A 5xx can come after the server already applied some of the settings.
      if (response.status >= 500) {
        throw new ApiError(
          `${failed} The server may have applied some of them; download the device's settings to check.`,
        );
      }
      const hint =
        response.status >= 400 ? " The target device may not be running this Engine." : "";
      throw new ApiError(`${failed} The settings were not applied.${hint}`);
    }

    // An empty or non-JSON answer is a plain success. A JSON object can carry
    // the Engine's per-setting errors in `_error`.
    const data = unwrapReply(parseJson(response.text));
    const reported = isPlainObject(data) ? data._error : undefined;
    const errors: EngineErrors = {};
    if (isPlainObject(reported)) {
      for (const [name, message] of Object.entries(reported)) {
        errors[name] = typeof message === "string" ? message : JSON.stringify(message);
      }
    }
    return errors;
  }

  /** DELETE the session so the token is not left valid. Safe to call twice. */
  async logout(): Promise<void> {
    if (!this.token) return;
    const token = this.token;
    this.token = null;
    const response = await this._request(`${this.host}${API}/login/sessions/${token}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new ApiError(`Logout failed: ${describeStatus(response.status)}.`);
  }
}

// ---------------------------------------------------------------------------
// Settings file <-> PUT body
// ---------------------------------------------------------------------------

/**
 * Drop deviceId, engineId and _error (see NOT_SENT_ON_APPLY); forward the
 * rest of the downloaded settings unchanged.
 *
 * A field absent from `settings` (a hand-edited or partial file) stays absent
 * from the body rather than being sent as null, so it is not mistaken for
 * "clear this setting".
 */
export function buildApplyBody(settings: DeviceAgentSettings): Record<string, unknown> {
  // The type already says "object", but the settings come from JSON.parse,
  // which the compiler cannot check: an array or a number must not get here.
  if (!isPlainObject(settings)) throw new ApiError("The settings are not a JSON object.");
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!NOT_SENT_ON_APPLY.has(key)) body[key] = value;
  }
  return body;
}

/**
 * Read and check a settings file. Throws ApiError with a message for the user
 * when the file is not usable, so nothing is sent.
 */
export function loadSettingsFile(path: string): DeviceAgentSettings {
  const stat = fs.statSync(path, { throwIfNoEntry: false });
  if (!stat) throw new ApiError(`No such settings file: ${path}`);
  if (stat.isDirectory()) throw new ApiError(`${path} is a directory, not a settings file.`);
  let text: string;
  try {
    text = fs.readFileSync(path, "utf-8");
  } catch (exc) {
    throw new ApiError(`could not read ${path}: ${describeError(exc)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (exc) {
    throw new ApiError(`${path} is not valid JSON: ${sentence(describeError(exc))}`);
  }
  if (!isPlainObject(data)) throw new ApiError(`${path} does not hold a JSON object.`);
  return data;
}

/**
 * Build a filename that says which device the settings came from, and when.
 *
 * The timestamp is UTC so that downloads taken in different time zones still
 * sort into the order they were taken.
 */
export function defaultOutputName(deviceId: string, now: Date = new Date()): string {
  const when = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `nx-device-agent-settings-${deviceId}-${when}.json`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (isPlainObject(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeysDeep(value[key]);
    return sorted;
  }
  return value;
}

/** `path` already exists and --force was not given. */
export class AlreadyExistsError extends ApiError {
  constructor(path: string) {
    super(`${path} already exists; use --force`);
    this.name = "AlreadyExistsError";
  }
}

/**
 * Write the downloaded settings object as pretty-printed JSON, keys sorted.
 *
 * The file is written beside the destination under a unique name first, then
 * moved into place. Without `overwrite` the move is a link(), which fails if
 * the destination exists, so a file that appeared during the download is not
 * clobbered. With `overwrite` (--force) it is an atomic rename. The side file
 * is removed on every failure.
 *
 * Not every filesystem has hard links (FAT, exFAT, many network shares). There
 * the move falls back to "refuse if the destination exists, else rename".
 * That leaves a small window, between the check and the rename, in which a
 * file that appears would still be replaced: the best such a filesystem
 * allows.
 *
 * Fully synchronous, so Ctrl-C cannot interrupt it halfway.
 */
export function saveSettingsFile(
  path: string,
  settings: DeviceAgentSettings,
  { overwrite = false }: { overwrite?: boolean } = {},
): void {
  const partial = `${path}.${randomBytes(6).toString("hex")}.partial`;
  const removePartial = () => fs.rmSync(partial, { force: true });
  try {
    // "wx": created exclusively, never into someone else's file. 0600: the
    // settings are the site's configuration, not for every local user.
    fs.writeFileSync(partial, `${JSON.stringify(sortKeysDeep(settings), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (overwrite) {
      fs.renameSync(partial, path);
    } else {
      let linked = true;
      try {
        fs.linkSync(partial, path);
      } catch (exc) {
        if ((exc as { code?: string }).code === "EEXIST") throw new AlreadyExistsError(path);
        linked = false; // no hard links here: check, then rename (see above)
      }
      if (linked) {
        removePartial();
      } else {
        if (fs.lstatSync(path, { throwIfNoEntry: false })) throw new AlreadyExistsError(path);
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
  rest_copy_device_agent_settings.ts download [--out PATH] [--force] [options]
  rest_copy_device_agent_settings.ts apply <file> --yes [options]

Options: --host --user --password --device-id --engine-id --dotenv --insecure
         --help, -h  print this usage
`;

type ValuedFlag = "host" | "user" | "password" | "deviceId" | "engineId" | "envFile" | "out";
type BooleanFlag = "insecure" | "force" | "yes";

const VALUED_FLAGS = new Map<string, ValuedFlag>([
  ["--host", "host"],
  ["--user", "user"],
  ["--password", "password"],
  ["--device-id", "deviceId"],
  ["--engine-id", "engineId"],
  ["--dotenv", "envFile"], // NOT --env-file (a Node built-in)
  ["--out", "out"],
]);

const BOOLEAN_FLAGS = new Map<string, BooleanFlag>([
  ["--insecure", "insecure"],
  ["--force", "force"],
  ["--yes", "yes"],
]);

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
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
    help: false,
  };

  // One iterator, so a value flag can take the next argument from it.
  const args = argv[Symbol.iterator]();
  for (const raw of args) {
    // Only here, as a flag of its own: `--password -h` is a password, not help.
    if (raw === "--help" || raw === "-h") {
      flags.help = true;
      return flags;
    }
    let arg = raw;
    let inlineValue: string | null = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const booleanFlag = BOOLEAN_FLAGS.get(arg);
    const valuedFlag = VALUED_FLAGS.get(arg);
    if (booleanFlag) {
      // --yes=no must not mean yes: a boolean flag takes no value at all.
      if (inlineValue !== null) throw new Error(`${arg} takes no value`);
      flags[booleanFlag] = true;
    } else if (valuedFlag) {
      let value = inlineValue;
      if (value === null) {
        const next = args.next();
        // `--out --force` is a forgotten value, not an output file named --force.
        value = next.done || next.value.startsWith("--") ? "" : next.value;
      }
      if (!value) throw new Error(`Missing value for ${arg}`);
      flags[valuedFlag] = value;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (flags.command === null) {
      flags.command = arg;
    } else if (flags.file === null) {
      flags.file = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return flags;
}

function resolveOrFail(args: CliArgs): ResolvedConfig {
  const config = resolveConfig(args, loadEnvFile(args.envFile));
  const missing = (["host", "user", "password", "deviceId", "engineId"] as const).filter(
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

/** True when `path` exists and is a directory. */
function isDirectory(path: string): boolean {
  return fs.statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * A failed file operation. Node puts the path and syscall on the error itself;
 * a failed fetch is a TypeError with the socket error tucked in `cause`.
 */
function isLocalFileError(error: unknown): boolean {
  const e = error as { syscall?: unknown; path?: unknown } | null;
  return typeof e?.syscall === "string" && typeof e?.path === "string";
}

export interface MainDeps {
  fetchImpl?: FetchImpl;
  /** Injectable so tests never have to stub the real process streams. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * Log in, run `work`, and log out whatever happened.
 *
 * A failed logout after a failed call is ignored: the call's own error is the
 * one to report. A failed logout after a successful call is only a warning;
 * the call's result, already printed, stands.
 */
async function inSession(
  client: NxServerClient,
  config: ResolvedConfig,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  work: () => Promise<number>,
): Promise<number> {
  await client.login(config.user, config.password);
  stdout.write(`Logged in to ${config.host} as ${config.user}\n\n`);

  const endSession = () => client.logout();
  onInterrupt.add(endSession);
  let code: number;
  try {
    code = await work();
  } catch (exc) {
    await client.logout().catch(() => {});
    throw exc;
  } finally {
    onInterrupt.delete(endSession);
  }
  // The result is printed: from here on Ctrl-C only cuts the logout short.
  resultCode = code;
  try {
    await client.logout();
  } catch (exc) {
    stderr.write(`WARNING: could not log out: ${sentence(describeError(exc))}\n`);
  }
  return code;
}

async function runDownload(
  args: CliArgs,
  deps: MainDeps,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (args.out && isDirectory(args.out)) {
    stderr.write(`ERROR: ${args.out} is a directory. Give --out a file path.\n`);
    return 1;
  }

  const config = resolveOrFail(args);
  const outPath = args.out || defaultOutputName(config.deviceId);
  // Refuse early, before logging in. saveSettingsFile checks again when it
  // moves the file into place, for a file that appears meanwhile.
  // lstat, not existsSync: a dangling symlink is still in the way.
  if (!args.force && fs.lstatSync(outPath, { throwIfNoEntry: false })) {
    stderr.write(`ERROR: ${outPath} already exists; use --force\n`);
    return 1;
  }

  const client = new NxServerClient(config.host, {
    verifyTls: !args.insecure,
    fetchImpl: deps.fetchImpl,
  });
  return inSession(client, config, stdout, stderr, async () => {
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
    return 0;
  });
}

async function runApply(
  args: CliArgs,
  deps: MainDeps,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  if (!args.yes) {
    stderr.write(
      "ERROR: Refusing to apply without --yes. This overwrites the target " +
        "device's existing Device Agent settings.\n",
    );
    return 1;
  }
  // Check the file before anything is sent, including the login.
  const body = buildApplyBody(loadSettingsFile(args.file ?? ""));

  const config = resolveOrFail(args);

  const client = new NxServerClient(config.host, {
    verifyTls: !args.insecure,
    fetchImpl: deps.fetchImpl,
  });
  return inSession(client, config, stdout, stderr, async () => {
    const errors = await client.applySettings(config.engineId, config.deviceId, body);
    const names = Object.keys(errors);
    if (names.length) {
      stderr.write("ERROR: The server took the settings but the Engine reported errors:\n");
      for (const name of names) stderr.write(`  ${name}: ${errors[name]}\n`);
      return 1;
    }
    stdout.write(
      `Applied Device Agent settings to device ${config.deviceId} (engine ${config.engineId}).\n`,
    );
    return 0;
  });
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: MainDeps = {},
): Promise<number> {
  // stdout and stderr are injectable so the tests never stub the real streams.
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  // A fresh run has no result yet (main() can be called more than once).
  resultCode = undefined;

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    // Only the error: the usage block would bury it. --help prints the usage.
    stderr.write(`ERROR: ${exc instanceof Error ? exc.message : String(exc)}\n`);
    return 2;
  }

  if (args.help) {
    stdout.write(USAGE);
    return 0;
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
    if (exc instanceof AuthError || exc instanceof ApiError) {
      stderr.write(`ERROR: ${exc.message}\n`);
      return 1;
    }
    if (isLocalFileError(exc)) {
      // --out in a missing folder, no permission, a full disk: a problem here,
      // not with the server. A failed rename names the side file as `path`
      // and the destination as `dest`; the destination is the one to report.
      const { path, dest } = exc as { path: string; dest?: string };
      stderr.write(`ERROR: could not use ${dest ?? path}: ${describeFileError(exc)}.\n`);
      return 1;
    }
    // Only the login gets here with a transport error (applySettings words
    // its own), so on apply nothing was sent.
    const notApplied = args.command === "apply" ? " The settings were not applied." : "";
    if (isTlsFailure(exc)) {
      stderr.write(`ERROR: ${CERTIFICATE_MESSAGE}${notApplied}\n`);
      return 1;
    }
    stderr.write(`ERROR: could not reach the server: ${sentence(describeError(exc))}${notApplied}\n`);
    return 1;
  }
}

// Compare real paths: run through a symlink, argv[1] is the link while
// import.meta.url is the file, and a plain === never matches.
const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // Set once main() has finished: its result is printed and stands.
  let finishedCode: number | undefined;
  main().then((code) => {
    finishedCode = code;
    process.exitCode = code;
  });
  process.once("SIGINT", async () => {
    // Read before the cleanup below: the PUT may answer while it runs.
    const outcomeUnknown = applyInFlight;
    // The result is already printed and only the final logout is left: that
    // logout is cut short, the result and its exit code stand.
    if (finishedCode === undefined && resultCode !== undefined) {
      process.stderr.write("WARNING: could not log out: interrupted.\n");
      process.exit(resultCode);
    }
    // Undo what the run in progress would have in its catch and finally:
    // end its session (given a few seconds at most).
    for (const cleanup of onInterrupt) {
      await Promise.race([
        Promise.resolve().then(cleanup).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    // The run may have finished while the cleanup ran (the call answered and
    // its result was printed): that result stands, not "Interrupted.".
    if (finishedCode !== undefined) process.exit(finishedCode);
    process.stderr.write(
      outcomeUnknown
        ? "Interrupted. Outcome unknown: the settings may have been sent. Download the device's settings to check.\n"
        : "Interrupted.\n",
    );
    process.exit(130);
  });
}
