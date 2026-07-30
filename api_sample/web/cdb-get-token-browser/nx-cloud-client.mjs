// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Get an Nx Cloud OAuth2 bearer token (and nothing else) — from the BROWSER.
 *
 * Browser/front-end counterpart of ../../node/cdb-get-token and
 * ../../python/cdb-get-token. This is the smallest possible "how do I
 * authenticate?" example: one login call, then show the token. This file holds
 * the pure, framework-free logic so it can be (a) imported by the page
 * (app.mjs) and (b) tested offline with node:test and a fake fetch — the same
 * pattern every other sample uses.
 *
 * The one call (identical to the Node/Python samples):
 *
 *   POST {cloud}/cdb/oauth2/token
 *   {
 *     grant_type:    "password",
 *     response_type: "token",
 *     client_id:     "3rdParty",
 *     username:      "<cloud email>",
 *     password:      "<cloud password>"
 *   }
 *
 *   Optional fields:
 *     mfaCode: "123456"             -> only if the account uses 2FA
 *     scope:   "cloudSystemId=<id>" -> scope the token to ONE site (omit for a
 *                                      cloud-wide token, the usual case)
 *
 * The response contains access_token (it begins with "nxcdb-") and usually
 * expires_in (lifetime in seconds). You then send the token on later requests
 * as an `Authorization: Bearer <token>` header.
 *
 * WHY THE BROWSER GOES THROUGH THE PROXY (read the README):
 *
 *   The cloud is a different origin from this page and does NOT send CORS
 *   headers for it, so the browser blocks a direct call. The included proxy.mjs
 *   serves this page AND forwards the call same-origin, so the client just uses
 *   a relative path:
 *
 *        {baseUrl}/cloud/...   -> the cloud
 *
 *   baseUrl defaults to "" (same origin = the proxy that served the page), so
 *   there is nothing for the user to configure. This sample is CLOUD-ONLY —
 *   there is no site relay and no 307 hop here.
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

export class NxCloudTokenClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.user       Cloud account email.
   * @param {string} cfg.password
   * @param {string|null} [cfg.mfaCode]   One-time 2FA code (only if enabled).
   * @param {string|null} [cfg.cloudSiteId]  Scope the token to one site (UUID).
   *        Omit for a cloud-wide token (the usual case).
   * @param {string} [cfg.baseUrl]  Origin that serves the cloud route.
   *        Defaults to "" = same origin (the proxy that served this page).
   *        You should not need to set this.
   * @param {function} [cfg.fetchImpl] Injected for offline tests. Defaults to
   *        the global fetch (browser or Node 18+).
   */
  constructor({ user, password, mfaCode = null, cloudSiteId = null, baseUrl = "", fetchImpl = null }) {
    this.user = user;
    this.password = password;
    this.mfaCode = mfaCode;
    this.cloudSiteId = cloudSiteId;
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    // Default to the global fetch, but call it through a wrapper so it keeps
    // its `window`/global receiver. Calling `this.fetchImpl(...)` where
    // fetchImpl IS window.fetch throws "Can only call Window.fetch on
    // instances of Window" in browsers — the bound wrapper avoids that.
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
  }

  /** Same-origin route the proxy forwards to the cloud. */
  get cloudUrl() {
    return `${this.baseUrl}/cloud`;
  }

  /**
   * Build the exact JSON body sent to POST /cdb/oauth2/token.
   * Kept as its own method so it is easy to read and easy to test.
   */
  buildTokenRequest() {
    const body = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
    };
    if (this.mfaCode) body.mfaCode = this.mfaCode; // only when the account uses 2FA
    // Scope the token to one site. Omit for a cloud-wide token.
    if (this.cloudSiteId) body.scope = `cloudSystemId=${this.cloudSiteId}`;
    return body;
  }

  /**
   * Perform the login and return the full token response (an object).
   * The access token itself is under the "access_token" key.
   */
  async getToken() {
    const url = `${this.cloudUrl}/cdb/oauth2/token`;
    const body = this.buildTokenRequest();

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
    if (!data.access_token) {
      throw new ApiError("Token response did not contain an access_token.");
    }
    return data;
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
// Config: just the fields the user types.
// ---------------------------------------------------------------------------

export function resolveConfig(values = {}) {
  const v = (key) => (values[key] === undefined || values[key] === null ? "" : String(values[key]).trim());
  return {
    user: v("user"),
    password: v("password"),
    mfaCode: v("mfaCode") || null,
    cloudSiteId: v("cloudSiteId") || null,
  };
}

export function missingFields(config) {
  return ["user", "password"].filter((k) => !config[k]);
}
