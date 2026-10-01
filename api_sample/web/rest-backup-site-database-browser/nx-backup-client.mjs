// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Back up and restore the Site database of ONE Nx VMS server, from the BROWSER.
 *
 * Browser counterpart of ../../python/rest-backup-site-database and its Node
 * and TypeScript ports. This file holds the pure, framework-free logic so it
 * can be (a) imported by the page (app.mjs) and (b) tested offline with
 * node:test and a fake fetch, the same pattern every other sample uses.
 *
 *   backup
 *   1. Log in:  POST   {base}/server/rest/v4/login/sessions -> { token }
 *   2. Dump:    GET    {base}/server/rest/v4/site/database  (Bearer)
 *   3. Log out: DELETE {base}/server/rest/v4/login/sessions/<token>
 *
 *   restore
 *   1. Log in:  POST   {base}/server/rest/v4/login/sessions
 *   2. Load:    POST   {base}/server/rest/v4/site/database
 *               (Content-Type: application/octet-stream)
 *   3. No log out. The server restarts on accepting the dump, so the session
 *      ends with it.
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
 * WHERE THE BROWSER DIFFERS FROM THE CLI VERSIONS:
 *
 *   The Python, Node and TypeScript samples stream the dump straight to disk
 *   and never hold it whole in memory. A browser cannot: saving a file means
 *   building a Blob, and a Blob is memory. This sample's proxy still streams
 *   its half, so the dump is not buffered twice, but the browser end holds the
 *   whole thing. On a large site that is tens of megabytes in a tab. The CLI
 *   versions exist precisely for that case, and the README says so.
 */

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// Everything the page calls goes through the same-origin proxy route.
export const SERVER_ROUTE = "/server";

// The dev server publishes its --server-host here (see proxy.mjs).
export const CONFIG_ROUTE = "/config.json";

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
// Telling a restart apart from a real failure
// ---------------------------------------------------------------------------

/**
 * Socket-level failures that mean "the server went away mid-request".
 *
 * A browser cannot see these. `fetch` rejects with a bare "Failed to fetch",
 * which looks identical whether the server restarted, the proxy died or the
 * network dropped. So proxy.mjs, which runs outside the browser and DOES see
 * the socket error, reports the code in this header, and the client keys off
 * it. The Node and TypeScript versions read the same codes from `cause.code`.
 */
export const UPSTREAM_ERROR_HEADER = "x-nx-upstream-error";

const DROPPED_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/**
 * Codes the proxy sends when the server took the whole upload but did not
 * answer in time: not the restart and not a refusal, so the outcome is unknown.
 */
