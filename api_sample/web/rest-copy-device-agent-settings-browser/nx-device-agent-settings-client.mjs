// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Copy one device's Device Agent (analytics plugin) settings onto another
 * device, from the BROWSER.
 *
 * This file holds the pure, framework-free logic so it can be (a) imported by
 * the page (app.mjs) and (b) tested offline with node:test and a fake fetch.
 *
 *   download
 *   1. Log in:  POST   {base}/server/rest/v4/login/sessions -> { token }
 *   2. Get:     GET    {base}/server/rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
 *   3. Log out: DELETE {base}/server/rest/v4/login/sessions/<token>
 *
 *   apply
 *   1. Log in, as above.
 *   2. Set:     PUT    {base}/server/rest/v4/analytics/engines/<engineId>/deviceAgents/<deviceId>/settings
 *               with the downloaded settings, minus deviceId, engineId and
 *               _error. The first two are identified by the URL; _error is
 *               the source device's error report, which must not be echoed
 *               back to the target. Everything else (values, model,
 *               analyzedStream, disableStreamSelection) is forwarded unchanged.
 *   3. Log out, whatever happened in step 2.
 *
 *   No request follows a redirect: a 3xx is a failure. A 2xx whose body
 *   carries a non-empty _error map means the server took the settings but the
 *   Engine rejected some of them, which is reported as a failure too.
 *
 * WHY THE BROWSER ALWAYS GOES THROUGH THE PROXY (read the README):
 *
 *   A local Nx server is a different origin from this page and does NOT send
 *   CORS headers for it, so the browser blocks direct calls. It also usually
 *   presents a self-signed TLS certificate, which the browser refuses outright.
 *   The included proxy.mjs serves this page AND relays the calls same-origin,
 *   so the client uses one relative route:
 *
 *        {baseUrl}/server/...   -> the configured VMS server
 *
 * FILES:
 *
 *   A page cannot write to an arbitrary path: download hands the settings to
 *   the browser as a file download, and apply reads them back from a file the
 *   operator chooses in the browser's file picker. Apply targets exactly one
 *   device per action.
 */

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// Everything the page calls goes through the same-origin proxy route.
export const SERVER_ROUTE = "/server";

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
 * The request never got an answer from the VMS server: the dev server could
 * not reach it, refused its certificate, had no server configured, or went
 * away itself. Raised by login and download; apply has its own rules, and
 * logout raises LogoutError.
 */
export class ConnectionError extends ApiError {
  constructor(message) {
    super(message);
    this.name = "ConnectionError";
  }
}

/**
 * Ending the session failed. `reason` is short and has no final period
 * ("HTTP 500", "no answer within 60 s", "no connection (ECONNREFUSED)"), so
 * runSession can print it as `Warning: could not log out: <reason>.`.
 */
export class LogoutError extends ApiError {
  constructor(reason) {
    super(`Could not log out: ${reason}.`);
    this.name = "LogoutError";
    this.reason = reason;
  }
}

/**
 * The settings may or may not have been applied: the operator must check.
 * The message ends at "to check."; the low-level cause, if any, is kept in
 * `detail` rather than shown, and runSession logs it with console.debug so
 * it is visible in DevTools.
 */
export class UnknownOutcomeError extends ApiError {
  constructor(detail = "") {
    super(
      "Outcome unknown: the connection was lost after the settings were sent. " +
        "Download the device's settings to check.",
    );
    this.name = "UnknownOutcomeError";
    this.detail = detail;
  }
}

