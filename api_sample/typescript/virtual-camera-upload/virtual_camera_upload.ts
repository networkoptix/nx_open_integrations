#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Create a VIRTUAL camera on an Nx VMS server and UPLOAD a local video file into
 * its archive as recorded footage. A virtual camera has no real RTSP source; you
 * push it pre-recorded media and the server ingests it as if it had been captured
 * at the given time.
 *
 * TypeScript port of ../../python/virtual-camera-upload. Runs directly on Node
 * 22.6+ via native type stripping (no build step). Built-in `fetch` (Node 18+),
 * `node:test`, `node:fs`, `node:crypto` — no third-party runtime dependencies.
 * The file is read in chunks, so a large clip is never slurped into memory all
 * at once.
 *
 * Auth is DIRECT to ONE server with a LOCAL server account, exactly like
 * ../rest-list-cameras:
 *   NX_SERVER_HOST / NX_SERVER_USER / NX_SERVER_PASSWORD
 *
 * THE VIRTUAL-CAMERA UPLOAD FLOW (from docs/v4_api_spec.json):
 *
 *   1. Log in:    POST   {server}/rest/v4/login/sessions  {username, password}
 *                   -> {"token": ...}
 *   2. Create:    POST   {server}/rest/v4/devices/x/virtual  {"name": ...}
 *                   -> the new device (read its "id")          [skip with --device-id]
 *   3. Lock:      PATCH  {server}/rest/v4/devices/{id}/virtual/lock  {"ttlMs": ...}
 *                   -> token at lockInfo.token ({id, lockInfo:{token, ...}})
 *   4. Create upload: POST {server}/rest/v4/devices/{id}/virtual/uploads
 *                   {"items": [{filename, sizeB, md5, startTimeMs, chunkSizeB}]}
 *                   -> per-item info incl. the chunkSizeB the server wants
 *                   (startTimeMs is declared HERE, not at a consume step)
 *   5. Upload bytes:  PUT  {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=n
 *                   raw chunk bytes, Content-Type: application/octet-stream
 *   6. Status:    GET    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}
 *                   -> the import auto-starts once all chunks arrive; this reports it
 *                   (PATCH .../virtual/consume is DEPRECATED -- not used)
 *   7. Release:   PATCH  {server}/rest/v4/devices/{id}/virtual/release  {"token": <lock>}
 *                   (always run, even on error, so the lock is freed)
 *   + Log out:    DELETE {server}/rest/v4/login/sessions/<token>
 *
 * The "/x/" wildcard in step 2 (a literal asterisk on the wire) is the
 * current-server wildcard -- it is part of the path, not a placeholder. The
 * uploadId used in steps 5/6 is the server-returned uploadId, or the file's name
 * if none is echoed.
 *
 * Connecting to the server:
 *   --server-host is the server, e.g. https://192.168.1.10:7001 (https + port).
 *   Local servers usually present a self-signed certificate, so for a lab server
 *   you will typically need --insecure.
 *
 * Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { FetchImpl } from "../nx-types.ts";

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// Default lock time-to-live (seconds) and requested upload chunk size (bytes).
export const DEFAULT_TTL_S = 300;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

// ---------------------------------------------------------------------------
// Local interfaces (this sample's own shapes; shared types stay in nx-types.ts)
// ---------------------------------------------------------------------------

/**
 * One entry of the create-upload {"items": [...]} body.
 *
 * startTimeMs is declared here (at create-upload). durationMs is OPTIONAL: when
 * omitted, the server derives the clip's duration from the file's own metadata
 * once all chunks arrive.
 */
export interface UploadItem {
  filename: string;
  sizeB: number;
  md5: string;
  startTimeMs: number;
  chunkSizeB: number;
  durationMs?: number;
}

/** A single chunk's place in the file: zero-based index, byte offset, length. */
export interface ChunkPlanEntry {
  index: number;
  offset: number;
  length: number;
}

/** The v4 lock reply: { id, lockInfo: { userId, token, ttlMs, progress } }. */
export interface LockResponse {
  id?: string;
  lockInfo?: { token?: string; [key: string]: unknown };
  token?: string;
  [key: string]: unknown;
}

