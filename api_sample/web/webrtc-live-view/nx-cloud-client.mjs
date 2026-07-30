// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * List cameras on a SPECIFIC site using a CLOUD account — from the BROWSER.
 *
 * Browser/front-end counterpart of ../../node/rest-list-cameras-cloud-user and
 * ../../python/rest-list-cameras-cloud-user, on the latest /rest/v4 API. This
 * file holds the pure, framework-free logic so it can be (a) imported by the
 * page (app.mjs) and (b) tested offline with node:test and a fake fetch — the
 * same pattern every other sample uses.
 *
 * The token flow is identical to the Node sample:
 *
 *   1. Get a site-scoped token:
 *        POST {cloud}/cdb/oauth2/token
 *        { grant_type:password, response_type:token, client_id:3rdParty,
 *          username, password, scope:"cloudSystemId=<id>" }
 *   2. Reach the site through the Cloud relay:
 *        https://<site-id>.relay.vmsproxy.com
 *   3. List cameras:
 *        GET /rest/v4/devices   (Authorization: Bearer <site-token>)
 *   4. Delete the token on the cloud when done:
 *        DELETE {cloud}/cdb/oauth2/token/<site-token>
 *
 * WHY THE BROWSER ALWAYS GOES THROUGH THE PROXY (read the README):
 *
 *   The cloud and the relay are different origins from this page and do NOT
 *   send CORS headers for it, so the browser blocks direct calls. The included
 *   proxy.mjs serves this page AND relays the calls same-origin, so the client
 *   just uses relative paths:
 *
 *        {baseUrl}/cloud/...              -> the cloud
 *        {baseUrl}/relay/<siteId>/...   -> https://<siteId>.relay.vmsproxy.com/...
 *
 *   baseUrl defaults to "" (same origin = the proxy that served the page), so
 *   there is nothing for the user to configure. The proxy also performs the
 *   relay's 307 + bearer re-attach hop, which a browser cannot do.
 */

export const CLIENT_ID = "3rdParty";
// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

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

export class NxCloudSiteClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.siteId   Cloud Site ID (UUID) of the target site.
   * @param {string} cfg.user       Cloud account email.
   * @param {string} cfg.password
   * @param {string|null} [cfg.mfaCode]
   * @param {string} [cfg.baseUrl]  Origin that serves cloud/relay routes.
   *        Defaults to "" = same origin (the proxy that served this page).
   *        You should not need to set this.
   * @param {function} [cfg.fetchImpl] Injected for offline tests. Defaults to
   *        the global fetch (browser or Node 18+).
   */
  constructor({ siteId, user, password, mfaCode = null, baseUrl = "", fetchImpl = null }) {
    this.siteId = siteId;
    this.user = user;
    this.password = password;
    this.mfaCode = mfaCode;
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    // Default to the global fetch, but call it through a wrapper so it keeps
    // its `window`/global receiver. Calling `this.fetchImpl(...)` where
    // fetchImpl IS window.fetch throws "Can only call Window.fetch on
    // instances of Window" in browsers — the bound wrapper avoids that.
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.token = null; // The SITE-SCOPED token.
  }

  /** Same-origin route the proxy forwards to the cloud. */
  get cloudUrl() {
    return `${this.baseUrl}/cloud`;
  }

  /** Same-origin route the proxy forwards to this site's relay. */
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
      // THIS scope is what makes the token usable against the site.
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

  _authHeader() {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  async listCameras() {
    const url = `${this.relayUrl}${API}/devices`;
    let response;
    try {
      // No redirect:"manual" here — in the browser that yields an unreadable
      // opaqueredirect, and the bearer is dropped across cross-origin hops.
      // The proxy follows the relay's 307 and re-attaches the bearer for us.
      response = await this.fetchImpl(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(
        `Could not reach the site at ${url}: ${exc.message}. ` +
          "Is the dev server running? (node server.mjs) — see the README.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The site rejected the token. Make sure the Site ID is correct and " +
          "your account has access to it.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Listing devices failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Devices response was not valid JSON.");
    }
    return normalizeCameras(data);
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
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Shaping the response for the UI
// ---------------------------------------------------------------------------

/**
 * The /rest/v4/devices response is sometimes a bare array and sometimes an
 * envelope { reply: [...] }. Unwrap to a plain array, then keep just the
 * fields the table renders.
 */
export function normalizeCameras(data) {
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object" && Array.isArray(data.reply)) list = data.reply;
  return list.map((cam) => ({
    name: cam.name ?? "",
    status: cam.status ?? "",
    model: cam.model ?? "",
    id: cam.id ?? "",
  }));
}

// ---------------------------------------------------------------------------
// Config: just the three things the user types (+ optional MFA).
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
