// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Play an Nx camera's live (or archive) video in an HTML5 <video> tag — from
 * the BROWSER, in BOTH auth modes: "Direct to Media Server" (connect to one
 * media server by IP:port with a LOCAL server account) or "Pull Stream via
 * Cloud Relay" (a cloud account reaching the site over the relay).
 *
 * Browser/front-end sample on the latest /rest/v4 API. As with every other web
 * sample, the pure, framework-free logic lives here so it can be (a) imported
 * by the page (app.mjs) and (b) tested offline with node:test and a fake fetch.
 * The DOM wiring is all in app.mjs.
 *
 * THE MEDIA ENDPOINT (from the v4 spec):
 *
 *   GET /rest/v4/devices/{id}/media.webm   (Authorization: Bearer <token>)
 *     ?stream=primary|secondary   hi/lo-res; we default to secondary (lighter)
 *     &positionMs=<ms>            archive start time; OMIT this for live
 *     &durationMs=<ms>           optional clip length
 *
 *   webm is the container an HTML5 <video> can play progressively for live.
 *
 * THE KEY DESIGN — authenticating a <video> tag (read the README):
 *
 *   A `<video src>` is a plain GET the browser issues; it CANNOT carry an
 *   Authorization header. So the flow is:
 *
 *     1. The page logs in THROUGH THE PROXY (a normal fetch, which CAN send/read
 *        JSON) and gets a bearer token in JS — login() below.
 *     2. The page sets <video>.src to a SAME-ORIGIN proxy URL that carries the
 *        token as a query param `auth=<token>` — buildMediaUrl() below.
 *     3. The PROXY strips `auth` off the forwarded URL and re-sends it to Nx as
 *        `Authorization: Bearer <token>`, then STREAMS the video body back.
 *
 *   So the token only ever travels SAME-ORIGIN to the local proxy; it is never
 *   sent to Nx as a URL parameter. (See proxy.mjs.)
 *
 * WHY THE BROWSER ALWAYS GOES THROUGH THE PROXY (read the README):
 *
 *   The cloud, the relay, and a local server are all different origins from this
 *   page and do NOT send CORS headers for it, so the browser blocks direct
 *   calls. A local server also presents a self-signed TLS cert the browser
 *   refuses. The included proxy.mjs serves this page AND relays calls
 *   same-origin, so the client just uses relative routes:
 *
 *        {baseUrl}/cloud/...                       -> the cloud      (cloud login)
 *        {baseUrl}/relay/<siteId>/...            -> the site relay (cloud media)
 *        {baseUrl}/server/<encoded-base>/...    -> the user's media server
 *                                                   (direct login + media)
 *
 *   baseUrl defaults to "" (same origin = the proxy that served the page). For
 *   the DIRECT mode the first /server/ path segment is the URI-encoded media
 *   server base URL (scheme+host+port) the user typed on the page, e.g.
 *   /server/https%3A%2F%2F192.168.1.10%3A7001/rest/v4/... — the proxy decodes it
 *   and forwards there. For cloud mode the proxy also performs the relay's
 *   307 + bearer re-attach hop, which a browser cannot do.
 */

export const CLIENT_ID = "3rdParty";
// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// The two auth modes this sample supports.
export const MODE_DIRECT = "direct";
export const MODE_CLOUD = "cloud";

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
// Client
// ---------------------------------------------------------------------------

export class NxMediaClient {
  /**
   * @param {object} cfg
   * @param {"direct"|"cloud"} cfg.mode   Auth mode.
   * @param {string} cfg.user       LOCAL server username (direct) / cloud email (cloud).
   * @param {string} cfg.password   LOCAL server password (direct) / cloud password (cloud).
   * @param {string} [cfg.serverAddress]  DIRECT mode only: the media server base
   *        URL the user typed on the page — scheme+host+port, e.g.
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
   * Same-origin route the proxy forwards to the user-provided media server.
   * The first path segment is the URI-encoded server base URL the user typed
   * (scheme+host+port), e.g. /server/https%3A%2F%2F192.168.1.10%3A7001. The
   * proxy decodes it and forwards there.
   */
  get serverUrl() {
    if (!this.serverAddress) {
      throw new ApiError("A server address is required for Direct to Media Server mode.");
    }
    return `${this.baseUrl}/server/${encodeURIComponent(this.serverAddress)}`;
  }