/** The server took the settings, but the Engine rejected some of them. */
export class EngineReportedError extends ApiError {
  constructor(errors) {
    // A message that is not a string (an object, a number) is shown as JSON.
    const lines = Object.entries(errors).map(
      ([name, message]) => `${name}: ${typeof message === "string" ? message : JSON.stringify(message)}`,
    );
    super(["The server took the settings but the Engine reported errors:", ...lines].join("\n"));
    this.name = "EngineReportedError";
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// What the proxy's error header says about a failed request
// ---------------------------------------------------------------------------

/** Where proxy.mjs names a failure it saw itself (see proxy.mjs). */
export const UPSTREAM_ERROR_HEADER = "x-nx-upstream-error";

/** The code the proxy sends when the server took the request but said nothing for too long. */
export const UPSTREAM_TIMEOUT = "UPSTREAM_TIMEOUT";

/** Sent with UPSTREAM_TIMEOUT: how many seconds the proxy waited. */
export const UPSTREAM_TIMEOUT_SECONDS_HEADER = "x-nx-upstream-timeout-seconds";

/**
 * Codes for answers the proxy made without asking the VMS server at all:
 * no --server-host given, a request body it could not read, or a fault of
 * its own. Their status (502, 400, 500) says nothing about the VMS server,
 * so they are mapped before the status is looked at.
 */
export const NO_SERVER_HOST = "NO_SERVER_HOST";
export const BAD_REQUEST = "BAD_REQUEST";
export const PROXY_ERROR = "PROXY_ERROR";

export const NO_SERVER_HOST_MESSAGE =
  "No VMS server configured. Restart server.mjs with --server-host https://<ip>:7001.";
const BAD_REQUEST_MESSAGE = "The dev server could not read the request from the page.";
const PROXY_ERROR_MESSAGE = "The dev server failed while handling the request.";

/**
 * TLS handshake failures: the server's certificate was refused, so the
 * connection was never made. Any code naming CERT or SELF_SIGNED counts too.
 * A bare "SSL" in a code does not: ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC
 * and the like happen mid-stream, after the request may have been sent.
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
 * Codes that mean the connection to the server was never made, so nothing
 * was sent: refused, DNS, unreachable, no local address, connect timeout,
 * and every TLS failure.
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
  ...TLS_CODES,
]);

export function isTlsFailure(code) {
  return TLS_CODES.has(code) || /CERT|SELF_SIGNED/.test(code);
}

export function isNeverConnected(code) {
  return NEVER_CONNECTED_CODES.has(code) || isTlsFailure(code);
}

/**
 * What the page says when the proxy could not verify the server's
 * certificate. The page has no flag of its own: --insecure is server.mjs's.
 */
export const CERTIFICATE_MESSAGE =
  "Certificate verification failed. Local servers use a self-signed certificate, " +
  "restart server.mjs with --insecure.";

function proxyErrorCode(response) {
  const code = response?.headers?.get?.(UPSTREAM_ERROR_HEADER);
  return typeof code === "string" && code ? code : null;
}

/** "no answer within 60 s", with the seconds the proxy really waited. */
function timeoutReason(response) {
  const seconds = Number(response?.headers?.get?.(UPSTREAM_TIMEOUT_SECONDS_HEADER));
  return Number.isFinite(seconds) && seconds > 0 ? `no answer within ${seconds} s` : "no answer in time";
}

/** A low-level reason with exactly one final period: "socket hang up" -> "socket hang up.". */
function withOnePeriod(reason) {
  const text = String(reason ?? "").trim().replace(/\.+$/, "");
  return text ? `${text}.` : "";
}

/**
 * The error for an answer the proxy produced itself (it named a code in
 * x-nx-upstream-error), or null when the answer came from the VMS server.
 * Used by login and download; apply has its own rules because there a lost
 * connection may mean the settings landed, and logout uses logoutProxyReason.
 */
function proxyFailure(response) {
  const code = proxyErrorCode(response);
  if (!code) return null;
  if (code === NO_SERVER_HOST) return new ConnectionError(NO_SERVER_HOST_MESSAGE);
  if (code === BAD_REQUEST) return new ConnectionError(BAD_REQUEST_MESSAGE);
  if (code === PROXY_ERROR) return new ConnectionError(PROXY_ERROR_MESSAGE);
  if (isTlsFailure(code)) return new ConnectionError(CERTIFICATE_MESSAGE);
  if (code === UPSTREAM_TIMEOUT) return new ConnectionError(`Could not reach the server: ${timeoutReason(response)}.`);
  if (isNeverConnected(code)) return new ConnectionError(`Could not reach the server (${code}).`);
  return new ConnectionError(`The connection to the server was lost (${code}).`);
}

/**
 * The short reason for a logout answer the proxy produced itself, or null
 * when the answer came from the VMS server. Unlike proxyFailure, it never
 * says "Could not reach the server": the warning already says what failed.
 */
function logoutProxyReason(response) {
  const code = proxyErrorCode(response);
  if (!code) return null;
  if (code === NO_SERVER_HOST) return "no VMS server configured";
  if (code === BAD_REQUEST) return "the dev server could not read the request";
  if (code === PROXY_ERROR) return "the dev server failed while handling the request";
  if (isTlsFailure(code)) return `certificate verification failed (${code})`;
  if (code === UPSTREAM_TIMEOUT) return timeoutReason(response);
  if (isNeverConnected(code)) return `no connection (${code})`;
  return `connection lost (${code})`;
}

// ---------------------------------------------------------------------------
// Settings file <-> PUT body
// ---------------------------------------------------------------------------

// deviceId and engineId are read-only in the response and are not even in the
// spec's PUT request body schema: the URL identifies the device and engine,
// not the body. _error is the SOURCE device's error report; sending it to the
// target would claim errors the target never had. Everything else is
// forwarded unchanged.
const DROPPED_SETTINGS_FIELDS = new Set(["deviceId", "engineId", "_error"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a chosen settings file's text. It must be JSON, and a JSON object:
 * a list or a bare value is not a settings file. Throws ApiError naming the
 * file otherwise, so the page can refuse before it logs in.
 */
export function parseSettingsFile(text, fileName = "The settings file") {
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (exc) {
    throw new ApiError(`${fileName} is not valid JSON: ${exc.message.replace(/\.$/, "")}.`);
  }
  if (!isPlainObject(settings)) {
    throw new ApiError(`${fileName} does not hold a JSON object.`);
  }
  return settings;
}

/**
 * Drop deviceId, engineId (the URL identifies them) and _error (the source's
 * error report); forward the rest of the downloaded settings unchanged.
 *
 * A field absent from `settings` (a hand-edited or partial file) stays absent
 * from the body rather than being sent as null, so it is not mistaken for
 * "clear this setting".
 */
export function buildApplyBody(settings) {
  if (!isPlainObject(settings)) {
    throw new ApiError("The settings file does not hold a JSON object.");
  }
  const body = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!DROPPED_SETTINGS_FIELDS.has(key)) body[key] = value;
  }
  return body;
}

/**
 * Build a filename that says which device the settings came from, and when.
 *
 * The timestamp is UTC, so names sort in the order they were taken.
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
 * Render the downloaded settings as pretty-printed JSON, keys sorted, so two
 * downloads of the same settings compare equal. The page turns this string into a Blob
 * for the browser to save; this function stays pure so it is testable without
 * a DOM.
 */
export function formatSettingsFile(settings) {
  return `${JSON.stringify(sortKeysDeep(settings), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxDeviceAgentSettingsClient {
  constructor({ baseUrl = "", fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.token = null;
  }

  _url(subPath) {
    return `${this.baseUrl}${SERVER_ROUTE}${API}${subPath}`;
  }

  /**
   * Every request goes through here: nothing follows a redirect, and a fetch
   * that throws (the dev server went away) becomes an ApiError.
   */
  async _fetch(
    url,
    init,
    whenThrown = (exc) => {
      const reason = withOnePeriod(exc?.message);
      return new ConnectionError(reason ? `Could not reach the server: ${reason}` : "Could not reach the server.");
    },
  ) {
    try {
      return await this.fetchImpl(url, { ...init, redirect: "manual" });
    } catch (exc) {
      throw whenThrown(exc);
    }
  }

  async login(username, password) {
    const response = await this._fetch(this._url("/login/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, setCookie: false }),
    });
    const proxyError = proxyFailure(response);
    if (proxyError) throw proxyError;

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
      data = await response.json();
    } catch {
      throw new ApiError("Login failed: the response was not valid JSON.");
    }
    if (!isPlainObject(data) || typeof data.token !== "string" || !data.token) {
      throw new ApiError("Login failed: the response did not contain a token.");
    }

    this.token = data.token;
    return this.token;
  }

  _authHeader() {
    return { Authorization: `Bearer ${this.token}` };
  }

  _settingsUrl(engineId, deviceId) {
    return this._url(`/analytics/engines/${encodeURIComponent(engineId)}/deviceAgents/${encodeURIComponent(deviceId)}/settings`);
  }

  /**
   * GET a Device Agent's settings -> the bare settings object.
   *
   * Your account needs Power User (or better) on this site.
   */
  async downloadSettings(engineId, deviceId) {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    const response = await this._fetch(this._settingsUrl(engineId, deviceId), {
      headers: this._authHeader(),
    });
    const proxyError = proxyFailure(response);
    if (proxyError) throw proxyError;

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
      data = await response.json();
    } catch {
      data = undefined;
    }
    // Some Nx versions wrap a single-object reply in {"reply": {...}}, the
    // same way list endpoints wrap an array.
    if (isPlainObject(data) && isPlainObject(data.reply)) data = data.reply;
    if (!isPlainObject(data)) {
      throw new ApiError("Reading settings failed: the server did not return a JSON object.");
    }
    return data;
  }

  /**
   * PUT a Device Agent's settings. `body` should come from buildApplyBody().
   *
   * Refuses without `confirmed: true`, the page's stand-in for a typed
   * confirmation. The guard lives here, not in the page, so it is testable
   * and a future page cannot forget it.
   *
   * Resolves with the server's answer (or null for an empty one) when the
   * settings were applied. Throws EngineReportedError when the server took
   * them but the Engine reported errors, and UnknownOutcomeError when the
   * connection was lost after they were sent.
   */
  async applySettings(engineId, deviceId, body, { confirmed = false } = {}) {
    if (!confirmed) {
      throw new ApiError(
        "Refusing to apply without confirmation. This overwrites the target " +
          "device's existing Device Agent settings.",
      );
    }
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");

    const response = await this._fetch(
      this._settingsUrl(engineId, deviceId),
      {
        method: "PUT",
        headers: { ...this._authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      // The page could reach the dev server when it loaded; a throw here
      // means the proxy went away mid-request, possibly after forwarding it.
      (exc) => new UnknownOutcomeError(exc.message),
    );

    // An answer the proxy made itself is read by its code, before the
    // status, which is the proxy's and not the VMS server's.
    const proxyCode = proxyErrorCode(response);
    if (proxyCode) {
      const notApplied = " The settings were not applied.";
      // Nothing was forwarded: no server configured, or the body never
      // arrived whole.
      if (proxyCode === NO_SERVER_HOST) throw new ApiError(`${NO_SERVER_HOST_MESSAGE}${notApplied}`);
      if (proxyCode === BAD_REQUEST) throw new ApiError(`${BAD_REQUEST_MESSAGE}${notApplied}`);
      if (isTlsFailure(proxyCode)) throw new ApiError(`${CERTIFICATE_MESSAGE}${notApplied}`);
      if (isNeverConnected(proxyCode)) {
        throw new ApiError(`Could not reach the server (${proxyCode}).${notApplied}`);
      }
      // Dropped after connecting, no answer in time, or the proxy's own
      // fault part-way through: the PUT may have landed.
      throw new UnknownOutcomeError(proxyCode);
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Applying settings was refused (HTTP ${response.status}). This endpoint ` +
          "needs Power User or better.",
      );
    }

