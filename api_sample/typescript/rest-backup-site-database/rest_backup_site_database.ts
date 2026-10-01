#!/usr/bin/env node
// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Nx VMS REST Server API sample: back up and restore the Site database.
 *
 * TypeScript port of ../../python/rest-backup-site-database. Runs directly on
 * Node 22.6+ via native type stripping (no build step). Built-in `fetch`
 * (Node 18+) and `node:test`, no third-party runtime dependencies.
 *
 * The Site database is shared by every server in the site, so one dump is a
 * snapshot of the whole site configuration: servers, cameras, users, groups,
 * layouts, rules, licences and storage settings.
 *
 *   backup
 *   1. Log in:    POST   /rest/v4/login/sessions  {username, password} -> {"token": ...}
 *   2. Dump:      GET    /rest/v4/site/database   (Authorization: Bearer <token>)
 *   3. Log out:   DELETE /rest/v4/login/sessions/<token>
 *
 *   restore
 *   1. Log in:    POST   /rest/v4/login/sessions
 *   2. Load:      POST   /rest/v4/site/database   (Content-Type: application/octet-stream)
 *   3. No log out. The server restarts as soon as it accepts the dump, so the
 *      session ends with it.
 *
 * Both database calls want an administrator on a fresh session, which is why
 * this sample always logs in immediately before the call and never takes a
 * token you already hold.
 *
 * Connecting to the server:
 *   --host is the server, e.g. https://192.168.1.10:7001 (https + port). Local
 *   servers usually present a self-signed certificate, so use --insecure.
 *
 * Reference: https://meta.nxvms.com/doc/developers/api-tool/main?type=1
 */

import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

import type { FetchImpl, LoginRequest, LoginResponse } from "../nx-types.ts";

// API version path segment. v4 is the latest Nx REST API.
export const API = "/rest/v4";

/**
 * Socket-level failures that mean "the server went away mid-request".
 *
 * Node's fetch does not raise a distinct connection error the way Python's
 * requests does: it rejects with a TypeError and puts the real reason in
 * `cause`; node:http, which the restore upload uses, puts it on the error
 * itself. After a successful restore the server restarts and can cut the
 * connection instead of answering, so these codes are the success path, but
 * only once the whole dump was sent (see restoreDatabase).
 */
const DROPPED_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

export function isDroppedConnection(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && DROPPED_CONNECTION_CODES.has(code);
}

/**
 * What a run in progress must undo if Ctrl-C ends the process: its side file,
 * its session. SIGINT kills the process before any catch or finally runs, so
 * the entry point's SIGINT handler runs these instead.
 */
const onInterrupt = new Set<() => unknown>();

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
// Configuration (CLI > env > .env). Server vars are NX_SERVER_*.
// ---------------------------------------------------------------------------

export interface CliArgs {
  command: string | null;
  dump: string | null;
  host: string | null;
  user: string | null;
  password: string | null;
  envFile: string;
  insecure: boolean;
  out: string | null;
  force: boolean;
  yes: boolean;
}

export interface ResolvedConfig {
  host: string | undefined;
  user: string | undefined;
  password: string | undefined;
}

