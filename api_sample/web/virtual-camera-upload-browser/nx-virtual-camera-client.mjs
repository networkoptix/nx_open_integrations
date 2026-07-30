// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Create a VIRTUAL camera on ONE Nx VMS server and UPLOAD a local video file
 * into its archive as recorded footage — from the BROWSER.
 *
 * Browser/front-end counterpart of ../../python/virtual-camera-upload. A
 * virtual camera has no real RTSP source; you push it pre-recorded media and
 * the server ingests it as if it had been captured at the given start time.
 *
 * This file holds the pure, framework-free API logic so it can be (a) imported
 * by the page (app.mjs) and (b) unit-tested offline with node:test and a fake
 * fetch — the same pattern every other web sample uses. The DOM lives in
 * app.mjs; the dev proxy (CORS + self-signed TLS) lives in proxy.mjs/server.mjs.
 *
 * THE CORRECTED v4 VIRTUAL-CAMERA UPLOAD FLOW (matches the Python source):
 *
 *   1. Log in:    POST   {server}/rest/v4/login/sessions
 *                   { username, password, setCookie:false }   -> { token }
 *   2. Create:    POST   {server}/rest/v4/devices/(asterisk)/virtual  { name }
 *                   -> the new device (read its "id")        [skip with deviceId]
 *   3. Lock:      PATCH  {server}/rest/v4/devices/{id}/virtual/lock  { ttlMs }
 *                   -> token at lockInfo.token (defensive: also top-level)
 *   4. Create upload: POST {server}/rest/v4/devices/{id}/virtual/uploads
 *                   { items: [{ filename, sizeB, md5, startTimeMs, chunkSizeB }] }
 *                   -> server chunkSizeB + uploadId (startTimeMs declared HERE;
 *                      durationMs is OPTIONAL — the server derives duration from
 *                      the file's own metadata when it is omitted)
 *   5. Upload bytes:  PUT  {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=<n>
 *                   raw chunk bytes, Content-Type: application/octet-stream
 *   6. Status:    GET    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}
 *                   -> import auto-starts once all chunks arrive; this reports it.
 *                   (PATCH .../virtual/consume is DEPRECATED — NOT used.)
 *   7. Release:   PATCH  {server}/rest/v4/devices/{id}/virtual/release  { token }
 *                   (always run, even on error, so the lock is freed)
 *   + Log out:    DELETE {server}/rest/v4/login/sessions/<token>  (best-effort)
 *
 * The `(asterisk)` in step 2 is the current-server wildcard — part of the path, not a
 * placeholder. The uploadId in steps 5/6 is the server-returned uploadId, or
 * the file's name if none is echoed.
 *
 * WHY EVERY CALL GOES THROUGH THE PROXY (read the README):
 *   A local Nx server is a different origin and sends no CORS headers, and it
 *   usually presents a self-signed TLS cert the browser refuses. The included
 *   proxy.mjs serves this page AND relays calls same-origin (accepting the cert
 *   when --insecure), so the client only ever uses one relative route:
 *
 *        {baseUrl}/server/<encodeURIComponent(serverBaseUrl)>/...
 *
 *   The user types the server address (https://ip:port) on the page; we encode
 *   it into the /server/<base> segment, and the proxy forwards there.
 */

import { md5Base64 } from "./md5.mjs";

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// Defaults: lock time-to-live and the requested upload chunk size.
export const DEFAULT_TTL_MS = 300 * 1000; // 5 minutes
export const DEFAULT_CHUNK_SIZE_B = 1024 * 1024; // 1 MiB

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
// Pure helpers (no network = easy to test)
// ---------------------------------------------------------------------------

/**
 * Turn a datetime-local / ISO string / epoch-ms value into epoch milliseconds.
 * Empty/blank -> "now". A bare number string is treated as already epoch ms.
 */
export function parseStartTimeMs(value, now = null) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (!text) return (now instanceof Date ? now : new Date()).getTime();
  if (/^\d+$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new ApiError(`Could not parse start time "${text}". Use an ISO time or epoch ms.`);
  }
  return ms;
}

/**
 * Plan how a file of `totalSize` bytes splits into `chunkSize` pieces.
 * Returns [{ index, offset, length }], zero-based; the last piece holds the
 * remainder. A zero-byte file yields a single empty chunk so the server still
 * sees one PUT.
 */
export function chunkPlan(totalSize, chunkSize) {
  if (!(chunkSize > 0)) throw new ApiError("chunk size must be a positive number of bytes.");
  if (!(totalSize > 0)) return [{ index: 0, offset: 0, length: 0 }];
  const plan = [];
  let index = 0;
  let offset = 0;
  while (offset < totalSize) {
    const length = Math.min(chunkSize, totalSize - offset);
    plan.push({ index, offset, length });
    index += 1;
    offset += length;
  }
  return plan;
}

/** Base64 MD5 of file bytes (ArrayBuffer/Uint8Array). Web Crypto lacks MD5. */
export function md5OfBytes(bytes) {
  return md5Base64(bytes);
}

/**
 * Build the { items: [...] } body for create-upload.
 * startTimeMs is declared HERE (not at a separate consume step). The modern v4
 * flow drops the deprecated `.../virtual/consume` call and starts the import
 * automatically once all chunks arrive.
 *
 * durationMs is OPTIONAL: when known, the server uses it to reserve the
 * archive period; when omitted, the server tries to derive the duration from
 * the video file's own metadata. If that metadata is missing or unreadable and
 * no durationMs was sent, the archive period comes back as zero and the
 * footage will not appear on the timeline (see the README's troubleshooting
 * section), so provide a duration if you know the clip length.
 */
export function buildItemsPayload(filename, sizeB, md5B64, startTimeMs, chunkSizeB, durationMs = null) {
  const item = {
    filename,
    sizeB,
    md5: md5B64,
    startTimeMs,
    chunkSizeB,
  };
  if (durationMs !== null && durationMs !== undefined && durationMs > 0) {
    item.durationMs = durationMs;
  }
  return { items: [item] };
}

function unwrap(data) {
  if (data && typeof data === "object" && "reply" in data) return data.reply;
  return data;
}

/** Pull the new device id from a create-virtual response, defensively. */
export function parseDeviceId(data) {
  let d = unwrap(data);
  if (Array.isArray(d)) d = d.length ? d[0] : {};
  if (d && typeof d === "object" && d.id) return d.id;
  throw new ApiError("Create-virtual response did not contain a device id.");
}

/**
 * Pull the lock token from a lock response, defensively. The v4 reply is shaped
 * { id, lockInfo: { token, ... } } — token lives under lockInfo. Older/edge
 * shapes may put it at the top level, so we check both.
 */
export function parseLockToken(data) {
  const d = unwrap(data);
  if (d && typeof d === "object") {
    if (d.lockInfo && typeof d.lockInfo === "object" && d.lockInfo.token) {
      return d.lockInfo.token;
    }
    if (d.token) return d.token;
  }
  throw new ApiError("Lock response did not contain a token.");
}

/**
 * Read the create-upload reply -> { uploadId, chunkSizeB }, defensively.
 * Uses the server's returned chunkSizeB/uploadId when present, else the
 * requested chunk size / the filename fallback.
 */
export function parseUploadItem(data, requestedChunkSize, fallbackUploadId) {
  const d = unwrap(data);
  let items;
  if (d && typeof d === "object" && Array.isArray(d.items)) items = d.items;
  else if (Array.isArray(d)) items = d;
  else if (d && typeof d === "object") items = [d];
  else items = [];
  let item = items.length ? items[0] : {};
  if (!item || typeof item !== "object") item = {};

  const uploadId = item.uploadId || fallbackUploadId;
  let chunkSizeB = item.chunkSizeB || requestedChunkSize;
  chunkSizeB = Number(chunkSizeB);
  if (!Number.isFinite(chunkSizeB) || chunkSizeB <= 0) chunkSizeB = requestedChunkSize;
  return { uploadId, chunkSizeB };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxVirtualCameraClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.user        Local server username.
   * @param {string} cfg.password
   * @param {string} cfg.serverHost  The VMS server address, e.g.
   *        https://192.168.1.10:7001. Encoded into the /server/<base> route.
   * @param {string} [cfg.baseUrl]   Origin serving the /server route. Defaults
   *        to "" = same origin (the proxy that served this page).
   * @param {function} [cfg.fetchImpl] Injected for offline tests. Defaults to a
   *        wrapper over the global fetch (preserves its window/global receiver).
   */
  constructor({ user, password, serverHost = "", baseUrl = "", fetchImpl = null }) {
    this.user = user;
    this.password = password;
    this.serverHost = (serverHost || "").replace(/\/+$/, "");
    this.baseUrl = (baseUrl || "").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.token = null;
  }

  /**
   * Same-origin route the proxy forwards to the user-typed VMS server. The
   * server's address is URL-encoded into a single path segment so one proxy can
   * serve any direct server the user enters on the page.
   */
  get serverUrl() {
    return `${this.baseUrl}/server/${encodeURIComponent(this.serverHost)}`;
  }

  _authHeader(extra = null) {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    const headers = { Authorization: `Bearer ${this.token}` };
    if (extra) Object.assign(headers, extra);
    return headers;
  }

  async _check(response, what) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `${what} unauthorized (HTTP ${response.status}). Check the username/password, ` +
          "and that this is a LOCAL (not cloud) server account.",
      );
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`${what} failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    try {
      return await response.json();
    } catch {
      throw new ApiError(`${what}: response was not valid JSON.`);
    }
  }

  async _send(method, url, body, what) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: this._authHeader({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(
        `Could not reach the API at ${url}: ${exc.message}. ` +
          "Is the dev server running? (node server.mjs) — see the README.",
      );
    }
    return this._check(response, what);
  }

  // -- 1. login / logout ----------------------------------------------------

  async login() {
    const url = `${this.serverUrl}${API}/login/sessions`;
    const body = { username: this.user, password: this.password, setCookie: false };
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
    const data = await this._check(response, "Login");
    this.token = data.token;
    if (!this.token) throw new ApiError("Login response did not contain a token.");
    return this.token;
  }

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

  // -- 2. create virtual device ---------------------------------------------

  async createVirtualDevice(name) {
    const url = `${this.serverUrl}${API}/devices/*/virtual`;
    const data = await this._send("POST", url, { name }, "Create virtual device");
    return parseDeviceId(data);
  }

  // -- 3. lock --------------------------------------------------------------

  async lockDevice(deviceId, ttlMs) {
    const url = `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}/virtual/lock`;
    const data = await this._send("PATCH", url, { ttlMs }, "Lock virtual device");
    return parseLockToken(data);
  }

  // -- 4. create upload -----------------------------------------------------

  async createUpload(deviceId, filename, sizeB, md5B64, startTimeMs, requestedChunkSize, durationMs = null) {
    const url = `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}/virtual/uploads`;
    const body = buildItemsPayload(filename, sizeB, md5B64, startTimeMs, requestedChunkSize, durationMs);
    const data = await this._send("POST", url, body, "Create upload");
    return parseUploadItem(data, requestedChunkSize, filename);
  }

  // -- 5. upload one chunk --------------------------------------------------

  async uploadChunk(deviceId, uploadId, index, bytes) {
    const url =
      `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}` +
      `/virtual/uploads/${encodeURIComponent(uploadId)}?chunk=${index}`;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method: "PUT",
        headers: this._authHeader({ "Content-Type": "application/octet-stream" }),
        body: bytes,
      });
    } catch (exc) {
      throw new ApiError(`Could not reach the API at ${url}: ${exc.message}.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`Chunk upload unauthorized (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Chunk ${index} upload failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    return response;
  }

  // -- 6. upload status -----------------------------------------------------

  /**
   * GET .../virtual/uploads/{uploadId} -> the upload/import status.
   * There is NO separate consume call: PATCH .../virtual/consume is deprecated.
   * Completing the chunk PUTs starts the import automatically (using the
   * startTimeMs given at create-upload); this GET reports progress.
   */
  async uploadStatus(deviceId, uploadId) {
    const url =
      `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}` +
      `/virtual/uploads/${encodeURIComponent(uploadId)}`;
    let response;
    try {
      response = await this.fetchImpl(url, { headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(`Could not reach the API at ${url}: ${exc.message}.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`Upload status unauthorized (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(`Upload status failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  // -- 7. release -----------------------------------------------------------

  async release(deviceId, lockToken) {
    const url = `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}/virtual/release`;
    return this._send("PATCH", url, { token: lockToken }, "Release lock");
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
// Orchestration (steps 2-7) — separated so it is easy to test end-to-end.
// ---------------------------------------------------------------------------

/**
 * Run the full create -> lock -> create-upload -> chunk PUTs -> status ->
 * release sequence for a selected browser File (or any { name, size,
 * arrayBuffer() } object). NO consume call; durationMs is optional.
 *
 * The lock is always released in a finally block, even if a step fails.
 *
 * @param {NxVirtualCameraClient} client
 * @param {File|{name:string,size:number,arrayBuffer:Function}} file
 * @param {object} opts
 * @param {string} opts.name        Name for a new virtual device.
 * @param {number} opts.startTimeMs Archive start (epoch ms).
 * @param {number} [opts.ttlMs]     Lock TTL (default DEFAULT_TTL_MS).
 * @param {number} [opts.requestedChunkSize] (default DEFAULT_CHUNK_SIZE_B).
 * @param {number} [opts.durationMs] Clip length in ms (optional; server derives
 *        it from the file's own metadata when omitted).
 * @param {string} [opts.deviceId]  Upload to an EXISTING device (skip create).
 * @param {function} [opts.onProgress] Progress callback (message string).
 * @returns {Promise<object>} summary of the run.
 */
export async function uploadVideo(client, file, opts = {}) {
  const {
    name = "Virtual Camera",
    startTimeMs,
    ttlMs = DEFAULT_TTL_MS,
    requestedChunkSize = DEFAULT_CHUNK_SIZE_B,
    durationMs = null,
    deviceId: existingId = null,
    onProgress = null,
  } = opts;

  const note = (m) => {
    if (onProgress) onProgress(m);
  };

  const filename = file.name;
  // Read the whole file once: needed for the required md5, and we slice it for
  // each chunk. (A streaming/incremental MD5 would let huge files avoid this,
  // but reading once keeps the sample simple and correct.)
  const arrayBuffer = await file.arrayBuffer();
  const allBytes = new Uint8Array(arrayBuffer);
  const sizeB = allBytes.length;
  const md5B64 = md5OfBytes(allBytes);
  note(`Hashed ${sizeB} byte(s) (MD5 ${md5B64})`);

  let deviceId = existingId;
  if (!deviceId) {
    deviceId = await client.createVirtualDevice(name);
    note(`Created virtual device ${deviceId}`);
  } else {
    note(`Using existing virtual device ${deviceId}`);
  }

  const lockToken = await client.lockDevice(deviceId, ttlMs);
  note("Lock acquired");

  let uploadId;
  let serverChunkSize;
  let chunkCount = 0;
  let status = null;
  try {
    ({ uploadId, chunkSizeB: serverChunkSize } = await client.createUpload(
      deviceId,
      filename,
      sizeB,
      md5B64,
      startTimeMs,
      requestedChunkSize,
      durationMs,
    ));
    note(`Upload created (id ${uploadId}, chunk ${serverChunkSize} B)`);

    const plan = chunkPlan(sizeB, serverChunkSize);
    for (const { index, offset, length } of plan) {
      const slice = allBytes.subarray(offset, offset + length);
      await client.uploadChunk(deviceId, uploadId, index, slice);
      chunkCount += 1;
      note(`Uploaded chunk ${index + 1}/${plan.length}`);
    }

    // No consume call (deprecated): the import auto-starts on completion.
    status = await client.uploadStatus(deviceId, uploadId);
    note(`Upload complete; server is importing footage at ${startTimeMs}ms`);
  } finally {
    await client.release(deviceId, lockToken);
    note("Released lock");
  }

  return {
    deviceId,
    uploadId,
    chunkCount,
    chunkSizeB: serverChunkSize,
    sizeB,
    startTimeMs,
    md5: md5B64,
    status,
  };
}

// ---------------------------------------------------------------------------
// Config: what the user types on the page.
// ---------------------------------------------------------------------------

export function resolveConfig(values = {}) {
  const v = (key) =>
    values[key] === undefined || values[key] === null ? "" : String(values[key]).trim();
  return {
    serverHost: v("serverHost"),
    user: v("user"),
    password: v("password"),
  };
}

export function missingFields(config) {
  return ["serverHost", "user", "password"].filter((k) => !config[k]);
}
