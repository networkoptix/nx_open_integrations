// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Manage an Nx event rule's SCHEDULE from the BROWSER, in BOTH auth modes:
 * "Direct to Media Server" (connect to one server by IP:port with a LOCAL server
 * account) or "Pull via Cloud Relay" (a cloud account reaching the site over the
 * relay). The browser form of the TypeScript `rest-rule-schedule` sample.
 *
 * Browser/front-end sample on the latest /rest/v4 API. As with every other web
 * sample, the pure, framework-free logic lives here so it can be (a) imported by
 * the page (app.mjs) and (b) tested offline with node:test and a fake fetch. The
 * DOM wiring is all in app.mjs.
 *
 * THE RULE ENDPOINTS (from the v4 spec):
 *
 *   GET   /rest/v4/events/rules        -> [ Rule, ... ]    (list every rule)
 *   PATCH /rest/v4/events/rules/{id}   (partial body)      (modify one rule)
 *
 *   The schedule is a STRUCTURED ARRAY (no bit-twiddling):
 *     schedule: [ { dayOfWeek, startTime, endTime }, ... ]
 *       dayOfWeek : 1=Mon .. 7=Sun
 *       startTime : seconds since 00:00 (0..endTime)
 *       endTime   : seconds since 00:00 (startTime..86400)
 *     An EMPTY array means "always enabled".
 *
 * WHY THE BROWSER ALWAYS GOES THROUGH THE PROXY (read the README):
 *
 *   The cloud, the relay, and a local server are all different origins from this
 *   page and do NOT send CORS headers for it, so the browser blocks direct
 *   calls. A local server also presents a self-signed TLS cert the browser
 *   refuses. The browser also cannot follow the relay's cross-host 307 while
 *   keeping the Authorization header. The included proxy.mjs serves this page AND
 *   relays calls same-origin, so the client just uses relative routes:
 *
 *        {baseUrl}/cloud/...                       -> the cloud      (cloud login)
 *        {baseUrl}/relay/<siteId>/...            -> the site relay (cloud rules)
 *        {baseUrl}/server/<encoded-base>/...    -> the user's server
 *                                                   (direct login + rules)
 *
 *   baseUrl defaults to "" (same origin = the proxy that served the page). For
 *   DIRECT mode the first /server/ path segment is the URI-encoded server base
 *   URL (scheme+host+port) the user typed on the page; the proxy decodes it and
 *   forwards there. For cloud mode the proxy also performs the relay's 307 +
 *   bearer re-attach hop (re-sending the method + JSON body too), which a browser
 *   cannot do. Unlike the media sample there is no <video>/?auth trick: GET and
 *   PATCH are normal fetches that carry an Authorization header to the
 *   same-origin proxy, which forwards it upstream.
 */

export const CLIENT_ID = "3rdParty";
// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";
export const RULES_PATH = `${API}/events/rules`;

// The two auth modes this sample supports.
export const MODE_DIRECT = "direct";
export const MODE_CLOUD = "cloud";

export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_DAY = 86400;

// Schedule presets the page offers.
export const PRESETS = ["always", "weekdays", "weekend", "24x7"];

// dayOfWeek: 1=Mon .. 7=Sun.
export const DAY_NAMES = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const WEEKDAYS = [1, 2, 3, 4, 5];
export const WEEKEND = [6, 7];

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
// Schedule helpers (pure — the heart of the sample)
// ---------------------------------------------------------------------------

/**
 * Build a v4 schedule array from a preset.
 *   always  -> []                      (always enabled)
 *   24x7    -> all 7 days, full day
 *   weekdays-> Mon–Fri, startHour..endHour
 *   weekend -> Sat–Sun, startHour..endHour
 * startHour/endHour are whole hours in [0..24], startHour < endHour. They are
 * ignored for "always" and "24x7".
 */
export function buildSchedule(preset, startHour = 9, endHour = 18) {
  if (preset === "always") return [];
  if (preset === "24x7") {
    return [1, 2, 3, 4, 5, 6, 7].map((d) => ({
      dayOfWeek: d,
      startTime: 0,
      endTime: SECONDS_PER_DAY,
    }));
  }
  const s = Number(startHour);
  const e = Number(endHour);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 24 || s >= e) {
    throw new ApiError(`Invalid hours: start ${startHour} end ${endHour} (need 0 <= start < end <= 24).`);
  }
  const days = preset === "weekdays" ? WEEKDAYS : WEEKEND;
  return days.map((d) => ({
    dayOfWeek: d,
    startTime: s * SECONDS_PER_HOUR,
    endTime: e * SECONDS_PER_HOUR,
  }));
}

