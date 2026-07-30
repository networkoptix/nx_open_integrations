#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Save a short video CLIP from an Nx camera to a FILE — the command-line
 * counterpart of the browser ../../web/media-http-stream sample. A CLI can't
 * render a <video>, so instead it fetches the media stream and writes it to a
 * file you can play in VLC / ffplay / a browser.
 *
 * TypeScript sample on the latest /rest/v4 API. Runs directly on Node 22.6+ via
 * native type stripping — no build step, zero runtime dependencies. Built-in
 * `fetch` (Node 18+), `node:stream`, and `node:test`. Shared API shapes come
 * from ../nx-types.ts (type-only import, stripped at runtime).
 *
 * BOTH auth modes, exactly like the browser sample:
 *
 *   --mode direct  Direct to Media Server: connect to ONE media server by
 *                  IP:port with a LOCAL server account.
 *                    NX_SERVER_HOST / NX_SERVER_USER / NX_SERVER_PASSWORD
 *   --mode cloud   Pull Stream via Cloud Relay: a cloud account reaches the
 *                  site over the relay (token scoped with cloudSystemId, the
 *                  relay 307 followed manually with the bearer re-attached).
 *                    NX_CLOUD_HOST / NX_CLOUD_USER / NX_CLOUD_PASSWORD / NX_CLOUD_SITE_ID
 *
 * THE MEDIA ENDPOINT (from the v4 spec):
 *
 *   GET /rest/v4/devices/{id}/media.{format}   (Authorization: Bearer <token>)
 *     ?positionMs=<ms>     archive start time; OMIT this for LIVE
 *     &durationMs=<ms>    how much footage to pull (bounds the clip)
 *
 *   format is one of the containers the v4 spec allows for this endpoint (see
 *   FORMATS, taken verbatim from docs/v4_api_spec.json):
 *     webm, mpegts, mpjpeg, mp4, mkv, _3gp, rtp, flv, f4v
 *   webm / mp4 / mkv are the most broadly playable for short saved clips;
 *   mpjpeg is a multipart MJPEG stream (frames, not a single video); rtp/flv/
 *   f4v/_3gp/mpegts are the remaining containers the server can mux to.
 *
 * LIVE vs ARCHIVE:
 *   - No --pos            -> LIVE: save the next --duration seconds.
 *   - --pos <ISO|epochMs> -> ARCHIVE: save --duration seconds starting there.
 *
 * Because a CLI must terminate, the clip is always bounded by --duration
 * (seconds, default 10). durationMs is sent to the server AND used as a
 * client-side safety stop so the program can never hang on an endless stream.
 *
 * Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  FetchImpl,
  OAuthPasswordGrant,
  TokenResponse,
  LoginRequest,
  LoginResponse,
} from "../nx-types.ts";

export const CLIENT_ID = "3rdParty";
export const RELAY_SUFFIX = ".relay.vmsproxy.com";
// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

// The two auth modes this sample supports (same names as the web sample).
export const MODE_DIRECT = "direct";
export const MODE_CLOUD = "cloud";
export type Mode = typeof MODE_DIRECT | typeof MODE_CLOUD;

// Container formats the v4 media.{format} endpoint supports, copied verbatim
// from the `format` enum in docs/v4_api_spec.json. Don't invent others.
export const FORMATS = [
  "webm",
  "mpegts",
  "mpjpeg",
  "mp4",
  "mkv",
  "_3gp",
  "rtp",
  "flv",
  "f4v",
] as const;
export type MediaFormat = (typeof FORMATS)[number];
export const DEFAULT_FORMAT: MediaFormat = "webm";

// Clip length when --duration is not given (seconds).
export const DEFAULT_DURATION_S = 10;
// Extra wall-clock grace beyond durationMs before the client-side abort fires.
const ABORT_GRACE_MS = 10000;
// Most redirects we will follow when chasing the relay 307.
const MAX_REDIRECTS = 5;

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
// Small helpers
// ---------------------------------------------------------------------------

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/** True for the HTTP redirect statuses the relay may answer with. */
function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Turn the optional archive position into epoch milliseconds, or null for live.
 * Accepts an ISO 8601 string (2026-06-15T12:00:00Z) or a raw epoch-ms number.
 * Empty/blank -> null (live).
 */