export function loadEnvFile(path: string = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
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

export function resolveConfig(
  cliArgs: Partial<CliArgs>,
  envFileValues: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const pick = (
    cliValue: string | null | undefined,
    envKey: string,
  ): string | undefined => {
    // An empty flag (--host=) counts as unset, as in the Python and C# ports.
    if (cliValue) return cliValue;
    if (env[envKey]) return env[envKey];
    return envFileValues[envKey];
  };
  return {
    host: pick(cliArgs.host, "NX_SERVER_HOST")?.replace(/\/+$/, ""),
    user: pick(cliArgs.user, "NX_SERVER_USER"),
    password: pick(cliArgs.password, "NX_SERVER_PASSWORD"),
  };
}

// ---------------------------------------------------------------------------
// Where the dump goes
// ---------------------------------------------------------------------------

/**
 * The sink seam, same shape as media-http-stream's ClipSink: it takes the
 * response body and returns how many bytes it wrote. Injecting it is what
 * keeps the tests offline and lets them assert chunk boundaries.
 */
export type DumpSink = (body: ReadableStream<Uint8Array>) => Promise<number>;

/**
 * Build a filename that says which site the dump came from, and when.
 *
 * The timestamp is UTC so that dumps taken from servers in different time
 * zones still sort into the order they were taken.
 */
export function defaultOutName(host: string, now: Date = new Date()): string {
  // Dots and colons become dashes, and an IPv6 literal's brackets go, so the
  // name is safe on every filesystem: [fe80::1]:7001 -> fe80--1-7001.
  const where = host.split("://").pop()!.replace(/[.:]/g, "-").replace(/[[\]]/g, "");
  const when = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `nx-site-database-${where}-${when}.db`;
}

/** Write the dump to an already-open stream, for --out - . */
export function streamSink(out: NodeJS.WritableStream): DumpSink {
  return async (body: ReadableStream<Uint8Array>): Promise<number> => {
    let written = 0;
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      written += chunk.length;
      // Respect backpressure. A pipe drains slower than the network fills it,
      // and ignoring write()'s false piles the whole dump up in memory.
      if (!out.write(chunk)) await once(out as unknown as NodeJS.EventEmitter, "drain");
    }
    return written;
  };
}

/**
 * Write the dump to a file. The bytes are never decoded, only copied.
 *
 * An existing file is replaced only with `overwrite` (--force). The check is
 * made when the finished dump is moved into place, so a file that appears
 * during the download is not clobbered either.
 */
export function fileSink(outPath: string, { overwrite = false }: { overwrite?: boolean } = {}): DumpSink {
  return async (body: ReadableStream<Uint8Array>): Promise<number> => {
    // Write to a side file and move it into place only once the whole dump
    // has arrived. A transfer cut halfway then leaves nothing that looks like a
    // backup, and --force never destroys the old dump before the new one is
    // complete. The random part means two runs with the same --out never write
    // into, delete or rename each other's file.
    const partial = `${outPath}.${randomBytes(6).toString("hex")}.partial`;
    const removePartial = () => fs.rmSync(partial, { force: true });
    onInterrupt.add(removePartial);
    let written: number;
    try {
      // Owner-only (0600): the dump holds every user's password hashes and the
      // servers' auth keys, and the usual umask would leave it world-readable.
      // Readable.fromWeb pipes the web stream straight to the file, so the dump
      // is never held in memory all at once.
      await pipeline(
        Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]),
        fs.createWriteStream(partial, { flags: "wx", mode: 0o600 }),
      );
      written = fs.statSync(partial).size;
      if (written === 0) {
        // Do not leave a zero byte file lying around looking like a backup. The
        // sink owns the path, so cleaning it up is the sink's job.
        removePartial();
      } else if (overwrite) {
        fs.renameSync(partial, outPath);
      } else {
        // link() fails with EEXIST if outPath exists, atomically, where a
        // rename would silently replace it.
        try {
          fs.linkSync(partial, outPath);
        } catch (exc) {
          if ((exc as { code?: string }).code !== "EEXIST") throw exc;
          throw new ApiError(
            `Refusing to overwrite ${outPath}, which appeared during the download. ` +
              "Choose another --out, or pass --force.",
          );
        }
        removePartial();
      }
    } catch (exc) {
      // Covers the move too: a dump that cannot be moved into place must not
      // stay behind as a .partial either.
      removePartial();
      throw exc;
    } finally {
      onInterrupt.delete(removePartial);
    }
    return written;
  };
}

/**
 * POST a file with node:http(s), streamed from disk.
 *
 * Not fetch: undici reads a request body ahead of the socket, so a fetch upload
 * holds the whole dump in memory (measured: all of a 100 MiB dump, against
 * under 1 MiB for this). It also follows no redirect, and its timeout is an
 * idle one, like the Python port's: it fires only when nothing moves either
 * way, so a slow but steady upload is never cut off.
 *
 * Resolves to { status, ok }. Rejects with the socket error, carrying `sent`
 * and `size`, so the caller can tell a restart after the whole dump from a
 * connection lost partway through.
 */