/**
 * Build a v4 schedule from an EXPLICIT set of days plus a time window — the
 * custom picker the page uses (the user ticks any days and chooses the hours).
 *
 *   days       array of dayOfWeek values (1=Mon .. 7=Sun); at least one.
 *   startHour  whole hour 0..24
 *   endHour    whole hour 0..24, must be greater than startHour
 *
 * Each chosen day becomes one task { dayOfWeek, startTime, endTime } where the
 * times are the hours converted to seconds (hour * 3600). Days are de-duplicated
 * and sorted Mon->Sun. For "all day", pass startHour 0 and endHour 24.
 */
export function buildScheduleFromDays(days, startHour, endHour) {
  const picked = [...new Set((days || []).map(Number))]
    .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
    .sort((a, b) => a - b);
  if (!picked.length) throw new ApiError("Pick at least one day.");
  const s = Number(startHour);
  const e = Number(endHour);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > 24 || s >= e) {
    throw new ApiError(`Invalid hours: start ${startHour} end ${endHour} (need 0 <= start < end <= 24).`);
  }
  return picked.map((d) => ({
    dayOfWeek: d,
    startTime: s * SECONDS_PER_HOUR,
    endTime: e * SECONDS_PER_HOUR,
  }));
}

function normalize(s) {
  return [...(s || [])]
    .map((t) => ({ dayOfWeek: t.dayOfWeek, startTime: t.startTime, endTime: t.endTime }))
    .sort((x, y) => x.dayOfWeek - y.dayOfWeek || x.startTime - y.startTime);
}

