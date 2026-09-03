#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Create a VIRTUAL camera on an Nx VMS server and UPLOAD a local video file into
 * its archive as recorded footage. A virtual camera has no real RTSP source; you
 * push it pre-recorded media and the server ingests it as if it had been captured
 * at the given time.
 *
 * Node.js port of ../../python/virtual-camera-upload.
 *
 * THE VIRTUAL-CAMERA UPLOAD FLOW (from docs/v4_api_spec.json):
 *
 *   1. Log in:    POST   {server}/rest/v4/login/sessions  {username, password}
 *                   -> {"token": ...}
 *   2. Create:    POST   {server}/rest/v4/devices/*\/virtual  {"name": ...}
 *                   -> the new device (read its "id")          [skip with --device-id]
 *
 *   -- Upload the file to the server (no lock needed for this part) --
 *   3. Create upload: POST {server}/rest/v4/devices/{id}/virtual/uploads
 *                   {"items": [{filename, sizeB, md5, startTimeMs, durationMs,
 *                               chunkSizeB}]}
 *                   -> per-item info incl. the chunkSizeB the server wants and the
 *                   server-assigned uploadId
 *   4. Upload bytes:  PUT  {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=<n>
 *                   raw chunk bytes, Content-Type: application/octet-stream
 *   5. Status:    GET    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}
 *                   -> confirms uploadProgressPercent reached 100 (all bytes received)
 *
 *   -- Import the uploaded file into the virtual camera's archive --
 *   6. Lock:      PATCH  {server}/rest/v4/devices/{id}/virtual/lock  {"ttlMs": ...}
 *                   -> token at lockInfo.token ({id, lockInfo:{token, ...}})
 *   7. Consume:   PATCH  {server}/rest/v4/devices/{id}/virtual/consume
 *                   {"token": <lock>, "uploadId": ..., "startTimeMs": ...}
 *                   -> starts importing the already-uploaded file as camera footage
 *   8. Poll:      PATCH  {server}/rest/v4/devices/{id}/virtual/extend
 *                   {"token": <lock>, "ttlMs": ...}
 *                   -> renews the lock AND reports lockInfo.progress (0-100); call
 *                   this repeatedly until progress reaches 100
 *   9. Release:   PATCH  {server}/rest/v4/devices/{id}/virtual/release  {"token": <lock>}
 *                   (always run once a lock is held, even on error, so it is freed)
 *   + Log out:    DELETE {server}/rest/v4/login/sessions/<token>
 *
 *   On any failure after the upload exists, we best-effort cancel it first:
 *   DELETE {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId} (valid while
 *   the upload is "uploading or consuming") -- so a failed run does not leave an
 *   orphaned upload/consume in progress on the server.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// Default lock time-to-live (seconds) and requested upload chunk size (bytes).
export const DEFAULT_TTL_S = 300;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB

// How often to poll `.../virtual/extend` while waiting for consume to finish,
// and how long to wait before giving up.
export const DEFAULT_POLL_INTERVAL_S = 2;
export const DEFAULT_CONSUME_TIMEOUT_S = 300;

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
 * Turn the --start-time value into epoch milliseconds.
 * Accepts an ISO 8601 string (2026-06-15T12:00:00Z) or a raw epoch-ms number.
 * Empty/blank/null/undefined -> "now". Naive times are treated as UTC by Date.
 */
export function parseStartTimeMs(value, now = null) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (!text) {
    return now === null || now === undefined ? Date.now() : Number(now);
  }
  if (/^\d+$/.test(text)) return Number(text); // already epoch ms
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new ApiError(`Could not parse --start-time "${text}". Use ISO time or epoch ms.`);
  }
  return ms;
}

/** Base64-encoded MD5 of the full file content (what the API expects). */
export function fileMd5Base64(filePath) {
  const hash = createHash("md5");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("base64");
}

/**
 * Plan how a file of `totalSize` bytes splits into `chunkSize` pieces.
 *
 * Returns a list of {index, offset, length} objects, zero-based, with the last
 * piece holding the remainder. A zero-byte file yields a single empty chunk so
 * the server still sees one PUT.
 */