    if (!response.ok) {
      const failed = `Applying settings failed: ${describeStatus(response)}.`;
      // A 5xx (the VMS server's own, not the proxy's) may come after some of
      // the settings were already written.
      if (response.status >= 500) {
        throw new ApiError(
          `${failed} The server may have applied some of them; download the device's settings to check.`,
        );
      }
      const hint =
        response.status >= 400 && response.status < 500
          ? " The target device may not be running this Engine."
          : "";
      throw new ApiError(`${failed} The settings were not applied.${hint}`);
    }

    let text;
    try {
      text = await response.text();
    } catch (exc) {
      throw new UnknownOutcomeError(exc.message);
    }
    if (!text.trim()) return null;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return null; // a 2xx with a non-JSON body: applied
    }
    if (isPlainObject(data) && isPlainObject(data.reply)) data = data.reply;
    if (isPlainObject(data) && isPlainObject(data._error) && Object.keys(data._error).length > 0) {
      throw new EngineReportedError(data._error);
    }
    return data;
  }

  /**
   * DELETE the session so the token cannot be reused. Safe to call twice.
   * Throws LogoutError when the server did not confirm it; the token is
   * forgotten either way.
   */
  async logout() {
    if (!this.token) return;
    const url = this._url(`/login/sessions/${this.token}`);
    const header = this._authHeader();
    this.token = null;
    const response = await this._fetch(
      url,
      { method: "DELETE", headers: header },
      (exc) => new LogoutError(withOnePeriod(exc?.message).replace(/\.$/, "") || "the dev server did not answer"),
    );
    const proxyReason = logoutProxyReason(response);
    if (proxyReason) throw new LogoutError(proxyReason);
    if (!response.ok) throw new LogoutError(describeStatus(response));
  }
}