function hhmm(seconds) {
  const h = Math.floor(seconds / SECONDS_PER_HOUR);
  const m = Math.floor((seconds % SECONDS_PER_HOUR) / 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Human summary of a schedule for the rules table. */
export function summarizeSchedule(schedule) {
  const tasks = schedule || [];
  if (tasks.length === 0) return "always";
  return normalize(tasks)
    .map((t) => `${DAY_NAMES[t.dayOfWeek] ?? t.dayOfWeek} ${hhmm(t.startTime)}-${hhmm(t.endTime)}`)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxRuleClient {
  /**
   * @param {object} cfg
   * @param {"direct"|"cloud"} cfg.mode   Auth mode.
   * @param {string} cfg.user       LOCAL server username (direct) / cloud email (cloud).
   * @param {string} cfg.password   LOCAL server password (direct) / cloud password (cloud).
   * @param {string} [cfg.serverAddress]  DIRECT mode only: the server base URL
   *        the user typed on the page — scheme+host+port, e.g.
   *        "https://192.168.1.10:7001". The proxy forwards there.
   * @param {string} [cfg.siteId]    Cloud Site ID (UUID). Required for cloud mode.
   * @param {string|null} [cfg.mfaCode]   Cloud 2FA code (cloud mode only).
   * @param {string} [cfg.baseUrl]  Origin that serves the proxy routes.
   *        Defaults to "" = same origin (the proxy that served this page).
   *        You should not need to set this.
   * @param {function} [cfg.fetchImpl] Injected for offline tests. Defaults to
   *        the global fetch (browser or Node 18+).
   */
  constructor({ mode, user, password, serverAddress = "", siteId = "", mfaCode = null, baseUrl = "", fetchImpl = null }) {
    this.mode = mode;
    this.user = user;
    this.password = password;
    this.serverAddress = (serverAddress || "").replace(/\/+$/, "");
    this.siteId = siteId;
    this.mfaCode = mfaCode;
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    // Default to the global fetch, but call it through a wrapper so it keeps
    // its `window`/global receiver. Calling `this.fetchImpl(...)` where
    // fetchImpl IS window.fetch throws "Can only call Window.fetch on
    // instances of Window" in browsers — the bound wrapper avoids that.
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.token = null;
  }

  /** Same-origin route the proxy forwards to the cloud. */
  get cloudUrl() {
    return `${this.baseUrl}/cloud`;
  }

  /** Same-origin route the proxy forwards to this site's relay. */
  get relayUrl() {
    return `${this.baseUrl}/relay/${this.siteId}`;
  }

  /**
   * Same-origin route the proxy forwards to the user-provided server. The first
   * path segment is the URI-encoded server base URL the user typed
   * (scheme+host+port); the proxy decodes it and forwards there.
   */
  get serverUrl() {
    if (!this.serverAddress) {
      throw new ApiError("A server address is required for Direct to Media Server mode.");
    }
    return `${this.baseUrl}/server/${encodeURIComponent(this.serverAddress)}`;
  }

  /** Where rule requests go: the server directly, or the site relay. */
  get apiBase() {
    return this.mode === MODE_CLOUD ? this.relayUrl : this.serverUrl;
  }

  _authHeader() {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  // -------------------------------------------------------------------------
  // login(): get a bearer token. Two flows, one method.
  // -------------------------------------------------------------------------

  async login() {
    return this.mode === MODE_CLOUD ? this._loginCloud() : this._loginDirect();
  }

  /** Direct: POST {server}/rest/v4/login/sessions -> { token }. */
  async _loginDirect() {
    const url = `${this.serverUrl}${API}/login/sessions`;
    const body = {
      username: this.user,
      password: this.password,
      // A token (not a cookie) is what we want for a Bearer-header flow.
      setCookie: false,
    };

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(
        `Could not reach the API at ${url}: ${exc.message}. ` +
          "Is the dev server running (node server.mjs) and is the Server address " +
          "you entered correct and reachable? — see the README.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}): the server did not accept this ` +
          "username/password. Verify they're a LOCAL server account (cloud users " +
          "use the Pull via Cloud Relay mode).",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Login failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Login response was not valid JSON.");
    }
    this.token = data.token;
    if (!this.token) throw new ApiError("Login response did not contain a token.");
    return this.token;
  }

  /** Cloud: POST {cloud}/cdb/oauth2/token with cloudSystemId scope -> { access_token }. */
  async _loginCloud() {
    const url = `${this.cloudUrl}/cdb/oauth2/token`;
    const body = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
      // THIS scope is what makes the token usable against the site relay.
      scope: `cloudSystemId=${this.siteId}`,
    };
    if (this.mfaCode) body.mfaCode = this.mfaCode;

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(
        `Could not reach the API at ${url}: ${exc.message}. ` +
          "Is the dev server running? (node server.mjs) — see the README.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}): the cloud did not accept this ` +
          "email/password. Verify they're exactly what you use at the Nx Cloud " +
          "portal (nxvms.com). (2FA accounts also need an MFA code.)",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Token request failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Token response was not valid JSON.");
    }
    this.token = data.access_token;
    if (!this.token) throw new ApiError("Token response did not contain an access_token.");
    return this.token;
  }

  async _checkAuthOk(response, what) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `${what} unauthorized (HTTP ${response.status}). In cloud mode make sure the ` +
          "token was scoped with cloudSystemId for THIS site.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`${what} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
  }

  // -------------------------------------------------------------------------
  // listRules(): GET every event rule (through the proxy).
  // -------------------------------------------------------------------------

  async listRules() {
    const url = `${this.apiBase}${RULES_PATH}`;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(`Could not reach the API at ${url}: ${exc.message}.`);
    }
    await this._checkAuthOk(response, "Listing rules");
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Rules response was not valid JSON.");
    }
    // v4 may return a bare array or wrap it in { reply: [...] }.
    if (data && typeof data === "object" && Array.isArray(data.reply)) return data.reply;
    return Array.isArray(data) ? data : [];
  }

  // -------------------------------------------------------------------------
  // patchSchedule(): PATCH one rule's schedule (partial body).
  // -------------------------------------------------------------------------

  /** PATCH one rule's schedule. Returns the modified rule (if the API echoes it). */
  async patchSchedule(ruleId, schedule) {
    if (!ruleId) throw new ApiError("A rule id is required to PATCH a schedule.");
    const url = `${this.apiBase}${RULES_PATH}/${encodeURIComponent(ruleId)}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "PATCH",
        headers: { ...this._authHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ schedule }),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach the API at ${url}: ${exc.message}.`);
    }
    await this._checkAuthOk(response, "Patching rule");
    try {
      return await response.json();
    } catch {
      // Some servers answer 200 with an empty body; treat as success.
      return { id: ruleId, schedule };
    }
  }

  // -------------------------------------------------------------------------
  // logout(): revoke the token. Best-effort cleanup.
  // -------------------------------------------------------------------------

  async logout() {
    if (!this.token) return;
    const url =
      this.mode === MODE_CLOUD
        ? `${this.cloudUrl}/cdb/oauth2/token/${this.token}`
        : `${this.serverUrl}${API}/login/sessions/${this.token}`;
    try {
      await this.fetchImpl(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.token}` },
      });
    } catch {
      // best effort
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
// Config: the fields the user types. In Direct mode the user also types the
// server address (scheme+host+port) on the page.
// ---------------------------------------------------------------------------

export function resolveConfig(values = {}) {
  const v = (key) => (values[key] === undefined || values[key] === null ? "" : String(values[key]).trim());
  const mode = v("mode") === MODE_CLOUD ? MODE_CLOUD : MODE_DIRECT;
  return {
    mode,
    serverAddress: v("serverAddress"),
    user: v("user"),
    password: v("password"),
    siteId: v("siteId"),
    mfaCode: v("mfaCode") || null,
  };
}

/**
 * Which required fields are missing for the chosen mode. Direct needs
 * serverAddress+user+password; cloud needs siteId+user+password.
 */
export function missingFields(config) {
  const required =
    config.mode === MODE_CLOUD
      ? ["siteId", "user", "password"]
      : ["serverAddress", "user", "password"];
  return required.filter((k) => !config[k]);
}

/** Validate the requested preset string. */
export function normalizePreset(value) {
  const s = (value ?? "").trim().toLowerCase();
  if (PRESETS.includes(s)) return s;
  throw new ApiError(`Unknown preset "${value}". Choose one of: ${PRESETS.join(", ")}.`);
}
