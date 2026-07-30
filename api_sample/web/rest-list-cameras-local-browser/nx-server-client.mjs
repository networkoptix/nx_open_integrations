// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Log in to ONE Nx VMS server and list its cameras — from the BROWSER.
 *
 * Browser/front-end counterpart of ../../node/rest-list-cameras and
 * ../../python/rest-list-cameras, on the latest /rest/v4 API. This is the
 * DIRECT-to-a-single-server variant: it talks to one configured VMS server
 * (not the cloud, no relay). This file holds the pure, framework-free logic so
 * it can be (a) imported by the page (app.mjs) and (b) tested offline with
 * node:test and a fake fetch — the same pattern every other sample uses.
 *
 * The token flow is identical to the Node/Python sample:
 *
 *   1. Log in:    POST {server}/rest/v4/login/sessions
 *                   { username, password, setCookie:false }  -> { token }
 *   2. List:      GET  {server}/rest/v4/devices   (Authorization: Bearer <token>)
 *   3. Log out:   DELETE {server}/rest/v4/login/sessions/<token>  (best-effort)
 *
 * WHY THE BROWSER ALWAYS GOES THROUGH THE PROXY (read the README):
 *
 *   A local Nx server is a different origin from this page and does NOT send
 *   CORS headers for it, so the browser blocks direct calls. It also usually
 *   presents a self-signed TLS certificate, which the browser refuses outright.
 *   The included proxy.mjs serves this page AND relays the calls same-origin
 *   (and can accept the self-signed cert with --insecure), so the client just
 *   uses one relative route:
 *
 *        {baseUrl}/server/...   -> the configured VMS server
 *
 *   baseUrl defaults to "" (same origin = the proxy that served the page), so
 *   there is nothing for the user to configure. The server's address is set on
 *   the proxy at start time (server.mjs --server-host ...), not on the page.
 */

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

export class NxServerClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.user       Local server username.
   * @param {string} cfg.password
   * @param {string} [cfg.baseUrl]  Origin that serves the /server route.
   *        Defaults to "" = same origin (the proxy that served this page).
   *        You should not need to set this.
   * @param {function} [cfg.fetchImpl] Injected for offline tests. Defaults to
   *        the global fetch (browser or Node 18+).
   */
  constructor({ user, password, baseUrl = "", fetchImpl = null }) {
    this.user = user;
    this.password = password;
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    // Default to the global fetch, but call it through a wrapper so it keeps
    // its `window`/global receiver. Calling `this.fetchImpl(...)` where
    // fetchImpl IS window.fetch throws "Can only call Window.fetch on
    // instances of Window" in browsers — the bound wrapper avoids that.
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.token = null;
  }

  /** Same-origin route the proxy forwards to the configured VMS server. */
  get serverUrl() {
    return `${this.baseUrl}/server`;
  }

  async login() {
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
          "Is the dev server running? (node server.mjs --server-host ...) — see the README.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}): the server did not accept this ` +
          "username/password. Verify they're a LOCAL server account (cloud users " +
          "use a different login flow).",
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

  _authHeader() {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  async listCameras() {
    const url = `${this.serverUrl}${API}/devices`;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(
        `Could not reach the server at ${url}: ${exc.message}. ` +
          "Is the dev server running? (node server.mjs --server-host ...) — see the README.",
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        "The server rejected the token. Make sure the account has permission to " +
          "view the cameras on this site.",
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

  /** Delete the session token on the server. Best-effort cleanup. */
  async logout() {
    if (!this.token) return;
    const url = `${this.serverUrl}${API}/login/sessions/${this.token}`;
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
// Config: just the two things the user types. The server host is set on the
// proxy at start time, never on the page.
// ---------------------------------------------------------------------------

export function resolveConfig(values = {}) {
  const v = (key) => (values[key] === undefined || values[key] === null ? "" : String(values[key]).trim());
  return {
    user: v("user"),
    password: v("password"),
  };
}

export function missingFields(config) {
  return ["user", "password"].filter((k) => !config[k]);
}
