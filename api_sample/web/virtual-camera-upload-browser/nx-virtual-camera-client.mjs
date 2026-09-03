// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Create a VIRTUAL camera on ONE Nx VMS server and UPLOAD a local video file
 * into its archive as recorded footage — from the BROWSER.
 *
 * Browser/front-end counterpart of ../../python/virtual-camera-upload. A
 * virtual camera has no real RTSP source; you push it pre-recorded media and
 * the server ingests it as if it had been captured at the given start time.
 *
 * THE v4 VIRTUAL-CAMERA UPLOAD FLOW (matches the Python source):
 *
 *   1. Log in:    POST   {server}/rest/v4/login/sessions
 *                   { username, password, setCookie:false }   -> { token }
 *   2. Create:    POST   {server}/rest/v4/devices/(asterisk)/virtual  { name }
 *                   -> the new device (read its "id")        [skip with deviceId]
 *
 *   -- Upload the file to the server (no lock needed for this part) --
 *   3. Create upload: POST {server}/rest/v4/devices/{id}/virtual/uploads
 *                   { items: [{ filename, sizeB, md5, startTimeMs, durationMs,
 *                               chunkSizeB }] }
 *                   -> server chunkSizeB + uploadId (durationMs is OPTIONAL —
 *                      the server derives duration from the file's own metadata
 *                      when it is omitted). NO lock/token is needed here.
 *   4. Upload bytes:  PUT  {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=<n>
 *                   raw chunk bytes, Content-Type: application/octet-stream
 *   5. Status:    GET    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}
 *                   -> confirms uploadProgressPercent reached 100 (all bytes in)
 *
 *   -- Import the uploaded file into the virtual camera's archive --
 *   6. Lock:      PATCH  {server}/rest/v4/devices/{id}/virtual/lock  { ttlMs }
 *                   -> token at lockInfo.token (defensive: also top-level)
 *   7. Consume:   PATCH  {server}/rest/v4/devices/{id}/virtual/consume
 *                   { token, uploadId, startTimeMs }
 *                   -> starts importing the already-uploaded file as footage
 *   8. Poll:      PATCH  {server}/rest/v4/devices/{id}/virtual/extend
 *                   { ttlMs, token }
 *                   -> renews the lock AND reports lockInfo.progress (0-100);
 *                      called repeatedly until progress reaches 100
 *   9. Release:   PATCH  {server}/rest/v4/devices/{id}/virtual/release  { token }
 *                   (always run once a lock is held, even on error)
 *   + Log out:    DELETE {server}/rest/v4/login/sessions/<token>  (best-effort)
 *
 *   On any failure after the upload exists, we best-effort cancel it first:
 *   DELETE {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId} (valid while
 *   the upload is "uploading or consuming") — so a failed run does not leave an
 *   orphaned upload/consume in progress on the server.
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

// How often to poll `.../virtual/extend` while waiting for consume to finish,
// and how long to wait before giving up. No CLI here: override per run via
// the uploadVideo(client, file, opts) object (`pollIntervalMs` /
// `consumeTimeoutMs`).
export const DEFAULT_POLL_INTERVAL_MS = 2000; // 2 seconds
export const DEFAULT_CONSUME_TIMEOUT_MS = 300000; // 5 minutes

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
// Pure helpers (no I/O over the network = easy to test)
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
 *
 * startTimeMs and durationMs are required by the create-upload schema even
 * though startTimeMs is ALSO passed again at the consume step: the create-
 * upload call reserves the archive period for this file, and consume is what
 * actually triggers the import of the already-uploaded bytes into that period.
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
 * Pull the lock token from a lock/consume/extend response, defensively. The v4
 * reply is shaped { id, lockInfo: { token, ... } } — token lives under
 * lockInfo. Older/edge shapes may put it at the top level, so we check both.
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
 * Pull lockInfo.progress (consume progress, 0-100) from a lock/consume/extend
 * response, defensively. Missing/unrecognised shapes -> `defaultValue`.
 */