export function chunkPlan(totalSize, chunkSize) {
  if (chunkSize <= 0) throw new ApiError("--chunk-size must be a positive number of bytes.");
  if (totalSize <= 0) return [{ index: 0, offset: 0, length: 0 }];
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

/** Yield {index, bytes} for each chunk of the file, reading lazily from disk. */
export function* iterFileChunks(filePath, chunkSize) {
  const totalSize = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, "r");
  try {
    for (const { index, offset, length } of chunkPlan(totalSize, chunkSize)) {
      const buffer = Buffer.alloc(length);
      if (length > 0) fs.readSync(fd, buffer, 0, length, offset);
      yield { index, bytes: buffer };
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build the {"items": [...]} body for the create-upload request.
 *
 * startTimeMs and durationMs are required by the create-upload schema even
 * though startTimeMs is ALSO passed again at the consume step below: the
 * create-upload call reserves the archive period for this file, and consume is
 * what actually triggers the import of the already-uploaded bytes into that
 * period.
 *
 * durationMs is OPTIONAL: when known, the server uses it to reserve the
 * archive period; when omitted, the server tries to derive the duration from
 * the video file's own metadata. If that metadata is missing or unreadable
 * and no durationMs was sent, the archive period comes back as zero and the
 * footage will not appear on the timeline (see the README's troubleshooting
 * section), so pass --duration-ms if you know the clip length.
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

/** Some Nx versions wrap a reply in {"reply": ...}. Unwrap defensively. */
function unwrap(data) {
  if (data && typeof data === "object" && !Array.isArray(data) && "reply" in data) {
    return data.reply;
  }
  return data;
}

/**
 * Pull the new device id from a create-virtual response, defensively.
 * The reply may be a bare object, a {"reply": ...} envelope, or a single-item
 * list. Return the "id" field.
 */
export function parseDeviceId(data) {
  let d = unwrap(data);
  if (Array.isArray(d)) d = d.length ? d[0] : {};
  if (d && typeof d === "object") {
    const deviceId = d.id;
    if (deviceId) return deviceId;
  }
  throw new ApiError("Create-virtual response did not contain a device id.");
}

/**
 * Pull the lock token from a lock/consume/extend response, defensively.
 * The v4 reply is shaped { "id": ..., "lockInfo": { "token": ..., ... } },
 * so the token lives under "lockInfo". Older/edge shapes may put it at the top
 * level, so we check both.
 */
export function parseLockToken(data) {
  const d = unwrap(data);
  if (d && typeof d === "object") {
    const lockInfo = d.lockInfo;
    if (lockInfo && typeof lockInfo === "object" && lockInfo.token) {
      return lockInfo.token;
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
  if (d && typeof d === "object") {
    const lockInfo = d.lockInfo;
    if (lockInfo && typeof lockInfo === "object" && lockInfo.progress !== undefined && lockInfo.progress !== null) {
      const progress = Number(lockInfo.progress);
      if (!Number.isFinite(progress)) return defaultValue;
      return Math.trunc(progress);
    }
  }
  return defaultValue;
}

/**
 * Read the create-upload reply -> {uploadId, chunkSizeB}, defensively.
 * Uses the server's returned chunkSizeB when present, else the requested size.
 * Uses the server's returned uploadId when present, else the filename (the
 * consume body documents uploadId as the previously uploaded file's name).
 */
export function parseUploadItem(data, requestedChunkSize, fallbackUploadId) {
  const d = unwrap(data);
  let items;
  if (d && typeof d === "object" && !Array.isArray(d) && Array.isArray(d.items)) {
    items = d.items;
  } else if (Array.isArray(d)) {
    items = d;
  } else if (d && typeof d === "object") {
    items = [d];
  } else {
    items = [];
  }
  let item = items.length ? items[0] : {};
  if (!item || typeof item !== "object") item = {};
  const uploadId = item.uploadId || fallbackUploadId;
  let chunkSizeB = item.chunkSizeB || requestedChunkSize;
  chunkSizeB = Number(chunkSizeB);
  if (!Number.isFinite(chunkSizeB) || chunkSizeB <= 0) chunkSizeB = requestedChunkSize;
  return { uploadId, chunkSizeB: Math.trunc(chunkSizeB) };
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
  if (
    d &&
    typeof d === "object" &&
    d.uploadProgressPercent !== undefined &&
    d.uploadProgressPercent !== null
  ) {
    const percent = Number(d.uploadProgressPercent);
    if (!Number.isFinite(percent)) return defaultValue;
    return Math.trunc(percent);
  }
  return 100;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Configuration (CLI > env > .env). Server vars are NX_SERVER_*.
// ---------------------------------------------------------------------------

export function loadEnvFile(envPath = ".env") {
  const values = {};
  if (!envPath || !fs.existsSync(envPath)) return values;
  for (let line of fs.readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function resolveConfig(cliArgs, envFileValues = {}, env = process.env) {
  const pick = (cliValue, envKey) => {
    if (cliValue !== undefined && cliValue !== null) return cliValue;
    if (env[envKey]) return env[envKey];
    return envFileValues[envKey];
  };
  return {
    host: pick(cliArgs.host, "NX_SERVER_HOST"),
    user: pick(cliArgs.user, "NX_SERVER_USER"),
    password: pick(cliArgs.password, "NX_SERVER_PASSWORD"),
  };
}

/**
 * Build an init option that skips TLS verification for self-signed lab servers.
 * Prefers an undici Agent passed as `dispatcher` (scoped to this client only);
 * if undici can't be imported in this runtime, falls back to the process-wide
 * NODE_TLS_REJECT_UNAUTHORIZED=0 escape hatch.
 */
export async function makeInsecureDispatcher() {
  try {
    const { Agent } = await import("undici");
    return new Agent({ connect: { rejectUnauthorized: false } });
  } catch {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    return null;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class NxVirtualCameraClient {
  constructor(host, user, password, { verifyTls = true, fetchImpl = fetch, dispatcher = null } = {}) {
    this.host = (host || "").replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.verifyTls = verifyTls;
    this.dispatcher = dispatcher;
    this.token = null;
  }

  /** Merge the per-request dispatcher (insecure TLS) into a fetch init. */
  _withDispatcher(init = {}) {
    if (this.dispatcher) return { ...init, dispatcher: this.dispatcher };
    return init;
  }

  /** Shared response validation -> typed errors + parsed JSON. */
  async _check(response, what) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `${what} unauthorized (HTTP ${response.status}). Check the username/` +
          "password, and that you are using a local (not cloud) user.",
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

  _authHeader(extra = null) {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    const headers = { Authorization: `Bearer ${this.token}` };
    if (extra) Object.assign(headers, extra);
    return headers;
  }

  async _send(method, url, body, what) {
    let response;
    try {
      response = await this.fetchImpl(
        url,
        this._withDispatcher({
          method,
          headers: this._authHeader({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        }),
      );
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${exc.message}`);
    }
    return this._check(response, what);
  }

  // -- 1. login / logout ----------------------------------------------------

  async login() {
    const url = `${this.host}${API}/login/sessions`;
    const body = { username: this.user, password: this.password, setCookie: false };
    let response;
    try {
      response = await this.fetchImpl(
        url,
        this._withDispatcher({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${exc.message}`);
    }
    const data = await this._check(response, "Login");
    this.token = data.token;
    if (!this.token) throw new ApiError("Login response did not contain a token.");
    return this.token;
  }

  /** DELETE the session so the token cannot be reused. Best-effort. */
  async logout() {
    if (!this.token) return;
    const url = `${this.host}${API}/login/sessions/${this.token}`;
    try {
      await this.fetchImpl(url, this._withDispatcher({ method: "DELETE", headers: this._authHeader() }));
    } catch {
      // Logout is cleanup; never let it crash the program.
    } finally {
      this.token = null;
    }
  }

  // -- 2. create virtual device --------------------------------------------

  /**
   * POST {server}/rest/v4/devices/*\/virtual {"name": ...} -> device id.
   * The `*` is the current-server wildcard; it is part of the path.
   */
  async createVirtualDevice(name) {
    const url = `${this.host}${API}/devices/*/virtual`;
    const data = await this._send("POST", url, { name }, "Create virtual device");
    return parseDeviceId(data);
  }

  // -- 3. create upload -----------------------------------------------------

  /**
   * POST .../virtual/uploads -> {uploadId, chunkSizeB} (server chunk size).
   * No lock is needed for this: uploading the raw file and importing it into
   * the archive are separate steps, and only the import needs the device.
   */
  async createUpload(deviceId, filename, sizeB, md5B64, startTimeMs, requestedChunkSize, durationMs = null) {
    const url = `${this.host}${API}/devices/${deviceId}/virtual/uploads`;
    const body = buildItemsPayload(filename, sizeB, md5B64, startTimeMs, requestedChunkSize, durationMs);
    const data = await this._send("POST", url, body, "Create upload");
    return parseUploadItem(data, requestedChunkSize, filename);
  }

  // -- 4. upload one chunk --------------------------------------------------

  /** PUT raw chunk bytes at ?chunk=<index> with octet-stream content type. */
  async uploadChunk(deviceId, uploadId, index, dataBytes) {
    const url =
      `${this.host}${API}/devices/${deviceId}/virtual/uploads/` +
      `${encodeURIComponent(String(uploadId))}?chunk=${index}`;
    let response;
    try {
      response = await this.fetchImpl(
        url,
        this._withDispatcher({
          method: "PUT",
          headers: this._authHeader({ "Content-Type": "application/octet-stream" }),
          body: dataBytes,
        }),
      );
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${exc.message}`);
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
   * (uploadProgressPercent), confirming all chunk bytes were received.
   */
  async uploadStatus(deviceId, uploadId) {
    const url =
      `${this.host}${API}/devices/${deviceId}/virtual/uploads/` +
      `${encodeURIComponent(String(uploadId))}`;
    let response;
    try {
      response = await this.fetchImpl(url, this._withDispatcher({ headers: this._authHeader() }));
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${exc.message}`);
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
   * DELETE .../virtual/uploads/{uploadId} -- best-effort cleanup, valid while
   * the upload is in an uploading or consuming state.
   */
  async cancelUpload(deviceId, uploadId) {
    const url =
      `${this.host}${API}/devices/${deviceId}/virtual/uploads/` +
      `${encodeURIComponent(String(uploadId))}`;
    let response;
    try {
      response = await this.fetchImpl(
        url,
        this._withDispatcher({ method: "DELETE", headers: this._authHeader() }),
      );
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${exc.message}`);
    }
    return this._check(response, "Cancel upload");
  }

  // -- 6. lock --------------------------------------------------------------

  /** PATCH .../virtual/lock {"ttlMs": ...} -> the lock token (lockInfo.token). */
  async lockDevice(deviceId, ttlMs) {
    const url = `${this.host}${API}/devices/${deviceId}/virtual/lock`;
    const data = await this._send("PATCH", url, { ttlMs }, "Lock virtual device");
    return parseLockToken(data);
  }

  // -- 7. consume -----------------------------------------------------------

  /**
   * PATCH .../virtual/consume {token, uploadId, startTimeMs} -> starts
   * importing the already-uploaded file as camera footage.
   */
  async consume(deviceId, lockToken, uploadId, startTimeMs) {
    const url = `${this.host}${API}/devices/${deviceId}/virtual/consume`;
    const body = { token: lockToken, uploadId, startTimeMs };
    return this._send("PATCH", url, body, "Start consume");
  }

  // -- 8. extend (poll progress + renew lock) -------------------------------

  /**
   * PATCH .../virtual/extend {ttlMs, token} -> renews the lock and reports
   * lockInfo.progress (0-100), the consume progress.
   */
  async extend(deviceId, lockToken, ttlMs) {
    const url = `${this.host}${API}/devices/${deviceId}/virtual/extend`;
    return this._send("PATCH", url, { ttlMs, token: lockToken }, "Extend lock");
  }

  // -- 9. release -----------------------------------------------------------

  /** PATCH .../virtual/release {"token": ...} -> free the lock. */
  async release(deviceId, lockToken) {
    const url = `${this.host}${API}/devices/${deviceId}/virtual/release`;
    return this._send("PATCH", url, { token: lockToken }, "Release lock");
  }
}

// ---------------------------------------------------------------------------
// Orchestration -- separated so it is easy to test end-to-end.
// ---------------------------------------------------------------------------

/** Default sleep: resolve after `seconds`. Replaceable in tests. */
const realSleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Default clock: seconds (fractional), monotonic enough for a poll deadline. */
const realNow = () => Date.now() / 1000;

/**
 * Poll `.../virtual/extend` until lockInfo.progress reaches 100.
 *
 * Each extend call both renews the lock (so it cannot expire mid-import) and
 * reports progress. Throws ApiError if `timeoutS` elapses first.
 *
 * `sleepFn` / `nowFn` are injectable so tests never actually wait.
 */
export async function waitForConsume(
  client,
  deviceId,
  lockToken,
  { ttlMs, pollIntervalS, timeoutS, sleepFn = realSleep, nowFn = realNow, onProgress = null } = {},
) {
  const deadline = nowFn() + timeoutS;
  let progress = 0;
  while (progress < 100) {
    if (nowFn() >= deadline) {
      throw new ApiError(
        `Consume did not reach 100% within ${timeoutS}s (last progress: ${progress}%).`,
      );
    }
    await sleepFn(pollIntervalS);
    const data = await client.extend(deviceId, lockToken, ttlMs);
    progress = parseLockProgress(data, progress);
    if (onProgress) onProgress(`Consume progress: ${progress}%`);
  }
  return progress;
}

/**
 * Run the full flow: create -> create-upload -> chunk PUTs -> upload status ->
 * lock -> consume -> extend(poll) -> release.
 *
 * The file is uploaded to the server BEFORE the device is locked (create-upload
 * takes no lock/token). Locking, consuming, and polling only happen once the raw
 * bytes are confirmed fully received. On any failure once the upload exists, the
 * upload is best-effort cancelled (DELETE .../uploads/{uploadId}) before the
 * lock (if acquired) is released, so a failed run does not leave an orphaned
 * upload/consume on the server.
 *
 * Returns an object summarising what happened. `onProgress` (optional) is called
 * with short status strings as the steps complete.
 */
export async function uploadVideo(
  client,
  filePath,
  {
    name,
    startTimeMs,
    ttlMs,
    requestedChunkSize,
    durationMs = null,
    deviceId = null,
    pollIntervalS = DEFAULT_POLL_INTERVAL_S,
    consumeTimeoutS = DEFAULT_CONSUME_TIMEOUT_S,
    sleepFn = realSleep,
    nowFn = realNow,
    onProgress = null,
  } = {},
) {
  const note = (message) => {
    if (onProgress) onProgress(message);
  };

  const sizeB = fs.statSync(filePath).size;
  const md5B64 = fileMd5Base64(filePath);
  const filename = path.basename(filePath);

  let device = deviceId;
  if (device === null || device === undefined) {
    device = await client.createVirtualDevice(name);
    note(`Created virtual device ${device}`);
  } else {
    note(`Using existing virtual device ${device}`);
  }

  const { uploadId, chunkSizeB: serverChunkSize } = await client.createUpload(
    device,
    filename,
    sizeB,
    md5B64,
    startTimeMs,
    requestedChunkSize,
    durationMs,
  );

  let lockToken = null;
  let chunkCount = 0;
  let progress;
  try {
    for (const { index, bytes } of iterFileChunks(filePath, serverChunkSize)) {
      await client.uploadChunk(device, uploadId, index, bytes);
      chunkCount += 1;
    }
    note(`${chunkCount} chunk(s) uploaded (${serverChunkSize} B each)`);

    const uploadProgress = parseUploadProgress(await client.uploadStatus(device, uploadId));
    if (uploadProgress < 100) {
      throw new ApiError(
        `Upload did not complete: server reports uploadProgressPercent=${uploadProgress}.`,
      );
    }
    note("Upload confirmed complete");

    lockToken = await client.lockDevice(device, ttlMs);
    note("Lock acquired");

    await client.consume(device, lockToken, uploadId, startTimeMs);
    note("Consume started");

    progress = await waitForConsume(client, device, lockToken, {
      ttlMs,
      pollIntervalS,
      timeoutS: consumeTimeoutS,
      sleepFn,
      nowFn,
      onProgress: note,
    });
  } catch (exc) {
    try {
      await client.cancelUpload(device, uploadId);
      note("Cancelled upload after failure");
    } catch {
      // Best-effort cleanup; do not mask the original error.
    }
    throw exc;
  } finally {
    if (lockToken !== null) {
      await client.release(device, lockToken);
      note("Released");
    }
  }

  return {
    deviceId: device,
    uploadId,
    chunkCount,
    chunkSizeB: serverChunkSize,
    sizeB,
    startTimeMs,
    consumeProgress: progress,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const flags = {
    file: null,
    name: null,
    deviceId: null,
    startTime: null,
    durationMs: null,
    ttl: null,
    chunkSize: null,
    pollInterval: null,
    consumeTimeout: null,
    host: null,
    user: null,
    password: null,
    envFile: ".env",
    insecure: false,
  };
  const map = {
    "--file": "file",
    "--name": "name",
    "--device-id": "deviceId",
    "--start-time": "startTime",
    "--duration-ms": "durationMs",
    "--ttl": "ttl",
    "--chunk-size": "chunkSize",
    "--poll-interval": "pollInterval",
    "--consume-timeout": "consumeTimeout",
    "--server-host": "host",
    "--user": "user",
    "--password": "password",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  const booleans = { "--insecure": "insecure" };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) flags[booleans[arg]] = true;
    else if (arg in map) flags[map[arg]] = inlineValue !== null ? inlineValue : argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return flags;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`${exc.message}\n`);
    return 2;
  }

  if (!args.file) {
    process.stderr.write("Missing required --file.\n");
    return 2;
  }

  const config = resolveConfig(args, loadEnvFile(args.envFile));

  const missing = ["host", "user", "password"].filter((n) => !config[n]);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy ../../.env.example). See the README.\n",
    );
    return 2;
  }

  if (!fs.existsSync(args.file) || !fs.statSync(args.file).isFile()) {
    process.stderr.write(`File not found: ${args.file}\n`);
    return 2;
  }

  let startTimeMs;
  try {
    startTimeMs = parseStartTimeMs(args.startTime);
  } catch (exc) {
    process.stderr.write(`${exc.message}\n`);
    return 2;
  }

  const ttlSeconds = args.ttl === null ? DEFAULT_TTL_S : Number(args.ttl);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    process.stderr.write("--ttl must be a positive number of seconds.\n");
    return 2;
  }
  const ttlMs = Math.trunc(ttlSeconds) * 1000;

  const chunkSize = args.chunkSize === null ? DEFAULT_CHUNK_SIZE : Number(args.chunkSize);
  if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
    process.stderr.write("--chunk-size must be a positive number of bytes.\n");
    return 2;
  }

  let durationMs = null;
  if (args.durationMs !== null) {
    durationMs = Number(args.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      process.stderr.write("--duration-ms must be a positive number of milliseconds.\n");
      return 2;
    }
  }

  const pollIntervalS =
    args.pollInterval === null ? DEFAULT_POLL_INTERVAL_S : Number(args.pollInterval);
  if (!Number.isFinite(pollIntervalS) || pollIntervalS <= 0) {
    process.stderr.write("--poll-interval must be a positive number of seconds.\n");
    return 2;
  }

  const consumeTimeoutS =
    args.consumeTimeout === null ? DEFAULT_CONSUME_TIMEOUT_S : Number(args.consumeTimeout);
  if (!Number.isFinite(consumeTimeoutS) || consumeTimeoutS <= 0) {
    process.stderr.write("--consume-timeout must be a positive number of seconds.\n");
    return 2;
  }

  const dispatcher = args.insecure ? await makeInsecureDispatcher() : null;
  const client = new NxVirtualCameraClient(config.host, config.user, config.password, {
    verifyTls: !args.insecure,
    dispatcher,
  });

  try {
    await client.login();
    process.stdout.write(`Logged in to ${config.host} as ${config.user}\n`);
    const result = await uploadVideo(client, args.file, {
      name: args.name === null ? "Virtual Camera" : args.name,
      startTimeMs,
      ttlMs,
      requestedChunkSize: Math.trunc(chunkSize),
      durationMs,
      deviceId: args.deviceId,
      pollIntervalS,
      consumeTimeoutS,
      onProgress: (m) => process.stdout.write(`  ${m}\n`),
    });
    process.stdout.write(
      `Done. Uploaded ${result.sizeB} bytes to device ${result.deviceId} ` +
        `as archive starting ${startTimeMs}ms.\n`,
    );
    return 0;
  } catch (exc) {
    if (exc instanceof AuthError) {
      process.stderr.write(`Login failed: ${exc.message}\n`);
      return 1;
    }
    if (exc instanceof ApiError) {
      process.stderr.write(`Error: ${exc.message}\n`);
      return 1;
    }
    throw exc;
  } finally {
    // Always try to release the session token, even on error.
    await client.logout();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
