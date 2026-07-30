// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Log in to Nx Cloud and list your account's Sites — from the BROWSER.
 *
 * Browser/front-end counterpart of ../../node/cdb-oauth2-list-systems and
 * ../../python/cdb-oauth2-list-systems. This file holds the pure,
 * framework-free logic so it can be (a) imported by the page (app.mjs) and
 * (b) tested offline with node:test and a fake fetch — the same pattern every
 * other sample uses.
 *
 * The token flow is identical to the Node/Python samples:
 *
 *   1. Get a CLOUD-WIDE token:
 *        POST {cloud}/cdb/oauth2/token
 *        { grant_type:password, response_type:token, client_id:3rdParty,
 *          username, password }          (+ mfaCode if the account uses 2FA)
 *      NOTE: there is NO `scope` here. Listing Sites is an account-level CDB
 *      call, so a cloud-wide token is what's needed. (A site-scoped token is
 *      only for operating against ONE site — see ../rest-list-cameras-browser.)
 *   2. List your Sites:
 *        GET {cloud}/cdb/systems   (Authorization: Bearer <token>)
 *
 * TERMINOLOGY: the cloud lists "Sites". The wire endpoint is literally
 * `/cdb/systems` — that one string is the endpoint name and is kept verbatim.
 * Everywhere else (prose, identifiers) we say "site"/"Sites".
 *
 * WHY THE BROWSER ALWAYS GOES THROUGH THE PROXY (read the README):
 *
 *   The cloud is a different origin from this page and does NOT send CORS
 *   headers for it, so the browser blocks direct calls. The included proxy.mjs
 *   serves this page AND relays the calls same-origin, so the client just uses
 *   a relative path:
 *
 *        {baseUrl}/cloud/...   -> the cloud
 *
 *   baseUrl defaults to "" (same origin = the proxy that served the page), so
 *   there is nothing for the user to configure. This is a CLOUD-ONLY sample, so
 *   the proxy needs only the /cloud route (no site relay, no 307 hop).
 */

export const CLIENT_ID = "3rdParty";

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

export class NxCloudClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.user       Cloud account email.
   * @param {string} cfg.password
   * @param {string|null} [cfg.mfaCode]
   * @param {string} [cfg.baseUrl]  Origin that serves the cloud route.
   *        Defaults to "" = same origin (the proxy that served this page).
   *        You should not need to set this.
   * @param {function} [cfg.fetchImpl] Injected for offline tests. Defaults to
   *        the global fetch (browser or Node 18+).
   */
  constructor({ user, password, mfaCode = null, baseUrl = "", fetchImpl = null }) {
    this.user = user;
    this.password = password;
    this.mfaCode = mfaCode;
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    // Default to the global fetch, but call it through a wrapper so it keeps
    // its `window`/global receiver. Calling `this.fetchImpl(...)` where
    // fetchImpl IS window.fetch throws "Can only call Window.fetch on
    // instances of Window" in browsers — the bound wrapper avoids that.
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.token = null; // The CLOUD-WIDE token.
  }

  /** Same-origin route the proxy forwards to the cloud. */
  get cloudUrl() {
    return `${this.baseUrl}/cloud`;
  }

  async login() {
    const url = `${this.cloudUrl}/cdb/oauth2/token`;
    // These four fields are the documented "password grant" request body.
    // No `scope` — a cloud-wide token is needed to list the account's Sites.
    const body = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
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

  /** Return the account's Sites using the bearer token. */
  async listSites() {
    // The wire endpoint name is literally /cdb/systems — kept verbatim.
    const url = `${this.cloudUrl}/cdb/systems`;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(
        `Could not reach the API at ${url}: ${exc.message}. ` +
          "Is the dev server running? (node server.mjs) — see the README.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The cloud rejected the token. It may have expired; log in again.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Listing sites failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Sites response was not valid JSON.");
    }
    return normalizeSites(data);
  }

  /** Delete the token on the cloud. Best-effort cleanup. */
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

// Keys the CDB might use if it wraps the sites array inside an object.
const SITE_LIST_KEYS = ["sites", "systems", "reply", "results", "items", "data"];

/**
 * The /cdb/systems response is sometimes a bare array and sometimes an
 * envelope (e.g. { sites: [...] } or { reply: [...] }). Unwrap to a plain
 * array, then keep just the fields the table renders.
 */
export function normalizeSites(data) {
  const list = extractSites(data);
  return list.map((site) => ({
    name: site.name ?? "",
    status: site.stateOfHealth ?? site.status ?? "",
    version: site.version ?? "",
    id: site.id ?? "",
  }));
}

/**
 * Pull the list of sites out of the response, whatever its shape. Accepts a
 * bare array, or an object that wraps the array under a known key, falling back
 * to the first list-of-objects value found.
 */
function extractSites(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    for (const key of SITE_LIST_KEYS) {
      const value = data[key];
      if (Array.isArray(value)) return value;
      if (value && typeof value === "object") {
        const nested = extractSites(value);
        if (nested.length) return nested;
      }
    }
    for (const value of Object.values(data)) {
      if (Array.isArray(value) && (!value.length || typeof value[0] === "object")) {
        return value;
      }
    }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Config: just the things the user types (+ optional MFA).
// ---------------------------------------------------------------------------

export function resolveConfig(values = {}) {
  const v = (key) => (values[key] === undefined || values[key] === null ? "" : String(values[key]).trim());
  return {
    user: v("user"),
    password: v("password"),
    mfaCode: v("mfaCode") || null,
  };
}

export function missingFields(config) {
  return ["user", "password"].filter((k) => !config[k]);
}