/** Result of parsing the create-upload reply. */
export interface UploadInfo {
  uploadId: string;
  chunkSizeB: number;
}

/** Summary returned by uploadVideo. */
export interface UploadResult {
  deviceId: string;
  uploadId: string;
  chunkCount: number;
  chunkSizeB: number;
  sizeB: number;
  startTimeMs: number;
  status: unknown;
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O over the network = easy to test)
// ---------------------------------------------------------------------------

const DIGITS_RE = /^\d+$/;

/**
 * Turn the --start-time value into epoch milliseconds.
 *
 * Accepts an ISO 8601 string (2026-06-15T12:00:00Z) or a raw epoch-ms number.
 * Empty/blank/null/undefined -> "now". Naive times are treated as UTC.
 */
export function parseStartTimeMs(
  value: string | null | undefined,
  now?: Date,
): number {
  const text = value === null || value === undefined ? "" : String(value).trim();
  if (!text) {
    return (now ?? new Date()).getTime();
  }
  if (DIGITS_RE.test(text)) {
    return parseInt(text, 10); // already epoch ms
  }
  // Append a UTC offset when the value carries no timezone, so naive times are
  // treated as UTC (matching the Python reference).
  let iso = text;
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(iso)) {
    iso = `${iso}Z`;
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new ApiError(
      `Could not parse --start-time "${text}". Use ISO time or epoch ms.`,
    );
  }
  return ms;
}

/** Base64-encoded MD5 of the full file content (what the API expects). */
export function fileMd5Base64(filePath: string): string {
  const digest = crypto.createHash("md5");
  digest.update(fs.readFileSync(filePath));
  return digest.digest("base64");
}

/**
 * Plan how a file of `totalSize` bytes splits into `chunkSize` pieces.
 *
 * Returns a list of {index, offset, length} entries, zero-based, with the last
 * piece holding the remainder. A zero-byte file yields a single empty chunk so
 * the server still sees one PUT.
 */