export function httpUpload(
  url: string,
  { headers, source, timeout, verifyTls = true }: {
    headers: Record<string, string>;
    source: string;
    timeout: number;
    verifyTls?: boolean;
  },
): Promise<{ status: number; ok: boolean }> {
  const size = fs.statSync(source).size;
  const target = new URL(url);
  const { request } = target.protocol === "https:" ? https : http;
  let sent = 0;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": String(size) },
        rejectUnauthorized: verifyTls,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300 });
      },
    );
    req.setTimeout(timeout, () =>
      req.destroy(Object.assign(new Error(`nothing moved for ${timeout / 1000} s`), { code: "IDLE_TIMEOUT" })),
    );
    req.on("error", (err) => reject(Object.assign(err, { sent, size })));
    const count = new Transform({
      transform(chunk, _encoding, done) {
        sent += chunk.length;
        done(null, chunk);
      },
    });
    // A failure here also destroys req, and surfaces as its 'error'.
    pipeline(fs.createReadStream(source), count, req).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface NxServerClientOptions {
  verifyTls?: boolean;
  fetchImpl?: FetchImpl;
  /** The restore upload; injectable so the tests can stand in for it. */
  uploadImpl?: typeof httpUpload;
  timeout?: number;
}

export class NxServerClient {
  host: string;
  user: string;
  password: string;
  fetchImpl: FetchImpl;
  uploadImpl: typeof httpUpload;
  verifyTls: boolean;
  timeout: number;
  token: string | null;

