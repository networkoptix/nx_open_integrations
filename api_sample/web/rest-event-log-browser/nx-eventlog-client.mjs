// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Read a site's EVENT LOG using a cloud account — from the BROWSER.
 *
 * Browser counterpart of ../../node/rest-event-log and ../../python/rest-event-log,
 * on the latest /rest/v4 API. Holds the framework-free logic so it can be (a)
 * imported by the page (app.mjs) and (b) tested offline with node:test and a
 * fake fetch — the same pattern as the other browser samples.
 *
 * Flow:
 *   1. login(): POST {cloud}/cdb/oauth2/token with scope=cloudSystemId=<siteId>
 *      -> a SITE-SCOPED bearer token.
 *   2. getEventLog(): GET <relay>/rest/v4/events/log?startTimeMs&durationMs[&...]
 *      with Authorization: Bearer <token>.
 *
 * Browser specifics (see README): the page can't reach the cloud/relay directly
 * (CORS), so it calls SAME-ORIGIN routes that the local proxy forwards:
 *      {baseUrl}/cloud/...            -> the cloud
 *      {baseUrl}/relay/<siteId>/...   -> https://<siteId>.relay.vmsproxy.com/...
 * baseUrl defaults to "" (same origin = the proxy that served the page). The
 * proxy also follows the relay's 307 and re-attaches the bearer, so here we just
 * do a normal fetch — no manual redirect handling.
 *
 * v4 event-log contract (from the OpenAPI spec):
 *   - Time window is startTimeMs + durationMs (milliseconds), NOT from/to.
 *   - eventType / actionType are LISTS (repeatable query params).
 *   - Each record: { timestampMs, eventData{}, actionData{}, aggregatedInfo{},
 *     ruleId, flags } where eventData/actionData are maps keyed by manifest names.
 */

export const CLIENT_ID = "3rdParty";
export const API = "/rest/v4";
export const EVENTS_PATH = "/rest/v4/events/log";
export const EVENTS_MANIFEST_PATH = "/rest/v4/events/manifest/events";

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
// Pure helpers (no network) — the bulk of what the tests cover.
// ---------------------------------------------------------------------------

/** Epoch-millisecond timestamp -> readable UTC string "YYYY-MM-DD HH:MM:SS". */
export function msToIso(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || Number.isNaN(n)) return String(ms);
  return new Date(n).toISOString().slice(0, 19).replace("T", " ");
}

const DURATION_RE = /^\s*(\d+(?:\.\d+)?)\s*([smhdw])\s*$/i;
const UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

/** Parse '30m', '24h', '7d', '2w' into milliseconds (unit suffix required). */
export function parseDuration(text) {
  const match = DURATION_RE.exec(text || "");
  if (!match) {
    throw new RangeError(
      `Invalid duration '${text}'. Use a number + unit (s, m, h, d, w), e.g. 30m, 24h, 7d.`,
    );
  }
  return Math.trunc(Number.parseFloat(match[1]) * UNIT_MS[match[2].toLowerCase()]);
}

/** [startMs, durationMs] for "the last <since>, ending now". */
export function windowEndingNow(nowMs, since) {
  const durationMs = parseDuration(since);
  return [nowMs - durationMs, durationMs];
}

function first(d, ...keys) {
  if (d && typeof d === "object") {
    for (const k of keys) if (d[k]) return d[k];
  }
  return "";
}

/** Flatten one v4 event-log record into a flat object for the table. */
export function normalizeEvent(record) {
  const eventData = record && typeof record === "object" ? record.eventData || {} : {};
  const actionData = record && typeof record === "object" ? record.actionData || {} : {};
  return {
    time: msToIso(record && record.timestampMs),
    eventType: first(eventData, "eventType", "type"),
    actionType: first(actionData, "actionType", "type"),
    resource: first(eventData, "caption", "resourceName", "eventResourceId", "source"),
  };
}

/** Assemble v4 query params. eventType/actionType become repeatable params. */
export function buildEventParams(startMs, durationMs, { eventType = null, actionType = null, order = "desc", limit = 50 } = {}) {
  const params = {
    startTimeMs: String(startMs),
    durationMs: String(durationMs),
    order,
    limit: String(limit),
  };
  if (eventType) params.eventType = Array.isArray(eventType) ? eventType : [eventType];
  if (actionType) params.actionType = Array.isArray(actionType) ? actionType : [actionType];
  return params;
}

/**
 * Parse the GET /rest/v4/events/manifest/events response into a sorted list of
 * { id, displayName }. The manifest is an OBJECT MAP keyed by event-type id,
 * each value carrying `id` (the identifier you pass back as `eventType`) and a
 * human-readable `displayName`. We also tolerate an array or { reply: [...] }
 * shape just in case.
 */