export function chunkPlan(totalSize: number, chunkSize: number): ChunkPlanEntry[] {
  if (chunkSize <= 0) {
    throw new ApiError("--chunk-size must be a positive number of bytes.");
  }
  if (totalSize <= 0) {
    return [{ index: 0, offset: 0, length: 0 }];
  }
  const plan: ChunkPlanEntry[] = [];
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

/** Yield {index, bytes} for each chunk of the file, reading lazily. */
export function* iterFileChunks(
  filePath: string,
  chunkSize: number,
): Generator<{ index: number; bytes: Buffer }> {
  const totalSize = fs.statSync(filePath).size;
  const handle = fs.openSync(filePath, "r");
  try {
    for (const { index, offset, length } of chunkPlan(totalSize, chunkSize)) {
      const buffer = Buffer.alloc(length);
      if (length > 0) {
        fs.readSync(handle, buffer, 0, length, offset);
      }
      yield { index, bytes: buffer };
    }
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * Build the {"items": [...]} body for the create-upload request.
 *
 * startTimeMs is declared HERE (at create-upload), not at a separate consume
 * step: the modern v4 flow drops the deprecated `.../virtual/consume` call and
 * starts the import automatically once all chunks reach `.../virtual/uploads/
 * {uploadId}`.
 *
 * durationMs is OPTIONAL: when known, the server uses it to reserve the
 * archive period; when omitted, the server tries to derive the duration from
 * the video file's own metadata. If that metadata is missing or unreadable
 * and no durationMs was sent, the archive period comes back as zero and the
 * footage will not appear on the timeline (see the README's troubleshooting
 * section), so pass --duration-ms if you know the clip length.
 */
export function buildItemsPayload(
  filename: string,
  sizeB: number,
  md5B64: string,
  startTimeMs: number,
  chunkSizeB: number,
  durationMs?: number | null,
): { items: UploadItem[] } {
  const item: UploadItem = {
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
function unwrap(data: unknown): unknown {
  if (data && typeof data === "object" && !Array.isArray(data) && "reply" in data) {
    return (data as { reply: unknown }).reply;
  }
  return data;
}

/**
 * Pull the new device id from a create-virtual response, defensively.
 *
 * The reply may be a bare object, a {"reply": ...} envelope, or a single-item
 * list. Return the "id" field.
 */
export function parseDeviceId(data: unknown): string {
  let body = unwrap(data);
  if (Array.isArray(body)) {
    body = body.length ? body[0] : {};
  }
  if (body && typeof body === "object") {
    const deviceId = (body as { id?: unknown }).id;
    if (deviceId) {
      return String(deviceId);
    }
  }
  throw new ApiError("Create-virtual response did not contain a device id.");
}

/**
 * Pull the lock token from a lock response, defensively.
 *
 * The v4 lock reply is shaped { "id": ..., "lockInfo": { "token": ..., ... } },
 * so the token lives under "lockInfo". Older/edge shapes may put it at the top
 * level, so we check both.
 */
export function parseLockToken(data: unknown): string {
  const body = unwrap(data);
  if (body && typeof body === "object") {
    const lock = body as LockResponse;
    if (lock.lockInfo && typeof lock.lockInfo === "object" && lock.lockInfo.token) {
      return String(lock.lockInfo.token);
    }
    if (lock.token) {
      return String(lock.token);
    }
  }
  throw new ApiError("Lock response did not contain a token.");
}

/**
 * Read the create-upload reply -> {uploadId, chunkSizeB}, defensively.
 *
 * Uses the server's returned chunkSizeB when present, else the requested size.
 * Uses the server's returned uploadId when present, else the filename (the
 * consume body documents uploadId as the previously uploaded file's name).
 */
export function parseUploadItem(
  data: unknown,
  requestedChunkSize: number,
  fallbackUploadId: string,
): UploadInfo {
  const body = unwrap(data);
  let items: unknown[];
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Array.isArray((body as { items?: unknown }).items)
  ) {
    items = (body as { items: unknown[] }).items;
  } else if (Array.isArray(body)) {
    items = body;
  } else if (body && typeof body === "object") {
    items = [body];
  } else {
    items = [];
  }
  let item = items.length ? items[0] : {};
  if (!item || typeof item !== "object") {
    item = {};
  }
  const rec = item as { uploadId?: unknown; chunkSizeB?: unknown };
  const uploadId = rec.uploadId ? String(rec.uploadId) : fallbackUploadId;
  let chunkSizeB = Number(rec.chunkSizeB);
  if (!Number.isFinite(chunkSizeB) || chunkSizeB <= 0) {
    chunkSizeB = requestedChunkSize;
  }
  return { uploadId, chunkSizeB };
}

// ---------------------------------------------------------------------------
// Configuration (CLI > env > .env). Server vars are NX_SERVER_*.
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  host: string | undefined;
  user: string | undefined;
  password: string | undefined;
}

/** Read a simple KEY=VALUE .env file into a record. Missing file -> {}. */
export function loadEnvFile(filePath: string = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
  if (!filePath || !fs.existsSync(filePath)) return values;
  for (let line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
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

/** CLI flag > OS environment variable > .env file. */
export function resolveConfig(
  cliArgs: { serverHost?: string | null; user?: string | null; password?: string | null },
  envFileValues: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const pick = (
    cliValue: string | null | undefined,
    envKey: string,
  ): string | undefined => {
    if (cliValue !== undefined && cliValue !== null) return cliValue;
    if (env[envKey]) return env[envKey];
    return envFileValues[envKey];
  };
  return {
    host: pick(cliArgs.serverHost, "NX_SERVER_HOST"),
    user: pick(cliArgs.user, "NX_SERVER_USER"),
    password: pick(cliArgs.password, "NX_SERVER_PASSWORD"),
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface NxVirtualCameraClientOptions {
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
  timeout?: number;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** Creates a virtual device on a single VMS server and uploads footage. */
export class NxVirtualCameraClient {
  host: string;
  user: string;
  password: string;
  fetchImpl: FetchImpl;
  timeout: number;
  token: string | null;

  constructor(
    host: string,
    user: string,
    password: string,
    { verifyTls = true, fetchImpl = fetch, timeout = 30000 }: NxVirtualCameraClientOptions = {},
  ) {
    this.host = (host || "").replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.token = null;
    if (!verifyTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  /** fetchImpl wrapper that aborts the request after `this.timeout` ms. */
  async _fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Shared response validation -> typed errors + parsed JSON. */
  async _check(response: Response, what: string): Promise<unknown> {
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

  _authHeader(extra?: Record<string, string>): Record<string, string> {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (extra) Object.assign(headers, extra);
    return headers;
  }

  async _post(url: string, body: unknown, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: "POST",
        headers: this._authHeader({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    return this._check(response, what);
  }

  async _patch(url: string, body: unknown, what: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: "PATCH",
        headers: this._authHeader({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    return this._check(response, what);
  }

  // -- 1. login / logout ---------------------------------------------------

  /** POST credentials, receive a bearer token, remember it. */
  async login(): Promise<string> {
    const url = `${this.host}${API}/login/sessions`;
    const body = { username: this.user, password: this.password, setCookie: false };
    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    const data = (await this._check(response, "Login")) as { token?: string };
    this.token = data.token ?? null;
    if (!this.token) throw new ApiError("Login response did not contain a token.");
    return this.token;
  }

  /** DELETE the session so the token cannot be reused. Best-effort. */
  async logout(): Promise<void> {
    if (!this.token) return;
    const url = `${this.host}${API}/login/sessions/${this.token}`;
    try {
      await this._fetchWithTimeout(url, { method: "DELETE", headers: this._authHeader() });
    } catch {
      // Logout is cleanup; never let it crash the program.
    } finally {
      this.token = null;
    }
  }

  // -- 2. create virtual device -------------------------------------------

  /**
   * POST {server}/rest/v4/devices/<wildcard>/virtual {"name": ...} -> device id.
   * The wildcard is the current-server marker; it is part of the path.
   */
  async createVirtualDevice(name: string): Promise<string> {
    const url = `${this.host}${API}/devices/*/virtual`;
    const data = await this._post(url, { name }, "Create virtual device");
    return parseDeviceId(data);
  }

  // -- 3. lock -------------------------------------------------------------

  /** PATCH .../virtual/lock {"ttlMs": ...} -> the lock token. */
  async lockDevice(deviceId: string, ttlMs: number): Promise<string> {
    const url = `${this.host}${API}/devices/${deviceId}/virtual/lock`;
    const data = await this._patch(url, { ttlMs }, "Lock virtual device");
    return parseLockToken(data);
  }

  // -- 4. create upload ----------------------------------------------------

  /** POST .../virtual/uploads -> {uploadId, server chunk size in bytes}. */
  async createUpload(
    deviceId: string,
    filename: string,
    sizeB: number,
    md5B64: string,
    startTimeMs: number,
    requestedChunkSize: number,
    durationMs?: number | null,
  ): Promise<UploadInfo> {
    const url = `${this.host}${API}/devices/${deviceId}/virtual/uploads`;
    const body = buildItemsPayload(filename, sizeB, md5B64, startTimeMs, requestedChunkSize, durationMs);
    const data = await this._post(url, body, "Create upload");
    return parseUploadItem(data, requestedChunkSize, filename);
  }

  // -- 5. upload one chunk -------------------------------------------------

  /** PUT raw chunk bytes at ?chunk=<index> with octet-stream content type. */
  async uploadChunk(
    deviceId: string,
    uploadId: string,
    index: number,
    dataBytes: Buffer,
  ): Promise<void> {
    const url =
      `${this.host}${API}/devices/${deviceId}/virtual/uploads/` +
      `${encodeURIComponent(uploadId)}?chunk=${index}`;
    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, {
        method: "PUT",
        headers: this._authHeader({ "Content-Type": "application/octet-stream" }),
        // A Uint8Array view is a valid BodyInit under the project lib/types; a
        // bare Buffer is not, even though undici accepts it at runtime.
        body: new Uint8Array(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`Chunk upload unauthorized (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(
        `Chunk ${index} upload failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
  }

  // -- 6. upload status ----------------------------------------------------

  /**
   * GET .../virtual/uploads/{uploadId} -> the upload/import status.
   *
   * There is NO separate consume call: `PATCH .../virtual/consume` is
   * deprecated. Completing the chunk PUTs to `.../virtual/uploads/{uploadId}`
   * starts the import automatically (using the startTimeMs given at create).
   * This GET (the recommended path-form status endpoint) reports progress.
   */
  async uploadStatus(deviceId: string, uploadId: string): Promise<unknown> {
    const url =
      `${this.host}${API}/devices/${deviceId}/virtual/uploads/` +
      `${encodeURIComponent(uploadId)}`;
    let response: Response;
    try {
      response = await this._fetchWithTimeout(url, { method: "GET", headers: this._authHeader() });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(`Upload status unauthorized (HTTP ${response.status}).`);
    }
    if (!response.ok) {
      const text = await safeText(response);
      throw new ApiError(
        `Upload status failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    }
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  // -- 7. release ----------------------------------------------------------

  /** PATCH .../virtual/release {"token": ...} -> free the lock. */
  async release(deviceId: string, lockToken: string): Promise<unknown> {
    const url = `${this.host}${API}/devices/${deviceId}/virtual/release`;
    return this._patch(url, { token: lockToken }, "Release lock");
  }
}

// ---------------------------------------------------------------------------
// Orchestration (steps 2-7) -- separated so it is easy to test end-to-end.
// ---------------------------------------------------------------------------

export interface UploadVideoParams {
  filePath: string;
  name: string;
  startTimeMs: number;
  ttlMs: number;
  requestedChunkSize: number;
  durationMs?: number | null;
  deviceId?: string | null;
  onProgress?: (message: string) => void;
}

/**
 * Run the full create -> lock -> create-upload -> chunk PUTs -> status ->
 * release sequence.
 *
 * There is NO explicit consume step: `PATCH .../virtual/consume` is deprecated,
 * and the import starts automatically once all chunks reach the
 * `.../virtual/uploads/{uploadId}` endpoint (footage placement comes from the
 * startTimeMs given at create-upload). We GET that endpoint to report status.
 *
 * Returns a summary of what happened. `onProgress` (optional) is called with
 * short status strings as the steps complete. The lock is always released in a
 * finally block, even if a step fails.
 */
export async function uploadVideo(
  client: NxVirtualCameraClient,
  params: UploadVideoParams,
): Promise<UploadResult> {
  const {
    filePath,
    name,
    startTimeMs,
    ttlMs,
    requestedChunkSize,
    durationMs,
    deviceId: existingDeviceId = null,
    onProgress,
  } = params;

  const note = (message: string): void => {
    if (onProgress) onProgress(message);
  };

  const sizeB = fs.statSync(filePath).size;
  const md5B64 = fileMd5Base64(filePath);
  const filename = path.basename(filePath);

  let deviceId: string;
  if (existingDeviceId === null || existingDeviceId === undefined) {
    deviceId = await client.createVirtualDevice(name);
    note(`Created virtual device ${deviceId}`);
  } else {
    deviceId = existingDeviceId;
    note(`Using existing virtual device ${deviceId}`);
  }

  const lockToken = await client.lockDevice(deviceId, ttlMs);
  note("Lock acquired");

  let uploadId = filename;
  let serverChunkSize = requestedChunkSize;
  let chunkCount = 0;
  let status: unknown = null;
  try {
    const info = await client.createUpload(
      deviceId,
      filename,
      sizeB,
      md5B64,
      startTimeMs,
      requestedChunkSize,
      durationMs,
    );
    uploadId = info.uploadId;
    serverChunkSize = info.chunkSizeB;

    for (const { index, bytes } of iterFileChunks(filePath, serverChunkSize)) {
      await client.uploadChunk(deviceId, uploadId, index, bytes);
      chunkCount += 1;
    }
    note(`${chunkCount} chunk(s) uploaded (${serverChunkSize} B each)`);

    // No consume call (deprecated): the import auto-starts on completion.
    status = await client.uploadStatus(deviceId, uploadId);
    note(`Upload complete; server is importing footage at ${startTimeMs}ms`);
  } finally {
    await client.release(deviceId, lockToken);
    note("Released");
  }

  return {
    deviceId,
    uploadId,
    chunkCount,
    chunkSizeB: serverChunkSize,
    sizeB,
    startTimeMs,
    status,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  file: string | null;
  name: string;
  deviceId: string | null;
  startTime: string | null;
  durationMs: number | null;
  ttl: number | null;
  chunkSize: number | null;
  serverHost: string | null;
  user: string | null;
  password: string | null;
  envFile: string;
  insecure: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
    file: null,
    name: "Virtual Camera",
    deviceId: null,
    startTime: null,
    durationMs: null,
    ttl: null,
    chunkSize: null,
    serverHost: null,
    user: null,
    password: null,
    envFile: ".env",
    insecure: false,
  };
  const strings: Record<string, "file" | "name" | "deviceId" | "startTime" | "serverHost" | "user" | "password" | "envFile"> = {
    "--file": "file",
    "--name": "name",
    "--device-id": "deviceId",
    "--start-time": "startTime",
    "--server-host": "serverHost",
    "--user": "user",
    "--password": "password",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  const numbers: Record<string, "ttl" | "chunkSize" | "durationMs"> = {
    "--ttl": "ttl",
    "--chunk-size": "chunkSize",
    "--duration-ms": "durationMs",
  };
  const booleans: Record<string, "insecure"> = { "--insecure": "insecure" };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inlineValue: string | null = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) {
      flags[booleans[arg]!] = true;
    } else if (arg in strings) {
      flags[strings[arg]!] = inlineValue !== null ? inlineValue : argv[++i]!;
    } else if (arg in numbers) {
      const raw = inlineValue !== null ? inlineValue : argv[++i]!;
      const value = Number(raw);
      if (Number.isNaN(value)) throw new Error(`${arg} must be a number, got "${raw}".`);
      flags[numbers[arg]!] = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return flags;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    process.stderr.write(`${(exc as Error).message}\n`);
    return 2;
  }

  if (!args.file) {
    process.stderr.write(
      "Missing required --file.\nUsage: node virtual_camera_upload.ts --file <path> " +
        "[--name <n>] [--device-id <id>] [--start-time <iso|ms>] " +
        "[--ttl <s>] [--chunk-size <bytes>] [--server-host <url>] [--user <u>] " +
        "[--password <p>] [--dotenv <path>] [--insecure]\nSee the README.\n",
    );
    return 2;
  }

  const config = resolveConfig(args, loadEnvFile(args.envFile));

  const missing = (["host", "user", "password"] as const).filter((n) => !config[n]);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy .env.example). See the README.\n",
    );
    return 2;
  }

  if (!fs.existsSync(args.file) || !fs.statSync(args.file).isFile()) {
    process.stderr.write(`File not found: ${args.file}\n`);
    return 2;
  }

  let startTimeMs: number;
  try {
    startTimeMs = parseStartTimeMs(args.startTime);
  } catch (exc) {
    process.stderr.write(`${(exc as Error).message}\n`);
    return 2;
  }

  const ttlMs = (args.ttl === null ? DEFAULT_TTL_S : args.ttl) * 1000;
  const chunkSize = args.chunkSize === null ? DEFAULT_CHUNK_SIZE : args.chunkSize;
  if (chunkSize <= 0) {
    process.stderr.write("--chunk-size must be a positive number of bytes.\n");
    return 2;
  }

  if (args.durationMs !== null && args.durationMs <= 0) {
    process.stderr.write("--duration-ms must be a positive number of milliseconds.\n");
    return 2;
  }

  const client = new NxVirtualCameraClient(config.host!, config.user!, config.password!, {
    verifyTls: !args.insecure,
  });

  try {
    await client.login();
    process.stdout.write(`Logged in to ${config.host} as ${config.user}\n`);
    const result = await uploadVideo(client, {
      filePath: args.file,
      name: args.name,
      startTimeMs,
      ttlMs,
      requestedChunkSize: chunkSize,
      durationMs: args.durationMs,
      deviceId: args.deviceId,
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
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
