// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * The login session lifecycle on ONE Nx mediaserver — from the BROWSER.
 *
 * Browser counterpart of ../../python/rest-get-token (and the Node/TypeScript
 * ports), on the latest /rest/v4 API. This is the DIRECT-to-a-single-server
 * variant: one configured mediaserver, no cloud, no relay.
 *
 * This file holds the pure, framework-free logic so it can be (a) imported by
 * the page (app.mjs) and (b) tested offline with node:test and a fake fetch —
 * the same pattern every other sample uses.
 *
 * The four steps, identical to the CLI ports:
 *
 *   1. Log in:   POST   {server}/rest/v4/login/sessions
 *                  { username, password, setCookie:false }
 *                  -> { id, username, token, ageS, expiresInS }
 *   2. Use it:   GET    {server}/rest/v4/login/sessions/current
 *                  (Authorization: Bearer <token>)
 *   3. Log out:  DELETE {server}/rest/v4/login/sessions/current
 *   4. Re-check: GET    {server}/rest/v4/login/sessions/current  -> now 401.
 *
 * Step 4 is the point of the sample: it makes logout visible instead of
 * something you take on faith.
 *
 * WHY THE BROWSER ALWAYS GOES THROUGH THE PROXY (read the README):
 *
 *   A local Nx mediaserver is a different origin from this page and does NOT
 *   send CORS headers for it, so the browser blocks direct calls. It also
 *   usually presents a self-signed TLS certificate, which the browser refuses
 *   outright. The included proxy.mjs serves this page AND relays the calls
 *   same-origin (and can accept the self-signed cert with --insecure), so the
 *   client just uses one relative route:
 *
 *        {baseUrl}/server/...   -> the configured mediaserver
 *
 *   baseUrl defaults to "" (same origin = the proxy that served the page), so
 *   there is nothing for the user to configure. The server's address is set on
 *   the proxy at start time (server.mjs --server-host ...), not on the page.
 *
 *   Be honest about what that means: the page composes the Authorization
 *   header, but it is the PROXY that puts it on the wire to the mediaserver.
 *   The header still travels; it just takes one extra same-origin hop first.
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

export class NxLoginClient {
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

  /** Same-origin route the proxy forwards to the configured mediaserver. */
  get serverUrl() {
    return `${this.baseUrl}/server`;
  }

  /** Build the bearer header. This is the ONLY place the token is used. */
  _authHeader(token = null) {
    const value = token || this.token;
    if (!value) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${value}` };
  }

  // -- step 1: get a token ---------------------------------------------------

  /**
   * POST credentials, receive a session (incl. its token), remember it.
   *
   * Returns the whole session object, not just the token, because the other
   * fields are the interesting part: `expiresInS` is how long you have.
   */
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
    return data;
  }

  // -- step 2: use the token -------------------------------------------------

  /**
   * GET the session that the bearer token in our header belongs to.
   *
   * The path literal "current" (the v4 API also accepts "-") means "whatever
   * token is in the Authorization header", so the request needs no token in
   * the path.
   *
   * A successful call here is the proof that the token works: the server only
   * answers if it recognises the token we sent.
   */
  async getCurrentSession() {
    const url = `${this.serverUrl}${API}/login/sessions/current`;
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
      throw new AuthError("The server rejected the token.");
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(
        `Reading the current session failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError("Session response was not valid JSON.");
    }
  }

  // -- step 4: confirm the token really is dead ------------------------------

  /**
   * Probe the session endpoint with `token` and report whether it is live.
   *
   * Unlike getCurrentSession() this NEVER throws on a rejection: after logout a
   * 401 is the expected, correct answer, not a failure. Returns
   * {isLive, status}; status is null if the request never landed.
   */
  async tokenStillWorks(token) {
    const url = `${this.serverUrl}${API}/login/sessions/current`;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: this._authHeader(token) });
    } catch {
      // Can't reach the server, so we can't say. Report "not live".
      return { isLive: false, status: null };
    }
    return { isLive: response.ok, status: response.status };
  }

  // -- step 3: give the token back -------------------------------------------

  /**
   * DELETE the session so the token cannot be reused.
   *
   * Best-effort by design: cleanup failing should never break the page.
   * Returns true if the server confirmed it. Clears the token either way.
   */
  async logout() {
    if (!this.token) return false;
    // Address the session with the "current" sentinel; the server takes the
    // token from the Authorization header.
    const url = `${this.serverUrl}${API}/login/sessions/current`;
    try {
      const response = await this.fetchImpl(url, {
        method: "DELETE",
        headers: this._authHeader(),
      });
      return Boolean(response && response.ok);
    } catch {
      return false;
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
// Shaping the session for the UI
// ---------------------------------------------------------------------------

/**
 * Flatten a session into label/value rows the page renders.
 *
 * ageS / expiresInS are seconds, per the v4 spec field names, and are omitted
 * when the server did not send them.
 */
export function sessionRows(session = {}) {
  const rows = [
    ["Token", String(session.token ?? "")],
    ["Session id", String(session.id ?? "")],
    ["Username", String(session.username ?? "")],
  ];
  if (session.ageS !== undefined && session.ageS !== null) {
    rows.push(["Age", `${session.ageS} seconds`]);
  }
  if (session.expiresInS !== undefined && session.expiresInS !== null) {
    rows.push(["Expires in", `${session.expiresInS} seconds`]);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Config: just the two things the user types. The server host is set on the
// proxy at start time, never on the page.
// ---------------------------------------------------------------------------

export function resolveConfig(values = {}) {
  const v = (key) =>
    values[key] === undefined || values[key] === null ? "" : String(values[key]).trim();
  return {
    user: v("user"),
    password: v("password"),
  };
}

export function missingFields(config) {
  return ["user", "password"].filter((k) => !config[k]);
}