export function parseEventTypes(data) {
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (data && Array.isArray(data.reply)) items = data.reply;
  else if (data && typeof data === "object") items = Object.values(data);
  const out = items
    .filter((it) => it && typeof it === "object")
    .map((it) => ({
      id: it.id ?? it.eventType ?? it.name ?? "",
      displayName: it.displayName ?? it.name ?? it.id ?? "",
    }))
    .filter((t) => t.id);
  out.sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  return out;
}

/** Params object -> query string, repeating array-valued params. */
export function toQueryString(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) value.forEach((v) => usp.append(key, v));
    else usp.append(key, value);
  }
  return usp.toString();
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxEventLogClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.siteId    Cloud Site ID (UUID).
   * @param {string} cfg.user      Cloud account email.
   * @param {string} cfg.password
   * @param {string|null} [cfg.mfaCode]
   * @param {string} [cfg.baseUrl] Origin serving the cloud/relay routes.
   *        Defaults to "" = same origin (the proxy that served this page).
   * @param {function} [cfg.fetchImpl] Injected for offline tests.
   */
  constructor({ siteId, user, password, mfaCode = null, baseUrl = "", fetchImpl = null }) {
    this.siteId = siteId;
    this.user = user;
    this.password = password;
    this.mfaCode = mfaCode;
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    // Wrap so the default keeps fetch's window/global receiver (avoids the
    // "Can only call Window.fetch on instances of Window" browser error).
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.token = null;
    this.lastRaw = null;
  }

  get cloudUrl() {
    return `${this.baseUrl}/cloud`;
  }

  get relayUrl() {
    return `${this.baseUrl}/relay/${this.siteId}`;
  }

  async login() {
    const url = `${this.cloudUrl}/cdb/oauth2/token`;
    const body = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
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
          "email/password. Verify them at the Nx Cloud portal (nxvms.com). " +
          "2FA accounts need an MFA code.",
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

  /** Use a scoped bearer token obtained elsewhere (skip login). */
  useToken(token) {
    this.token = token;
  }

  /** Delete the scoped token on the cloud. Best-effort cleanup. */
  async logout() {
    if (!this.token) return;
    const url = `${this.cloudUrl}/cdb/oauth2/token/${this.token}`;
    try {
      await this.fetchImpl(url, { method: "DELETE", headers: this._authHeader() });
    } catch {
      // best effort
    } finally {
      this.token = null;
    }
  }

  _authHeader() {
    if (!this.token) throw new ApiError("Not logged in. Call login() or useToken() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * Fetch the site's event-type manifest — the authoritative list of event
   * types you can filter by. Returns [{ id, displayName }, ...] sorted by name.
   * `id` is what you pass as the `eventType` filter to getEventLog().
   */
  async getEventTypes() {
    const url = `${this.relayUrl}${EVENTS_MANIFEST_PATH}`;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(
        `Could not reach the site at ${url}: ${exc.message}. ` +
          "Is the dev server running? (node server.mjs) — see the README.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError("The site rejected the token (check the Site ID and your access).");
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Reading the event manifest failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Event manifest response was not valid JSON.");
    }
    return parseEventTypes(data);
  }

  /**
   * Read the event log for a time window.
   * @param {number} startMs  Window start (epoch ms).
   * @param {number} durationMs  Window length (ms).
   * @param {object} [opts]  { eventType, actionType, order, limit }
   * @returns {Promise<Array>}  Normalized events (newest first by default).
   */
  async getEventLog(startMs, durationMs, opts = {}) {
    const query = toQueryString(buildEventParams(startMs, durationMs, opts));
    const url = `${this.relayUrl}${EVENTS_PATH}?${query}`;
    let response;
    try {
      // No redirect:"manual" — the proxy follows the relay's 307 server-side.
      response = await this.fetchImpl(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(
        `Could not reach the site at ${url}: ${exc.message}. ` +
          "Is the dev server running? (node server.mjs) — see the README.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The site rejected the token. Make sure the Site ID is correct and your account has access to it.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Reading events failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Events response was not valid JSON.");
    }
    this.lastRaw = data;
    const records = Array.isArray(data) ? data : Array.isArray(data && data.reply) ? data.reply : [];
    return records.map((r) => normalizeEvent(r));
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
// Config: the fields the user types (+ optional MFA).
// ---------------------------------------------------------------------------

export function resolveConfig(values = {}) {
  const v = (key) => (values[key] === undefined || values[key] === null ? "" : String(values[key]).trim());
  return {
    siteId: v("siteId"),
    user: v("user"),
    password: v("password"),
    mfaCode: v("mfaCode") || null,
  };
}

export function missingFields(config) {
  return ["siteId", "user", "password"].filter((k) => !config[k]);
}