  constructor(
    host: string,
    user: string,
    password: string,
    { verifyTls = true, fetchImpl = fetch, uploadImpl = httpUpload, timeout = 300000 }: NxServerClientOptions = {},
  ) {
    this.host = (host || "").replace(/\/+$/, "");
    this.user = user;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.uploadImpl = uploadImpl;
    this.verifyTls = verifyTls;
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

  async login(): Promise<string> {
    const url = `${this.host}${API}/login/sessions`;
    const body: LoginRequest = {
      username: this.user,
      password: this.password,
      setCookie: false,
    };
    const response = await this._fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
    let data: LoginResponse;
    try {
      data = (await response.json()) as LoginResponse;
    } catch {
      throw new ApiError("Login response was not valid JSON.");
    }
    if (!data || !data.token) {
      throw new ApiError("Login response did not contain a token.");
    }
    this.token = data.token;
    return this.token;
  }

  _authHeader(): Record<string, string> {
    if (!this.token) throw new ApiError("Not logged in. Call login() first.");
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * GET site/database and hand the body to `sink`.
   *
   * The limit here is on silence, not on the whole transfer: it covers each
   * wait for the server, the way the Python version's per-read timeout works,
   * and not the time the sink spends writing. A large dump on a slow link can
   * take as long as it needs, and a server that stops sending is still noticed.
   */
  async backupDatabase(sink: DumpSink): Promise<number> {
    const url = `${this.host}${API}/site/database`;
    const seconds = this.timeout / 1000;
    const stalled = new ApiError(
      `The server stopped sending the dump: nothing arrived for ${seconds} s.`,
    );
    const controller = new AbortController();
    // Fails `promise` with `stalled` if it has not settled within the timeout.
    const withinTimeout = async <V>(promise: Promise<V>): Promise<V> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const silence = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(stalled), this.timeout);
      });
      try {
        return await Promise.race([promise, silence]);
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      const response = await withinTimeout(
        this.fetchImpl(url, { headers: this._authHeader(), signal: controller.signal }),
      );

      if (response.status === 401 || response.status === 403) {
        throw new AuthError(
          `The site refused the dump (HTTP ${response.status}). This endpoint ` +
            "needs an administrator on a fresh session.",
        );
      }
      if (!response.ok) {
        throw new ApiError(`The dump request failed (HTTP ${response.status}).`);
      }

      // Hand the sink a stream that reads from the server only when the sink
      // asks for more. The timeout runs during that read and nowhere else, so
      // a slow consumer (a throttled pipe, a slow disk) is never mistaken for
      // a server that stopped sending.
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            const { done, value } = await withinTimeout(reader.read());
            if (done) c.close();
            else c.enqueue(value);
          },
          cancel(reason) {
            return reader.cancel(reason);
          },
        },
        { highWaterMark: 0 },
      );
      const written = await sink(body);
      if (written === 0) {
        throw new ApiError(
          "The server returned an empty dump. Check that the account is an " +
            "administrator and that the site has finished starting.",
        );
      }
      return written;
    } catch (exc) {
      if (exc === stalled) controller.abort(stalled); // stop the transfer too
      throw exc;
    }
  }

  async restoreDatabase(source: string): Promise<void> {
    const url = `${this.host}${API}/site/database`;
    let response: { status: number; ok: boolean };
    try {
      response = await this.uploadImpl(url, {
        headers: { ...this._authHeader(), "Content-Type": "application/octet-stream" },
        source,
        timeout: this.timeout,
        verifyTls: this.verifyTls,
      });
    } catch (exc) {
      const { code, sent, size } = (exc ?? {}) as { code?: string; sent?: number; size?: number };
      const wholeDumpSent = typeof sent === "number" && sent === size;
      if (code === "IDLE_TIMEOUT") {
        if (!wholeDumpSent) {
          throw new ApiError(
            `The server stopped reading the dump after ${sent} of ${size} bytes. ` +
              "The dump was not loaded.",
          );
        }
        // Sent, but no answer in time. That is not the restart (which drops
        // the connection) and not a refusal (which answers), so the honest
        // report is that nobody knows yet.
        throw new ApiError(
          `No answer within ${this.timeout / 1000} s after the dump was sent. The ` +
            "server may have loaded it and be restarting, or the load may have " +
            "failed. Check the server before restoring again.",
        );
      }
      if (isDroppedConnection(exc)) {
        if (!wholeDumpSent) {
          // Cut off partway, or refused early: the server never had the whole
          // dump, so it cannot have loaded it.
          throw new ApiError(
            `The connection was lost after ${sent} of ${size} bytes were sent. ` +
              "The dump was not loaded.",
          );
        }
        // Expected. The whole dump was handed over, so this is success.
        this.token = null;
        return;
      }
      throw exc;
    }

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(
        `The site refused the load (HTTP ${response.status}). This endpoint ` +
          "needs an administrator on a fresh session.",
      );
    }
    if (!response.ok) {
      // Anything else the server rejects (a dump from another version, a
      // corrupt file, a redirect) comes back as another status, and nothing
      // restarts.
      throw new ApiError(
        `The load request failed (HTTP ${response.status}). The dump was not applied.`,
      );
    }
  }

  /** DELETE the session so the token cannot be reused. */
  async logout(): Promise<void> {
    if (!this.token) return;
    const url = `${this.host}${API}/login/sessions/${this.token}`;
    const header = this._authHeader();
    this.token = null;
    await this._fetchWithTimeout(url, { method: "DELETE", headers: header });
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** Render a byte count the way a person reads a backup file size. */
export function formatSize(byteCount: number): string {
  if (byteCount < 1024) return `${byteCount} bytes`;
  if (byteCount < 1024 * 1024) return `${(byteCount / 1024).toFixed(3)} KiB`;
  return `${(byteCount / (1024 * 1024)).toFixed(3)} MiB`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseArgs(argv: string[]): CliArgs {
  const flags: CliArgs = {
    command: null,
    dump: null,
    host: null,
    user: null,
    password: null,
    envFile: ".env",
    insecure: false,
    out: null,
    force: false,
    yes: false,
  };
  const valued: Record<string, "host" | "user" | "password" | "envFile" | "out"> = {
    "--host": "host",
    "--user": "user",
    "--password": "password",
    "--dotenv": "envFile", // NOT --env-file (a Node built-in)
    "--out": "out",
  };
  const booleans: Record<string, "insecure" | "force" | "yes"> = {
    "--insecure": "insecure",
    "--force": "force",
    "--yes": "yes",
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inlineValue: string | null = null;
    if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg in booleans) {
      // --yes=no must not mean yes: a boolean flag takes no value at all.
      if (inlineValue !== null) throw new Error(`${arg} takes no value`);
      flags[booleans[arg]!] = true;
    }
    else if (arg in valued) {
      if (inlineValue === null && i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      flags[valued[arg]!] = inlineValue !== null ? inlineValue : argv[++i]!;
    }
    else if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown argument: ${arg}`);
    else if (flags.command === null) flags.command = arg;
    else if (flags.dump === null) flags.dump = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return flags;
}

const USAGE = `Usage:
  rest_backup_site_database.ts backup  [--out PATH | -] [--force] [options]
  rest_backup_site_database.ts restore <dump> --yes [options]

Options: --host --user --password --dotenv --insecure
`;

/** True when `path` exists and is a directory, which --out cannot be. */
function isDirectory(path: string): boolean {
  return fs.statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * A failed file operation. Node puts the path and syscall on the error itself;
 * a failed fetch is a TypeError with the socket error tucked in `cause`.
 */
function isLocalFileError(error: unknown): boolean {
  const e = error as { syscall?: unknown; path?: unknown } | null;
  return typeof e?.syscall === "string" && typeof e?.path === "string";
}

/** TLS trust failures: on the error itself (node:http) or in its cause (fetch). */
function isTlsFailure(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | undefined;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" && (code.includes("CERT") || code.includes("SELF_SIGNED"));
}

export interface MainDeps {
  fetchImpl?: FetchImpl;
  uploadImpl?: typeof httpUpload;
  /** Injectable so tests never have to stub the real process streams. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  deps: MainDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    stderr.write(`${message}\n`);
    return 2;
  }

  if (args.command !== "backup" && args.command !== "restore") {
    stderr.write(USAGE);
    return 2;
  }

  try {
    if (args.command === "backup") return await runBackup(args, deps, stdout, stderr);
    return await runRestore(args, deps, stdout, stderr);
  } catch (exc) {
    if (exc instanceof AuthError || exc instanceof ApiError) {
      stderr.write(`ERROR: ${exc.message}\n`);
      return 1;
    }
    if (isLocalFileError(exc)) {
      // --out in a missing folder, no permission, a full disk: a problem here,
      // not with the server.
      // A failed rename names the side file as `path` and the destination as
      // `dest`; the destination is the one the user asked for.
      const { path, dest, message } = exc as { path: string; dest?: string; message: string };
      const where = dest ?? path;
      stderr.write(`ERROR: could not use ${where}: ${message}\n`);
      return 1;
    }
    if (isTlsFailure(exc)) {
      stderr.write(
        "ERROR: certificate verification failed. Local servers use a " +
          "self-signed certificate, add --insecure.\n",
      );
      return 1;
    }
    const message = exc instanceof Error ? exc.message : String(exc);
    stderr.write(`ERROR: could not reach the server: ${message}\n`);
    return 1;
  }
}

async function runBackup(
  args: CliArgs,
  deps: MainDeps,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const destination = args.out;
  if (destination && destination !== "-" && isDirectory(destination)) {
    stderr.write(`ERROR: ${destination} is a directory. Give --out a file path.\n`);
    return 1;
  }
  if (destination && destination !== "-" && fs.existsSync(destination) && !args.force) {
    stderr.write(
      `ERROR: Refusing to overwrite ${destination}. Choose another --out, or pass --force.\n`,
    );
    return 1;
  }

  const config = resolveConfig(args, loadEnvFile(args.envFile));
  const missing = (["host", "user", "password"] as const).filter((n) => !config[n]);
  if (missing.length) {
    stderr.write(
      `ERROR: missing configuration: ${missing.join(", ")}. Set it with a flag, ` +
        `an NX_SERVER_* environment variable, or in ${args.envFile}.\n`,
    );
    return 2;
  }

  if (destination === "-" && (stdout as { isTTY?: boolean }).isTTY) {
    stderr.write(
      "ERROR: Refusing to write a binary dump to the terminal. Redirect it, for " +
        "example --out - > site.db, or pipe it on.\n",
    );
    return 1;
  }

  // An empty --out= means no --out at all, as in the Python port.
  const outPath = destination || defaultOutName(config.host!);
  // With --out - the dump owns stdout, so progress goes to stderr and the
  // pipe stays clean.
  const status = outPath === "-" ? stderr : stdout;

  const client = new NxServerClient(config.host!, config.user!, config.password!, {
    verifyTls: !args.insecure,
    fetchImpl: deps.fetchImpl,
    uploadImpl: deps.uploadImpl,
  });
  // Log in here, immediately before the dump: the endpoint wants a fresh
  // session, so a token minted earlier is not good enough.
  await client.login();
  status.write(`Logged in to ${config.host} as ${config.user}\n\n`);

  status.write(`Dumping Site database from ${config.host}\n`);
  const sink = outPath === "-" ? streamSink(stdout) : fileSink(outPath, { overwrite: args.force });
  const endSession = () => client.logout();
  onInterrupt.add(endSession);
  let written: number;
  try {
    written = await client.backupDatabase(sink);
  } catch (exc) {
    // A failed dump must not leave an administrator session open behind it.
    await client.logout().catch(() => {});
    throw exc;
  } finally {
    onInterrupt.delete(endSession);
  }
  status.write(`  -> ${outPath}  (${formatSize(written)})\n`);

  // The dump is already on disk, so a logout that cannot be delivered is not
  // a reason to report failure.
  try {
    await client.logout();
    status.write("Done. Logged out.\n");
  } catch {
    status.write("Done. The dump is written; the logout could not be delivered.\n");
  }
  return 0;
}

async function runRestore(
  args: CliArgs,
  deps: MainDeps,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
): Promise<number> {
  const source = args.dump ?? "";
  if (isDirectory(source)) {
    stderr.write(`ERROR: ${source} is a directory, not a dump.\n`);
    return 1;
  }
  if (!fs.existsSync(source)) {
    stderr.write(`ERROR: No such dump: ${source}\n`);
    return 1;
  }
  if (fs.statSync(source).size === 0) {
    stderr.write(`ERROR: ${source} is empty, so it is not a dump.\n`);
    return 1;
  }
  if (!args.yes) {
    stderr.write(
      "ERROR: Refusing to restore without --yes. Loading this dump replaces " +
        "the whole site configuration and restarts the server.\n",
    );
    return 1;
  }

  const config = resolveConfig(args, loadEnvFile(args.envFile));
  const missing = (["host", "user", "password"] as const).filter((n) => !config[n]);
  if (missing.length) {
    stderr.write(
      `ERROR: missing configuration: ${missing.join(", ")}. Set it with a flag, ` +
        `an NX_SERVER_* environment variable, or in ${args.envFile}.\n`,
    );
    return 2;
  }

  const client = new NxServerClient(config.host!, config.user!, config.password!, {
    verifyTls: !args.insecure,
    fetchImpl: deps.fetchImpl,
    uploadImpl: deps.uploadImpl,
  });
  // Same reason as backup: log in immediately before the call, because the
  // endpoint wants a fresh session.
  await client.login();
  stdout.write(`Logged in to ${config.host} as ${config.user}\n\n`);

  stdout.write(`Loading Site database into ${config.host}\n`);
  stdout.write(`  <- ${source}  (${formatSize(fs.statSync(source).size)})\n`);
  try {
    await client.restoreDatabase(source);
  } catch (exc) {
    // Refused, or the outcome is unknown: the server did not visibly restart,
    // so the administrator session must not be left open.
    await client.logout().catch(() => {});
    throw exc;
  }
  // No logout after success on purpose: the server restarts on accepting the
  // dump, so the session is already gone and a DELETE would only confuse.
  stdout.write("Accepted. The server is restarting; the session ends with it.\n");
  return 0;
}

// Compare real paths: run through a symlink (npm's bin link, npx), argv[1] is
// the link while import.meta.url is the file, and a plain === never matches.
const invokedDirectly =
  process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  // exitCode, not process.exit(): exit() kills the process with stdout still
  // queued, which truncates a dump piped out with --out -.
  main().then((code) => {
    process.exitCode = code;
  });
  process.once("SIGINT", async () => {
    // Undo what the run in progress would have in its catch and finally:
    // remove its side file, end its session (given a few seconds at most).
    for (const cleanup of onInterrupt) {
      await Promise.race([
        Promise.resolve().then(cleanup).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    }
    process.exit(130);
  });
}
