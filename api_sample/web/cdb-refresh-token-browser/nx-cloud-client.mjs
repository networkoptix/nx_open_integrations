// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Keep a token-based Nx Cloud session alive with REFRESH TOKENS — from the
 * BROWSER. No password is re-sent after the first login.
 *
 * Browser/front-end counterpart of ../../node/cdb-refresh-token and
 * ../../python/cdb-refresh-token. This file holds the pure, framework-free
 * logic so it can be (a) imported by the page (app.mjs) and (b) tested offline
 * with node:test and a fake fetch — the same pattern every other sample uses.
 *
 * THE IDEA (read this if you are new to token auth)
 * -------------------------------------------------
 * With token-based auth you do NOT send your password on every request:
 *
 *   * You log in once and receive two things:
 *       - an ACCESS token  -> short-lived. Sent on every API call as
 *                             "Authorization: Bearer <access token>".
 *       - a REFRESH token  -> long-lived. Used ONLY to get new access tokens.
 *   * When the access token is about to expire, you call the token endpoint
 *     again with grant_type=refresh_token to get a fresh access token — NO
 *     password.
 *   * Some servers ROTATE the refresh token: the refresh response carries a NEW
 *     refresh token and the old one stops working. You must store the new one.
 *
 * So "the session" is really {access_token, refresh_token, expiry}. The
 * TokenSession class below wraps that state and shows the three things you do
 * to keep it healthy:
 *
 *   1. PROACTIVE refresh  - refresh shortly BEFORE the access token expires.
 *   2. REACTIVE refresh   - if a call still returns 401, refresh once and retry.
 *   3. ROTATION + STORAGE - always keep the latest refresh token, and persist
 *                           it so a reload can resume the session.
 *
 * The calls:
 *
 *   Login:    POST {cloud}/cdb/oauth2/token
 *             { grant_type:"password", response_type:"token",
 *               client_id:"3rdParty", username, password }
 *   Refresh:  POST {cloud}/cdb/oauth2/token
 *             { grant_type:"refresh_token", response_type:"token",
 *               client_id:"3rdParty", refresh_token:"<latest refresh token>" }
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
 *   there is nothing for the user to configure.
 *
 *   SECURITY CAVEAT (read the README): this sample persists the tokens in the
 *   browser's sessionStorage purely to demonstrate resuming + refreshing a
 *   session across a reload. Tokens in the browser are exposed to XSS. A real
 *   app should prefer short-lived in-memory tokens plus an httpOnly-cookie /
 *   backend pattern. See the README's "Security" section.
 */

export const CLIENT_ID = "3rdParty";
// If the server doesn't tell us a lifetime, assume this many seconds.
export const DEFAULT_EXPIRES_IN_S = 3600;
// Refresh this many seconds BEFORE the access token actually expires, so we
// never hand a request a token that dies mid-flight.
export const REFRESH_SAFETY_MARGIN_S = 60;
// Key under which the session is stored in sessionStorage.
export const STORAGE_KEY = "nx.cdb.session";

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
// Request bodies (own functions so the exact payloads are easy to read/test)
// ---------------------------------------------------------------------------

export function buildPasswordRequest(user, password, mfaCode = null) {
  const body = {
    grant_type: "password",
    response_type: "token",
    client_id: CLIENT_ID,
    username: user,
    password,
  };
  if (mfaCode) body.mfaCode = mfaCode;
  return body;
}