export function parsePositionMs(value: string | number | null | undefined): number | null {
  const s = value === undefined || value === null ? "" : String(value).trim();
  if (!s) return null; // live
  if (/^\d+$/.test(s)) return Number(s); // already epoch ms
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new ApiError(`Could not parse archive position "${s}". Use ISO time or epoch ms.`);
  }
  return ms;
}

/** Validate/normalize a requested container format. */
export function normalizeFormat(value: string | null | undefined): MediaFormat {
  const s = (value ?? DEFAULT_FORMAT).toString().trim().toLowerCase().replace(/^\./, "");
  if ((FORMATS as readonly string[]).includes(s)) return s as MediaFormat;
  throw new ApiError(`Unsupported format "${value}". Choose one of: ${FORMATS.join(", ")}.`);
}

/** Parse --duration (seconds, may be fractional) into whole milliseconds. */
export function durationToMs(seconds: string | number | null | undefined): number {
  if (seconds === undefined || seconds === null || seconds === "") {
    return DEFAULT_DURATION_S * 1000;
  }
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError(`--duration must be a positive number of seconds (got "${seconds}").`);
  }
  return Math.round(n * 1000);
}

// ---------------------------------------------------------------------------
// Configuration (CLI > env > .env)
// ---------------------------------------------------------------------------

export type EnvValues = Record<string, string>;