export function parseLockProgress(data, defaultValue = 0) {
  const d = unwrap(data);
  if (d && typeof d === "object" && d.lockInfo && typeof d.lockInfo === "object") {
    const raw = d.lockInfo.progress;
    if (raw !== undefined && raw !== null) {
      const value = Number(raw);
      if (!Number.isFinite(value)) return defaultValue;
      return Math.trunc(value);
    }
  }
  return defaultValue;
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

/**
 * Pull uploadProgressPercent from an upload-status reply, defensively.
 *
 * Missing/unrecognised shapes default to 100: chunk PUTs are synchronous, so
 * by the time all chunks have been sent without error the upload is complete
 * even if this particular server reply omits the field.
 */
export function parseUploadProgress(data, defaultValue = 100) {
  const d = unwrap(data);
  if (d && typeof d === "object") {
    const raw = d.uploadProgressPercent;
    if (raw !== undefined && raw !== null) {
      const value = Number(raw);
      if (!Number.isFinite(value)) return defaultValue;
      return Math.trunc(value);
    }
  }
  return defaultValue;
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

  /**
   * Shared JSON request helper for POST/PATCH/DELETE. `body` may be omitted
   * (DELETE .../uploads/{uploadId} carries none) — then no JSON body or
   * Content-Type is sent.
   */
  async _send(method, url, body, what) {
    const hasBody = body !== undefined && body !== null;
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: hasBody
          ? this._authHeader({ "Content-Type": "application/json" })
          : this._authHeader(),
        body: hasBody ? JSON.stringify(body) : undefined,
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
      // logout is cleanup; never let it crash the program
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

  // -- 3. create upload -----------------------------------------------------

  async createUpload(deviceId, filename, sizeB, md5B64, startTimeMs, requestedChunkSize, durationMs = null) {
    const url = `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}/virtual/uploads`;
    const body = buildItemsPayload(filename, sizeB, md5B64, startTimeMs, requestedChunkSize, durationMs);
    const data = await this._send("POST", url, body, "Create upload");
    return parseUploadItem(data, requestedChunkSize, filename);
  }

  // -- 4. upload one chunk --------------------------------------------------

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

  // -- 5. upload status -----------------------------------------------------

  /**
   * GET .../virtual/uploads/{uploadId} -> the raw upload progress
   * (uploadProgressPercent), confirming all chunk bytes were received. This
   * says nothing about the archive import — that is driven by consume below.
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

  /**
   * DELETE .../virtual/uploads/{uploadId} — best-effort cleanup, valid while
   * the upload is in an uploading or consuming state.
   */
  async cancelUpload(deviceId, uploadId) {
    const url =
      `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}` +
      `/virtual/uploads/${encodeURIComponent(uploadId)}`;
    return this._send("DELETE", url, undefined, "Cancel upload");
  }

  // -- 6. lock --------------------------------------------------------------

  async lockDevice(deviceId, ttlMs) {
    const url = `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}/virtual/lock`;
    const data = await this._send("PATCH", url, { ttlMs }, "Lock virtual device");
    return parseLockToken(data);
  }

  // -- 7. consume -----------------------------------------------------------

  /**
   * PATCH .../virtual/consume { token, uploadId, startTimeMs } -> starts
   * importing the already-uploaded file as camera footage.
   */
  async consume(deviceId, lockToken, uploadId, startTimeMs) {
    const url = `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}/virtual/consume`;
    const body = { token: lockToken, uploadId, startTimeMs };
    return this._send("PATCH", url, body, "Start consume");
  }

  // -- 8. extend (poll progress + renew lock) -------------------------------

  /**
   * PATCH .../virtual/extend { ttlMs, token } -> renews the lock and reports
   * lockInfo.progress (0-100), the consume progress.
   */
  async extend(deviceId, lockToken, ttlMs) {
    const url = `${this.serverUrl}${API}/devices/${encodeURIComponent(deviceId)}/virtual/extend`;
    return this._send("PATCH", url, { ttlMs, token: lockToken }, "Extend lock");
  }

  // -- 9. release -----------------------------------------------------------

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

/** Default sleep: a real timer. Tests inject their own so nothing waits. */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Orchestration -- separated so it is easy to test end-to-end.
// ---------------------------------------------------------------------------

/**
 * Poll `.../virtual/extend` until lockInfo.progress reaches 100.
 *
 * Each extend call both renews the lock (so it cannot expire mid-import) and
 * reports progress. Throws ApiError if `timeoutMs` elapses first.
 *
 * `sleepFn` and `nowFn` are injectable so tests never actually sleep.
 *
 * @param {NxVirtualCameraClient} client
 * @param {string} deviceId
 * @param {string} lockToken
 * @param {number} ttlMs
 * @param {object} [opts]
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.timeoutMs]
 * @param {function} [opts.sleepFn]  (ms) => Promise
 * @param {function} [opts.nowFn]    () => milliseconds
 * @param {function} [opts.onProgress]
 * @returns {Promise<number>} the final progress (100).
 */
export async function waitForConsume(client, deviceId, lockToken, ttlMs, opts = {}) {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_CONSUME_TIMEOUT_MS,
    sleepFn = defaultSleep,
    nowFn = () => Date.now(),
    onProgress = null,
  } = opts;

  const deadline = nowFn() + timeoutMs;
  let progress = 0;
  while (progress < 100) {
    if (nowFn() >= deadline) {
      throw new ApiError(
        `Consume did not reach 100% within ${timeoutMs / 1000}s ` +
          `(last progress: ${progress}%).`,
      );
    }
    await sleepFn(pollIntervalMs);
    const data = await client.extend(deviceId, lockToken, ttlMs);
    progress = parseLockProgress(data, progress);
    if (onProgress) onProgress(`Consume progress: ${progress}%`);
  }
  return progress;
}

/**
 * Run the full flow for a selected browser File (or any { name, size,
 * arrayBuffer() } object): create -> create-upload -> chunk PUTs -> upload
 * status -> lock -> consume -> extend(poll) -> release.
 *
 * The file is uploaded to the server BEFORE the device is locked (create-upload
 * takes no lock/token). Locking, consuming and polling only happen once the raw
 * bytes are confirmed fully received. On any failure once the upload exists,
 * the upload is best-effort cancelled (DELETE .../uploads/{uploadId}) before
 * the lock (if one was acquired) is released, so a failed run does not leave an
 * orphaned upload/consume on the server.
 *
 * @param {NxVirtualCameraClient} client
 * @param {File|{name:string,size:number,arrayBuffer:Function}} file
 * @param {object} opts
 * @param {string} opts.name        Name for a new virtual device.
 * @param {number} opts.startTimeMs Archive start (epoch ms).
 * @param {number} [opts.ttlMs]     Lock TTL (default DEFAULT_TTL_MS). Also the
 *        ttlMs sent with every extend poll.
 * @param {number} [opts.requestedChunkSize] (default DEFAULT_CHUNK_SIZE_B).
 * @param {number} [opts.durationMs] Clip length in ms (optional; server derives
 *        it from the file's own metadata when omitted).
 * @param {string} [opts.deviceId]  Upload to an EXISTING device (skip create).
 * @param {number} [opts.pollIntervalMs] Gap between extend polls (default
 *        DEFAULT_POLL_INTERVAL_MS). No form field — override it here.
 * @param {number} [opts.consumeTimeoutMs] Give up after this long (default
 *        DEFAULT_CONSUME_TIMEOUT_MS). No form field — override it here.
 * @param {function} [opts.sleepFn] Injected for tests: (ms) => Promise.
 * @param {function} [opts.nowFn]   Injected for tests: () => milliseconds.
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
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    consumeTimeoutMs = DEFAULT_CONSUME_TIMEOUT_MS,
    sleepFn = defaultSleep,
    nowFn = () => Date.now(),
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

  const { uploadId, chunkSizeB: serverChunkSize } = await client.createUpload(
    deviceId,
    filename,
    sizeB,
    md5B64,
    startTimeMs,
    requestedChunkSize,
    durationMs,
  );
  note(`Upload created (id ${uploadId}, chunk ${serverChunkSize} B)`);

  let lockToken = null;
  let chunkCount = 0;
  let consumeProgress = 0;
  try {
    const plan = chunkPlan(sizeB, serverChunkSize);
    for (const { index, offset, length } of plan) {
      const slice = allBytes.subarray(offset, offset + length);
      await client.uploadChunk(deviceId, uploadId, index, slice);
      chunkCount += 1;
      note(`Uploaded chunk ${index + 1}/${plan.length}`);
    }

    const uploadProgress = parseUploadProgress(await client.uploadStatus(deviceId, uploadId));
    if (uploadProgress < 100) {
      throw new ApiError(
        `Upload did not complete: server reports uploadProgressPercent=${uploadProgress}.`,
      );
    }
    note("Upload confirmed complete");

    lockToken = await client.lockDevice(deviceId, ttlMs);
    note("Lock acquired");

    await client.consume(deviceId, lockToken, uploadId, startTimeMs);
    note("Consume started");

    consumeProgress = await waitForConsume(client, deviceId, lockToken, ttlMs, {
      pollIntervalMs,
      timeoutMs: consumeTimeoutMs,
      sleepFn,
      nowFn,
      onProgress: note,
    });
  } catch (exc) {
    try {
      await client.cancelUpload(deviceId, uploadId);
      note("Cancelled upload after failure");
    } catch {
      // best-effort cleanup; do not mask the original error
    }
    throw exc;
  } finally {
    if (lockToken !== null) {
      await client.release(deviceId, lockToken);
      note("Released lock");
    }
  }

  return {
    deviceId,
    uploadId,
    chunkCount,
    chunkSizeB: serverChunkSize,
    sizeB,
    startTimeMs,
    md5: md5B64,
    consumeProgress,
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