  /** The same-origin base the media URL is built on (mode-dependent). */
  get mediaBase() {
    return this.mode === MODE_CLOUD ? this.relayUrl : this.serverUrl;
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
          "use the Pull Stream via Cloud Relay mode).",
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

  // -------------------------------------------------------------------------
  // buildMediaUrl(): the same-origin <video> src the proxy will authenticate.
  // -------------------------------------------------------------------------

  /**
   * Build the SAME-ORIGIN media URL to put on <video>.src. The token rides as
   * an `auth` query param ONLY because a <video> GET can't send a header; the
   * proxy strips it and re-sends it as `Authorization: Bearer <token>` to Nx,
   * so the token never reaches Nx as a URL param. See proxy.mjs.
   *
   * @param {object} opts
   * @param {string} opts.deviceId          Camera/device id (the {id} path part).
   * @param {"primary"|"secondary"} [opts.stream]  Default "secondary".
   * @param {number|null} [opts.positionMs] Archive start in epoch ms; OMIT for live.
   * @param {number|null} [opts.durationMs] Optional clip length in ms.
   * @returns {string} e.g.
   *   /server/<encoded-base>/rest/v4/devices/<id>/media.webm?stream=...&auth=...
   */
  buildMediaUrl({ deviceId, stream = "secondary", positionMs = null, durationMs = null }) {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    if (!deviceId) throw new ApiError("A deviceId is required to build the media URL.");

    const path = `${this.mediaBase}${API}/devices/${encodeURIComponent(deviceId)}/media.webm`;
    const params = new URLSearchParams();
    params.set("stream", stream);
    // positionMs present == archive; absent == live. Treat null/"" as live.
    if (positionMs !== null && positionMs !== undefined && positionMs !== "") {
      params.set("positionMs", String(positionMs));
    }
    if (durationMs !== null && durationMs !== undefined && durationMs !== "") {
      params.set("durationMs", String(durationMs));
    }
    // The proxy will REMOVE this and turn it into an Authorization header.
    params.set("auth", this.token);
    return `${path}?${params.toString()}`;
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
// Parsing the archive position the user types (ISO time or epoch ms).
// ---------------------------------------------------------------------------

/**
 * Turn the optional "archive position" field into epoch milliseconds, or null
 * for live. Accepts an ISO 8601 string (2026-06-15T12:00:00Z) or a raw epoch-ms
 * number. Empty/blank -> null (live).
 *
 * @returns {number|null}
 */
export function parsePositionMs(value) {
  const s = value === undefined || value === null ? "" : String(value).trim();
  if (!s) return null; // live
  // All-digits -> already epoch ms.
  if (/^\d+$/.test(s)) return Number(s);
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new ApiError(`Could not parse archive position "${s}". Use ISO time or epoch ms.`);
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Config: the fields the user types. In Direct mode the user also types the
// media server address (scheme+host+port) on the page.
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
    deviceId: v("deviceId"),
    stream: v("stream") === "primary" ? "primary" : "secondary",
    position: v("position"), // raw; parsed with parsePositionMs() at play time
  };
}

/**
 * Which required fields are missing for the chosen mode. Direct needs
 * serverAddress+user+password+deviceId; cloud needs siteId+user+password+deviceId.
 */
export function missingFields(config) {
  const required =
    config.mode === MODE_CLOUD
      ? ["siteId", "user", "password", "deviceId"]
      : ["serverAddress", "user", "password", "deviceId"];
  return required.filter((k) => !config[k]);
}