export function loadEnvFile(path = ".env"): EnvValues {
  const values: EnvValues = {};
  if (!path || !fs.existsSync(path)) return values;
  for (let line of fs.readFileSync(path, "utf-8").split(/\r?\n/)) {
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

export interface CliArgs {
  mode: string | null;
  serverHost: string | null;
  cloudHost: string | null;
  user: string | null;
  password: string | null;
  siteId: string | null;
  mfaCode: string | null;
  deviceId: string | null;
  format: string | null;
  pos: string | null;
  duration: string | null;
  out: string | null;
  envFile: string;
  insecure: boolean;
}

export interface ResolvedConfig {
  mode: Mode;
  serverHost?: string;
  cloudHost?: string;
  user?: string;
  password?: string;
  siteId?: string;
  mfaCode: string | null;
  deviceId?: string;
  format: MediaFormat;
  positionMs: number | null;
  durationMs: number;
  out: string | null;
}

export function resolveConfig(
  cliArgs: Partial<CliArgs>,
  envFileValues: EnvValues = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const pick = (cliValue: string | null | undefined, envKey: string): string | undefined => {
    if (cliValue !== undefined && cliValue !== null) return cliValue;
    if (env[envKey]) return env[envKey];
    return envFileValues[envKey];
  };
  const mode: Mode = (cliArgs.mode ?? env["NX_MODE"] ?? envFileValues["NX_MODE"]) === MODE_CLOUD
    ? MODE_CLOUD
    : MODE_DIRECT;
  return {
    mode,
    serverHost: pick(cliArgs.serverHost, "NX_SERVER_HOST"),
    cloudHost: pick(cliArgs.cloudHost, "NX_CLOUD_HOST") ?? "https://nxvms.com",
    user: pick(cliArgs.user, mode === MODE_CLOUD ? "NX_CLOUD_USER" : "NX_SERVER_USER"),
    password: pick(cliArgs.password, mode === MODE_CLOUD ? "NX_CLOUD_PASSWORD" : "NX_SERVER_PASSWORD"),
    siteId: pick(cliArgs.siteId, "NX_CLOUD_SITE_ID"),
    mfaCode: cliArgs.mfaCode ?? null,
    deviceId: pick(cliArgs.deviceId, "NX_DEVICE_ID"),
    format: normalizeFormat(pick(cliArgs.format, "NX_MEDIA_FORMAT")),
    positionMs: parsePositionMs(cliArgs.pos ?? null),
    durationMs: durationToMs(cliArgs.duration ?? null),
    out: cliArgs.out ?? null,
  };
}

/** Which required fields are missing for the chosen mode. */
export function missingFields(config: ResolvedConfig): string[] {
  const required: (keyof ResolvedConfig)[] =
    config.mode === MODE_CLOUD
      ? ["cloudHost", "user", "password", "siteId", "deviceId"]
      : ["serverHost", "user", "password", "deviceId"];
  return required.filter((k) => !config[k]);
}

/** Default output filename when --out is not given: clip-<device>-<ts>.<fmt>. */
export function defaultOutName(deviceId: string, format: MediaFormat, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const safeId = deviceId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `clip-${safeId}-${stamp}.${format}`;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ClientOptions {
  serverHost?: string;
  cloudHost?: string;
  siteId?: string;
  mfaCode?: string | null;
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
}

/** A minimal sink so saveClip() can be tested without touching the disk. */
export type ClipSink = (body: ReadableStream<Uint8Array>) => Promise<number>;

export class NxMediaClient {
  mode: Mode;
  user: string;
  password: string;
  serverHost: string;
  cloudHost: string;
  siteId: string;
  mfaCode: string | null;
  fetchImpl: FetchImpl;
  token: string | null;

  constructor(
    mode: Mode,
    user: string,
    password: string,
    {
      serverHost = "",
      cloudHost = "https://nxvms.com",
      siteId = "",
      mfaCode = null,
      verifyTls = true,
      fetchImpl = fetch,
    }: ClientOptions = {},
  ) {
    this.mode = mode;
    this.user = user;
    this.password = password;
    this.serverHost = (serverHost || "").replace(/\/+$/, "");
    this.cloudHost = (cloudHost || "").replace(/\/+$/, "");
    this.siteId = siteId;
    this.mfaCode = mfaCode;
    this.fetchImpl = fetchImpl;
    this.token = null;
    if (!verifyTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  /** The Cloud relay address for this site (cloud mode). */
  get relayUrl(): string {
    return `https://${this.siteId}${RELAY_SUFFIX}`;
  }

  /** Where media requests go: the server directly, or the site relay. */
  get mediaBase(): string {
    return this.mode === MODE_CLOUD ? this.relayUrl : this.serverHost;
  }

  _authHeader(): Record<string, string> {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  // -------------------------------------------------------------------------
  // login(): two flows, one method.
  // -------------------------------------------------------------------------

  async login(): Promise<string> {
    return this.mode === MODE_CLOUD ? this._loginCloud() : this._loginDirect();
  }

  /** Direct: POST {server}/rest/v4/login/sessions -> { token }. */
  async _loginDirect(): Promise<string> {
    const url = `${this.serverHost}${API}/login/sessions`;
    const body: LoginRequest = { username: this.user, password: this.password, setCookie: false };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}). Check the username/password, ` +
          "and that it is a LOCAL server account (cloud users use --mode cloud).",
      );
    }
    if (!response.ok) {
      throw new ApiError(`Login failed: HTTP ${response.status} ${(await safeText(response)).slice(0, 200)}`);
    }
    let data: LoginResponse;
    try {
      data = (await response.json()) as LoginResponse;
    } catch {
      throw new ApiError("Login response was not valid JSON.");
    }
    this.token = data.token;
    if (!this.token) throw new ApiError("Login response did not contain a token.");
    return this.token;
  }

  /** Cloud: POST {cloud}/cdb/oauth2/token with cloudSystemId scope -> { access_token }. */
  async _loginCloud(): Promise<string> {
    const url = `${this.cloudHost}/cdb/oauth2/token`;
    const body: OAuthPasswordGrant = {
      grant_type: "password",
      response_type: "token",
      client_id: CLIENT_ID,
      username: this.user,
      password: this.password,
      // THIS scope is what makes the token usable against the site relay.
      scope: `cloudSystemId=${this.siteId}`,
    };
    if (this.mfaCode) body.mfaCode = this.mfaCode;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (exc) {
      throw new ApiError(`Could not reach ${url}: ${(exc as Error).message}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `Login rejected (HTTP ${response.status}). Check the cloud email/password, ` +
          "the site id, and that the account has access to that site. Add --mfa-code for 2FA.",
      );
    }
    if (!response.ok) {
      throw new ApiError(`Token request failed: HTTP ${response.status} ${(await safeText(response)).slice(0, 200)}`);
    }
    let data: TokenResponse;
    try {
      data = (await response.json()) as TokenResponse;
    } catch {
      throw new ApiError("Token response was not valid JSON.");
    }
    this.token = data.access_token;
    if (!this.token) throw new ApiError("Token response did not contain an access_token.");
    return this.token;
  }

  // -------------------------------------------------------------------------
  // buildMediaUrl(): the upstream media URL (header auth — no token in the URL).
  // -------------------------------------------------------------------------

  buildMediaUrl({
    deviceId,
    format,
    positionMs = null,
    durationMs = null,
  }: {
    deviceId: string;
    format: MediaFormat;
    positionMs?: number | null;
    durationMs?: number | null;
  }): string {
    if (!deviceId) throw new ApiError("A deviceId is required to build the media URL.");
    const path = `${this.mediaBase}${API}/devices/${encodeURIComponent(deviceId)}/media.${format}`;
    const params = new URLSearchParams();
    // positionMs present == archive; absent == live.
    if (positionMs !== null && positionMs !== undefined) params.set("positionMs", String(positionMs));
    if (durationMs !== null && durationMs !== undefined) params.set("durationMs", String(durationMs));
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  }

  /**
   * GET a URL following the relay's 307 MANUALLY, re-attaching the bearer on
   * each hop. Auto-follow can drop the Authorization header across hosts, so we
   * use redirect:"manual" and resolve Location ourselves. Works for the direct
   * server too (it just won't redirect).
   */
  async _getFollowing(url: string, init: RequestInit): Promise<Response> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let response: Response;
      try {
        response = await this.fetchImpl(current, { ...init, redirect: "manual" });
      } catch (exc) {
        throw new ApiError(`Could not reach ${current}: ${(exc as Error).message}`);
      }
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) return response;
        current = new URL(location, current).toString();
        continue; // re-issue with the SAME init -> bearer re-attached
      }
      return response;
    }
    throw new ApiError(`Too many redirects (>${MAX_REDIRECTS}) chasing the relay.`);
  }

  // -------------------------------------------------------------------------
  // saveClip(): fetch the media stream and write it through `sink`.
  // -------------------------------------------------------------------------

  /**
   * Fetch the clip and hand the response body to `sink`, which writes it
   * somewhere and resolves with the number of bytes written. A client-side
   * AbortController stops an endless live stream after durationMs + grace, so
   * the CLI can never hang. Returns the byte count.
   */
  async saveClip(
    sink: ClipSink,
    {
      deviceId,
      format,
      positionMs = null,
      durationMs = null,
    }: {
      deviceId: string;
      format: MediaFormat;
      positionMs?: number | null;
      durationMs?: number | null;
    },
  ): Promise<number> {
    const url = this.buildMediaUrl({ deviceId, format, positionMs, durationMs });

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (durationMs && durationMs > 0) {
      timer = setTimeout(() => controller.abort(), durationMs + ABORT_GRACE_MS);
      // Don't keep the event loop alive just for this safety timer.
      if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref(): void }).unref();
    }

    try {
      const response = await this._getFollowing(url, {
        headers: this._authHeader(),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new AuthError(
          `The server rejected the token (HTTP ${response.status}). In cloud mode make ` +
            "sure it was scoped with cloudSystemId for THIS site.",
        );
      }
      if (!response.ok) {
        throw new ApiError(`Media request failed: HTTP ${response.status} ${(await safeText(response)).slice(0, 200)}`);
      }
      if (!response.body) {
        throw new ApiError("Media response had no body to save.");
      }
      return await sink(response.body as ReadableStream<Uint8Array>);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // logout(): revoke the token. Best-effort cleanup.
  // -------------------------------------------------------------------------

  async logout(): Promise<void> {
    if (!this.token) return;
    const url =
      this.mode === MODE_CLOUD
        ? `${this.cloudHost}/cdb/oauth2/token/${this.token}`
        : `${this.serverHost}${API}/login/sessions/${this.token}`;
    try {
      await this.fetchImpl(url, { method: "DELETE", headers: { Authorization: `Bearer ${this.token}` } });
    } catch {
      // best effort
    } finally {
      this.token = null;
    }
  }
}

// ---------------------------------------------------------------------------
// File sink: stream the response body to a file on disk (no buffering).
// ---------------------------------------------------------------------------

export function fileSink(outPath: string): ClipSink {
  return async (body: ReadableStream<Uint8Array>): Promise<number> => {
    const out = fs.createWriteStream(outPath);
    // Readable.fromWeb pipes the web stream straight to the file — the clip is
    // never held in memory all at once.
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), out);
    return fs.statSync(outPath).size;
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
    mode: null,
    serverHost: null,
    cloudHost: null,
    user: null,
    password: null,
    siteId: null,
    mfaCode: null,
    deviceId: null,
    format: null,
    pos: null,
    duration: null,
    out: null,
    envFile: ".env",
    insecure: false,
  };
  const map: Record<string, keyof CliArgs> = {
    "--mode": "mode",
    "--server-host": "serverHost",
    "--cloud-host": "cloudHost",
    "--user": "user",
    "--password": "password",
    "--site-id": "siteId",
    "--mfa-code": "mfaCode",
    "--device-id": "deviceId",
    "--format": "format",
    "--pos": "pos",
    "--duration": "duration",
    "--out": "out",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
  };
  const booleans: Record<string, keyof CliArgs> = { "--insecure": "insecure" };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inlineValue: string | null = null;
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) (flags[booleans[arg]!] as boolean) = true;
    else if (arg in map) (flags[map[arg]!] as string) = inlineValue !== null ? inlineValue : argv[++i]!;
    else throw new Error(`Unknown argument: ${arg}`);
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

  let config: ResolvedConfig;
  try {
    config = resolveConfig(args, loadEnvFile(args.envFile));
  } catch (exc) {
    // bad --format / --pos / --duration
    process.stderr.write(`${(exc as Error).message}\n`);
    return 2;
  }

  const missing = missingFields(config);
  if (missing.length) {
    process.stderr.write(
      `Missing config: ${missing.join(", ")}.\n` +
        "Provide via flags or .env (copy ../../.env.example). See the README.\n",
    );
    return 2;
  }

  const outPath = config.out ?? defaultOutName(config.deviceId!, config.format);

  const client = new NxMediaClient(config.mode, config.user!, config.password!, {
    serverHost: config.serverHost,
    cloudHost: config.cloudHost,
    siteId: config.siteId,
    mfaCode: config.mfaCode,
    verifyTls: !args.insecure,
  });

  const liveOrArchive = config.positionMs === null ? "live" : `archive @ ${config.positionMs}ms`;
  try {
    await client.login();
    process.stdout.write(
      `Saving ${config.durationMs / 1000}s ${liveOrArchive} clip of device ${config.deviceId} ` +
        `(${config.format}) to ${outPath} ...\n`,
    );
    const bytes = await client.saveClip(fileSink(outPath), {
      deviceId: config.deviceId!,
      format: config.format,
      positionMs: config.positionMs,
      durationMs: config.durationMs,
    });
    process.stdout.write(`Done. Wrote ${bytes} bytes to ${outPath}\n`);
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
    await client.logout();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