/** "HTTP 500", or "HTTP 302 (redirect not followed)" for a 3xx. */
function describeStatus(response) {
  // A redirect the browser itself held back (redirect "manual") is opaque:
  // type "opaqueredirect", status 0, no headers, so its real code is unknown.
  if (response.type === "opaqueredirect" || response.status === 0) {
    return "HTTP 3xx (redirect not followed)";
  }
  const { status } = response;
  if (status >= 300 && status < 400) return `HTTP ${status} (redirect not followed)`;
  return `HTTP ${status}`;
}

// ---------------------------------------------------------------------------
// One page action: log in, act, log out
// ---------------------------------------------------------------------------

/**
 * Log in, run `action(client)`, and log out whatever happened.
 *
 * `action` resolves with the success message. The result is decided only
 * after the logout. When the run has a result (the success message, or the
 * Engine-errors block), a logout failure adds a warning line to it but never
 * changes ok or replaces the message. After any other failure the logout is
 * silent: only the real error is shown.
 *
 * Pass `{ applying: true }` for an apply: a login that could not reach the
 * server then also says the settings were not applied, as nothing was sent.
 *
 * @returns {Promise<{ok: boolean, message: string}>}
 */
export async function runSession(client, { user, password }, action, { applying = false } = {}) {
  let ok = false;
  let hasResult = false;
  let loggedIn = false;
  let message;
  try {
    await client.login(user, password);
    loggedIn = true;
    message = await action(client);
    ok = true;
    hasResult = true;
  } catch (exc) {
    hasResult = exc instanceof EngineReportedError;
    // The page shows only the message; the low-level cause goes to DevTools.
    if (exc instanceof UnknownOutcomeError && exc.detail) {
      console.debug("Outcome unknown, cause:", exc.detail);
    }
    // A refused GET/PUT already names Power User in its own message.
    const notApplied = applying && !loggedIn && exc instanceof ConnectionError;
    message = `${exc.message}${notApplied ? " The settings were not applied." : ""}`;
  } finally {
    try {
      await client.logout();
    } catch (exc) {
      const reason = exc instanceof LogoutError ? `${exc.reason}.` : withOnePeriod(exc?.message);
      if (hasResult) message += `\nWarning: could not log out: ${reason}`;
    }
  }
  return { ok, message };
}