export function buildRefreshRequest(refreshToken) {
  return {
    grant_type: "refresh_token",
    response_type: "token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  };
}

// ---------------------------------------------------------------------------
// Storage: a thin, feature-detecting wrapper around sessionStorage.
// ---------------------------------------------------------------------------

/**
 * Resolve a storage backend. In the browser this is sessionStorage; under
 * node:test there is no sessionStorage, so we fall back to a no-op (and tests
 * can inject their own simple object). This keeps the client testable offline.
 *
 * @param {object|null} injected A Storage-like object ({getItem,setItem,
 *        removeItem}). Pass one in tests; omit it in the browser.
 */
export function resolveStorage(injected = null) {
  if (injected) return injected;
  if (globalThis.sessionStorage) return globalThis.sessionStorage;
  // No real storage available (e.g. node:test). A null-object keeps every
  // call safe and turns persistence into a no-op without scattering guards.
  return {
    getItem() {
      return null;
    },
    setItem() {},
    removeItem() {},
  };
}

// ---------------------------------------------------------------------------
// The session: holds the tokens and the logic to keep them valid
// ---------------------------------------------------------------------------

export class TokenSession {
  /**
   * @param {object} cfg
   * @param {string} [cfg.baseUrl]  Origin that serves the /cloud route.
   *        Defaults to "" = same origin (the proxy that served this page).
   *        You should not need to set this.
   * @param {function} [cfg.fetchImpl] Injected for offline tests. Defaults to
   *        the global fetch (browser or Node 18+).
   * @param {object|null} [cfg.storage] Storage-like object. Defaults to
   *        sessionStorage in the browser, a no-op under node:test.
   * @param {function} [cfg.timeFn]  Returns epoch seconds. Injectable so
   *        expiry is testable without a real clock.
   */
  constructor({ baseUrl = "", fetchImpl = null, storage = null, timeFn = null } = {}) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    // Default to the global fetch, but call it through a wrapper so it keeps
    // its `window`/global receiver. Calling `this.fetchImpl(...)` where
    // fetchImpl IS window.fetch throws "Can only call Window.fetch on
    // instances of Window" in browsers — the bound wrapper avoids that.
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.storage = resolveStorage(storage);
    this.timeFn = timeFn || (() => Date.now() / 1000);

    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0; // epoch seconds when the access token expires
    this.lastRaw = null; // raw JSON of the last token response

    // Try to resume a saved session so a reload doesn't need the password.
    this._load();
  }

  /** Same-origin route the proxy forwards to the cloud. */
  get cloudUrl() {
    return `${this.baseUrl}/cloud`;
  }

  // -- persistence -------------------------------------------------------

  /** Load a previously saved session from storage (best-effort). */
  _load() {
    let saved;
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return;
      saved = JSON.parse(raw);
    } catch {
      return; // no / invalid store yet -> start fresh
    }
    this.accessToken = saved.accessToken || null;
    this.refreshToken = saved.refreshToken || null;
    this.expiresAt = Number(saved.expiresAt) || 0;
  }

  /** Persist the current session so a reload can resume + refresh it. */
  _save() {
    try {
      this.storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken,
          expiresAt: this.expiresAt,
        }),
      );
    } catch {
      // best effort — storage may be full or unavailable
    }
  }

  /** Forget the session (memory + storage). */
  clear() {
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = 0;
    this.lastRaw = null;
    try {
      this.storage.removeItem(STORAGE_KEY);
    } catch {
      // best effort
    }
  }

  /** True if a resumable session (at least a refresh token) is loaded. */
  hasSession() {
    return Boolean(this.refreshToken || this.accessToken);
  }

  // -- core http ---------------------------------------------------------

  async _postToken(body, what) {
    const url = `${this.cloudUrl}/cdb/oauth2/token`;
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
        `${what} rejected (HTTP ${response.status}). Check credentials / refresh ` +
          "token; 2FA accounts also need an MFA code.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`${what} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError(`${what}: response was not valid JSON.`);
    }
    if (!data.access_token) {
      throw new ApiError(`${what}: response did not contain an access_token.`);
    }
    return data;
  }

  /**
   * Update session state from a token response, then persist it.
   *
   * This is where ROTATION happens: if the response carries a new refresh
   * token we adopt it, because the previous one may now be invalid.
   */
  _absorb(data) {
    this.lastRaw = data;
    this.accessToken = data.access_token;
    const expiresIn = Number(data.expires_in) || DEFAULT_EXPIRES_IN_S;
    this.expiresAt = this.timeFn() + expiresIn;
    if (data.refresh_token) this.refreshToken = data.refresh_token; // keep latest
    this._save();
  }

  // -- public api --------------------------------------------------------

  /** First login with the password. Returns the raw token response. */
  async login(user, password, mfaCode = null) {
    const data = await this._postToken(buildPasswordRequest(user, password, mfaCode), "Login");
    this._absorb(data);
    return data;
  }

  /** Exchange the stored refresh token for a fresh access token (no password). */
  async refresh() {
    if (!this.refreshToken) {
      throw new ApiError("No refresh token available. Log in first.");
    }
    const data = await this._postToken(buildRefreshRequest(this.refreshToken), "Refresh");
    this._absorb(data);
    return data;
  }

  secondsUntilExpiry() {
    return this.expiresAt - this.timeFn();
  }

  /** True if the access token is gone or within `margin` of expiry. */
  isExpiring(margin = REFRESH_SAFETY_MARGIN_S) {
    return this.secondsUntilExpiry() <= margin;
  }

  /**
   * PROACTIVE refresh: get a usable access token, refreshing if needed.
   *
   * Call this right before you make an API request. It refreshes only when the
   * token is missing or about to expire, so it is cheap to call often.
   */
  async ensureValid() {
    if (!this.accessToken && !this.refreshToken) {
      throw new ApiError("No session yet. Call login() first.");
    }
    if (this.isExpiring()) await this.refresh();
    return this.accessToken;
  }

  authHeader() {
    return { Authorization: `Bearer ${this.accessToken}` };
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
// Display helpers (used by the page; kept here so they're unit-testable)
// ---------------------------------------------------------------------------

/** Truncate a token for display — never show it in full. */
export function shortToken(token) {
  if (!token) return "";
  return token.length > 27 ? `${token.slice(0, 24)}...` : token;
}

/** Round seconds for a friendly "~Ns to expiry" readout. */
export function formatExpiry(seconds) {
  const s = Math.round(seconds);
  if (s <= 0) return "expired";
  if (s < 120) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

// ---------------------------------------------------------------------------
// Config: just the three things the user types (+ optional MFA).
// ---------------------------------------------------------------------------

export function resolveConfig(values = {}) {
  const v = (key) =>
    values[key] === undefined || values[key] === null ? "" : String(values[key]).trim();
  return {
    user: v("user"),
    password: v("password"),
    mfaCode: v("mfaCode") || null,
  };
}

export function missingFields(config) {
  return ["user", "password"].filter((k) => !config[k]);
}