const NO_ANSWER_CODES = new Set(["UPSTREAM_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

export function isDroppedConnection(response) {
  const code = response?.headers?.get?.(UPSTREAM_ERROR_HEADER);
  return typeof code === "string" && DROPPED_CONNECTION_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Naming the dump file
// ---------------------------------------------------------------------------

/**
 * Build a filename that says which site the dump came from, and when.
 *
 * Identical format to the CLI versions, so a dump taken in the browser sorts
 * alongside one taken from the command line. The timestamp is UTC.
 */
export function defaultOutName(host, now = new Date()) {
  // Dots and colons become dashes, and an IPv6 literal's brackets go, so the
  // name is safe on every filesystem: [fe80::1]:7001 -> fe80--1-7001.
  const where = (host || "site").split("://").pop().replace(/[.:]/g, "-").replace(/[[\]]/g, "");
  const when = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `nx-site-database-${where}-${when}.db`;
}

// ---------------------------------------------------------------------------
// Which server this page talks to
// ---------------------------------------------------------------------------

/**
 * Ask the dev server which VMS server it forwards to.
 *
 * Resolves to the address, or "" when none is configured or the dev server
 * cannot say. The page shows it, names the dump after it, and makes the
 * operator type it to confirm a restore.
 */
export async function loadServerHost({
  baseUrl = "",
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  try {
    const response = await fetchImpl(`${(baseUrl || "").replace(/\/+$/, "")}${CONFIG_ROUTE}`);
    if (!response.ok) return "";
    const data = await response.json();
    return typeof data?.serverHost === "string" ? data.serverHost.replace(/\/+$/, "") : "";
  } catch {
    return "";
  }
}

/**
 * The restore confirmation: true only when the operator typed the configured
 * address. A trailing slash and surrounding spaces are forgiven; anything else
 * is not, and with no configured address nothing confirms.
 */
export function confirmsHost(typed, serverHost) {
  const clean = (value) => (value || "").trim().replace(/\/+$/, "");
  return clean(serverHost) !== "" && clean(typed) === clean(serverHost);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxBackupClient {
  // The default wraps fetch rather than storing it: called as this.fetchImpl(),
  // a bare window.fetch gets the client as `this`, and the browser rejects it
  // with "Illegal invocation". Node's fetch does not care, so only a real
  // browser ever showed it.
  constructor({ baseUrl = "", fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.token = null;
  }

  _url(subPath) {
    return `${this.baseUrl}${SERVER_ROUTE}${API}${subPath}`;
  }

  async login(username, password) {
    const response = await this.fetchImpl(this._url("/login/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, setCookie: false }),
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login unauthorized (HTTP ${response.status}). Check the password, and ` +
          "note that a cloud account cannot log in here. It needs the OAuth2 flow.",
      );
    }
    if (!response.ok) {
      throw new ApiError(`Login failed: HTTP ${response.status}.`);
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new ApiError("Login response was not valid JSON.");
    }
    if (!data || !data.token) {
      throw new ApiError("Login response did not contain a token.");
    }

    this.token = data.token;
    return this.token;
  }

  _authHeader() {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  async backupDatabase() {
    const response = await this.fetchImpl(this._url("/site/database"), {
      headers: this._authHeader(),
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `The site refused the dump (HTTP ${response.status}). This endpoint ` +
          "needs an administrator on a fresh session.",
      );
    }

    if (!response.ok) {
      throw new ApiError(`The dump request failed (HTTP ${response.status}).`);
    }

    const blob = await response.blob();
    if (blob.size === 0) {
      throw new ApiError(
        "The server returned an empty dump. Check that the account is an " +
          "administrator and that the site has finished starting.",
      );
    }
    return blob;
  }

  /**
   * Load a dump back into the site.
   *
   * `confirmed` is the browser's answer to the CLI versions' --yes flag. It
   * lives here rather than in the page so that it is testable, and so that a
   * future page cannot forget it.
   */
  async restoreDatabase(file, { confirmed = false } = {}) {
    if (!confirmed) {
      throw new ApiError(
        "Refusing to restore without confirmation. Loading this dump replaces " +
          "the whole site configuration and restarts the server.",
      );
    }
    if (!file || file.size === 0) {
      throw new ApiError("That file is empty, so it is not a dump.");
    }

    // The File itself is the body. The browser streams it; there is no reason
    // to read it into memory first.
    const response = await this.fetchImpl(this._url("/site/database"), {
      method: "POST",
      headers: { ...this._authHeader(), "Content-Type": "application/octet-stream" },
      body: file,
    });

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `The site refused the load (HTTP ${response.status}). This endpoint ` +
          "needs an administrator on a fresh session.",
      );
    }

    if (isDroppedConnection(response)) {
      // Expected. The server restarts the moment it accepts the dump, so it
      // often cuts the connection instead of answering. The load was already
      // handed over, so this is success.
      this.token = null;
      return;
    }

    if (NO_ANSWER_CODES.has(response.headers?.get?.(UPSTREAM_ERROR_HEADER))) {
      throw new ApiError(
        "The server took the dump but gave no answer in time. It may have " +
          "loaded it and be restarting, or the load may have failed. Check the " +
          "server before restoring again.",
      );
    }

    if (!response.ok) {
      throw new ApiError(
        `The load request failed (HTTP ${response.status}). The dump was not ` +
          "applied.",
      );
    }
  }

  /** DELETE the session so the token cannot be reused. */
  async logout() {
    if (!this.token) return;
    const url = this._url(`/login/sessions/${this.token}`);
    const header = this._authHeader();
    this.token = null;
    await this.fetchImpl(url, { method: "DELETE", headers: header });
  }
}
