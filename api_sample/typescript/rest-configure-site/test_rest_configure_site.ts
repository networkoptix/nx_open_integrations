// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for rest_configure_site.ts.
 *
 * These run with no VMS server, no Cloud account and no network: every HTTP call
 * is served by the fakes below.
 *
 * Run from this folder:  node --test test_rest_configure_site.ts
 */

import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { EventEmitter } from "node:events";
import { isDeepStrictEqual } from "node:util";

import type { FetchImpl } from "../nx-types.ts";
import {
  NxServerClient,
  NxCloudClient,
  AuthError,
  ApiError,
  ConfigError,
  ExistingSiteError,
  HttpError,
  loadEnvFile,
  resolveConfig,
  loadSettings,
  configureSite,
  cloudTarget,
  formatSummary,
  main,
  mfaCodeSource,
  parseArgs,
  type Config,
  type CloudApi,
  type CloudAuth,
  type MainDeps,
  type MfaCodeSource,
  type ServerApi,
  type Settings,
  type SiteInfo,
  type Summary,
} from "./rest_configure_site.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  /** The body is not JSON (an HTML error page, say), so json() fails. */
  notJson?: boolean;
  /** Reply headers, for example a Location on a redirect. */
  headers?: Record<string, string>;
}

interface RecordedCall {
  method: string;
  url: string;
  /** The JSON body that was sent, parsed back, or undefined when there was none. */
  body: unknown;
  headers: Record<string, string>;
}

/**
 * A fetch stand-in that records every call it receives. Replies are matched by
 * method and URL suffix, first match wins, and anything else gets an empty 200.
 * Like a real server, it answers 401 to a site/setup sent without a login.
 */
function fakeFetch(replies: Array<[string, string, FakeReply]> = []): {
  fetchImpl: FetchImpl;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = { ...((init.headers ?? {}) as Record<string, string>) };
    calls.push({ method, url, body, headers });
    const match = replies.find(([suffix, m]) => m === method && url.endsWith(suffix));
    // What a real server does: site/setup needs an administrator.
    const anonymousSetup = url.endsWith("/site/setup") && !("Authorization" in headers);
    const reply: FakeReply = anonymousSetup
      ? { status: 401, text: "Unauthorized" }
      : match
        ? match[2]
        : {};
    const status = reply.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: new Headers(reply.headers ?? {}),
      json: async () => {
        if (reply.notJson) throw new SyntaxError("Unexpected token < in JSON at position 0");
        return "json" in reply ? reply.json : {};
      },
      text: async () => reply.text ?? "",
    } as unknown as Response;
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

function makeClient(replies: Array<[string, string, FakeReply]> = []) {
  const { fetchImpl, calls } = fakeFetch(replies);
  return { client: new NxServerClient("https://server:7001", { fetchImpl }), calls };
}

function makeCloudClient(replies: Array<[string, string, FakeReply]> = []) {
  const { fetchImpl, calls } = fakeFetch(replies);
  return { client: new NxCloudClient("https://cloud.example.com", { fetchImpl }), calls };
}

/** A writable stand-in that keeps what was written, for the stdout/stderr seams. */
function capture() {
  const sink = {
    text: "",
    write(chunk: string): boolean {
      sink.text += chunk;
      return true;
    },
  };
  return sink as typeof sink & NodeJS.WritableStream;
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rest-configure-site-"));
  tmpDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** assert.rejects with a check on the class and, optionally, the message. */
async function rejectsWith(
  run: () => Promise<unknown>,
  type: new (...args: any[]) => Error,
  message?: RegExp,
): Promise<Error> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof type, `expected ${type.name}, got ${String(caught)}`);
  if (message) assert.match((caught as Error).message, message);
  return caught as Error;
}

function throwsWith(run: () => unknown, type: new (...args: any[]) => Error, message?: RegExp): Error {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof type, `expected ${type.name}, got ${String(caught)}`);
  if (message) assert.match((caught as Error).message, message);
  return caught as Error;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test("login posts credentials and stores the token", async () => {
  const { client, calls } = makeClient([["/login/sessions", "POST", { json: { token: "tok-1" } }]]);

  const token = await client.login("admin", "secret");

  assert.equal(token, "tok-1");
  assert.equal(client.token, "tok-1");
  assert.deepEqual(client.authHeaders(), { Authorization: "Bearer tok-1" });

  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { username: "admin", password: "secret" });
  assert.ok(call.url.endsWith("/rest/v4/login/sessions"));
});

for (const status of [401, 403]) {
  test(`login HTTP ${status} raises AuthError`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", { status }]]);
    await rejectsWith(() => client.login("admin", "wrong"), AuthError);
  });
}

test("login 403 says the account may not do this", async () => {
  // A 403 is not a typo in the password. The account lacks the rights.
  const { client } = makeClient([["/login/sessions", "POST", { status: 403 }]]);
  await rejectsWith(() => client.login("admin", "secret"), AuthError, /may not do this/);
});

test("login 401 points at the credentials", async () => {
  const { client } = makeClient([["/login/sessions", "POST", { status: 401 }]]);
  await rejectsWith(() => client.login("admin", "wrong"), AuthError, /user name and password/);
});

test("login without a token in the response raises ApiError", async () => {
  const { client } = makeClient([["/login/sessions", "POST", { json: {} }]]);
  await rejectsWith(() => client.login("admin", "secret"), ApiError);
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test("logout deletes the session and clears the token", async () => {
  const { client, calls } = makeClient();
  client.token = "tok-1";

  await client.logout();

  const call = calls.at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.ok(call.url.endsWith("/rest/v4/login/sessions/tok-1"));
  assert.equal(call.headers.Authorization, "Bearer tok-1");
  assert.equal(client.token, null);
  assert.deepEqual(client.authHeaders(), {});
});

test("logout without a token is a no-op", async () => {
  const { client, calls } = makeClient();
  await client.logout();
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_ENV: Record<string, string> = {
  NX_SERVER_HOST: "https://server:7001",
  NX_SERVER_PASSWORD: "admin-pass",
  NX_SITE_NAME: "My Site",
};

test("load_env_file reads pairs and skips comments, blanks and quotes", () => {
  const file = path.join(tmpDir(), "alt.env");
  fs.writeFileSync(
    file,
    '# a comment\n\nNX_SITE_NAME="Quoted Name"\nNX_SERVER_HOST=https://h:7001\n' +
      "NX_ORGANIZATION_ID = org-1\nnot a pair\n",
    "utf-8",
  );

  assert.deepEqual(loadEnvFile(file), {
    NX_SITE_NAME: "Quoted Name",
    NX_SERVER_HOST: "https://h:7001",
    NX_ORGANIZATION_ID: "org-1",
  });
});

test("load_env_file of a missing file is empty", () => {
  assert.deepEqual(loadEnvFile(path.join(tmpDir(), "missing.env")), {});
});

test("a .env path that exists but cannot be read is a config error naming it", () => {
  const dir = tmpDir();
  const error = throwsWith(() => loadEnvFile(dir), ConfigError);
  assert.ok(error.message.startsWith(`Cannot read ${dir}: `), error.message);
  assert.match(error.message, /EISDIR.*\.$/);
});

test("config reads the server and site variables", () => {
  const config = resolveConfig({}, { ...SERVER_ENV }, {});

  assert.equal(config.host, "https://server:7001");
  assert.equal(config.password, "admin-pass");
  assert.equal(config.siteName, "My Site");
});

test("CLI beats environment beats dotenv for host and password", () => {
  const dotenv = { ...SERVER_ENV };
  const env = { NX_SERVER_HOST: "https://from-env:7001" };

  assert.equal(resolveConfig({}, dotenv, env).host, "https://from-env:7001");
  assert.equal(resolveConfig({ host: "https://from-cli:7001" }, dotenv, env).host, "https://from-cli:7001");
  assert.equal(resolveConfig({}, dotenv, {}).host, "https://server:7001");

  const envPass = { NX_SERVER_PASSWORD: "env-pass" };
  assert.equal(resolveConfig({}, dotenv, envPass).password, "env-pass");
  assert.equal(resolveConfig({ password: "cli-pass" }, dotenv, envPass).password, "cli-pass");
});

test("the site name has no flag, so the environment beats dotenv", () => {
  const config = resolveConfig({}, { ...SERVER_ENV }, { NX_SITE_NAME: "From Env" });
  assert.equal(config.siteName, "From Env");
});

test("a trailing slash is stripped from the host", () => {
  const env = { ...SERVER_ENV, NX_SERVER_HOST: "https://server:7001/" };
  assert.equal(resolveConfig({}, env, {}).host, "https://server:7001");
});

const CLOUD_ENV: Record<string, string> = {
  ...SERVER_ENV,
  NX_CONNECT_TO_CLOUD: "true",
  NX_CLOUD_HOST: "https://cloud.example.com/",
  NX_CLOUD_USER: "owner@example.com",
  NX_CLOUD_PASSWORD: "cloud-pass",
};

test("connecting to the Cloud is off by default and needs no cloud values", () => {
  const config = resolveConfig({}, { ...SERVER_ENV }, {});
  assert.equal(config.connectToCloud, false);
});

for (const [text, expected] of [
  ["true", true],
  ["TRUE", true],
  ["1", true],
  ["false", false],
  ["False", false],
  ["0", false],
] as const) {
  test(`connect to cloud accepts ${text}`, () => {
    const env = { ...CLOUD_ENV, NX_CONNECT_TO_CLOUD: text };
    assert.equal(resolveConfig({}, env, {}).connectToCloud, expected);
  });
}

for (const text of ["yes", "on", "maybe", "2"]) {
  test(`connect to cloud rejects ${text}`, () => {
    const env = { ...CLOUD_ENV, NX_CONNECT_TO_CLOUD: text };
    throwsWith(() => resolveConfig({}, env, {}), ConfigError, /NX_CONNECT_TO_CLOUD/);
  });
}

for (const missing of ["NX_CLOUD_USER", "NX_CLOUD_PASSWORD"]) {
  test(`connecting without ${missing} is a config error naming it`, () => {
    const env = Object.fromEntries(Object.entries(CLOUD_ENV).filter(([name]) => name !== missing));
    throwsWith(() => resolveConfig({}, env, {}), ConfigError, new RegExp(missing));
  });
}

// A server address that is not a full URL is caught here, before any client
// exists, so nothing is sent to a half-understood address.
const BAD_URLS = ["not-a-url", "ftp://h", "https://", "https://my server:7001", "https://server:7001/a b"];

for (const bad of BAD_URLS) {
  test(`a server address of ${JSON.stringify(bad)} is a config error that quotes it`, () => {
    const expected =
      "The server address must be a full URL such as https://192.168.1.10:7001, " +
      `not ${JSON.stringify(bad)} (NX_SERVER_HOST or --host).`;

    const fromEnv = throwsWith(
      () => resolveConfig({}, { ...SERVER_ENV, NX_SERVER_HOST: bad }, {}),
      ConfigError,
    );
    assert.equal(fromEnv.message, expected);

    const fromFlag = throwsWith(() => resolveConfig({ host: bad }, { ...SERVER_ENV }, {}), ConfigError);
    assert.equal(fromFlag.message, expected);
  });
}

for (const good of ["https://h", "HTTPS://192.168.1.10:7001", "https://abc.relay.vmsproxy.com"]) {
  test(`a full https server address ${JSON.stringify(good)} is accepted`, () => {
    assert.equal(resolveConfig({}, { ...SERVER_ENV, NX_SERVER_HOST: good }, {}).host, good);
  });
}

// The server's login works over http, so the password would go out in
// cleartext, and every Bearer call after it is refused with 403.
for (const plain of ["http://h", "http://192.168.1.10:7001", "HTTP://server:7001"]) {
  test(`a plain http server address ${JSON.stringify(plain)} is a config error`, () => {
    const expected =
      "The server address must be an https:// address, because the admin password " +
      `is sent there, not ${JSON.stringify(plain)} (NX_SERVER_HOST or --host).`;

    const fromEnv = throwsWith(
      () => resolveConfig({}, { ...SERVER_ENV, NX_SERVER_HOST: plain }, {}),
      ConfigError,
    );
    assert.equal(fromEnv.message, expected);

    const fromFlag = throwsWith(() => resolveConfig({ host: plain }, { ...SERVER_ENV }, {}), ConfigError);
    assert.equal(fromFlag.message, expected);
  });
}

for (const bad of BAD_URLS) {
  test(`an NX_CLOUD_HOST of ${JSON.stringify(bad)} is a config error when connecting`, () => {
    const error = throwsWith(
      () => resolveConfig({}, { ...CLOUD_ENV, NX_CLOUD_HOST: bad }, {}),
      ConfigError,
    );
    assert.equal(
      error.message,
      `NX_CLOUD_HOST must be a full URL such as https://nxvms.com, not ${JSON.stringify(bad)}.`,
    );
  });
}

test("NX_CLOUD_HOST is not checked when the Cloud is not used", () => {
  const config = resolveConfig({}, { ...SERVER_ENV, NX_CLOUD_HOST: "not-a-url" }, {});
  assert.equal(config.connectToCloud, false);
});

test("cloud values are read when connecting", () => {
  const config = resolveConfig({}, { ...CLOUD_ENV, NX_ORGANIZATION_ID: "org-1" }, {});
  assert.equal(config.cloudHost, "https://cloud.example.com");
  assert.equal(config.cloudUser, "owner@example.com");
  assert.equal(config.cloudPassword, "cloud-pass");
  assert.equal(config.organizationId, "org-1");
});

test("the cloud host is optional and the organization defaults to null", () => {
  const env = Object.fromEntries(Object.entries(CLOUD_ENV).filter(([name]) => name !== "NX_CLOUD_HOST"));
  const config = resolveConfig({}, env, {});
  assert.equal(config.cloudHost, null);
  assert.equal(config.organizationId, null);
});

test("NX_CUSTOMIZATION is not read any more", () => {
  // The server reports its own customization, see cloudTarget.
  const config = resolveConfig({}, { ...CLOUD_ENV, NX_CUSTOMIZATION: "metavms" }, {});
  assert.ok(!("customization" in config));
});

for (const missing of ["NX_SERVER_HOST", "NX_SERVER_PASSWORD", "NX_SITE_NAME"]) {
  test(`a missing ${missing} is a config error naming it`, () => {
    const env = Object.fromEntries(Object.entries(SERVER_ENV).filter(([name]) => name !== missing));
    throwsWith(() => resolveConfig({}, env, {}), ConfigError, new RegExp(missing));
  });
}

// ---------------------------------------------------------------------------
// The whole flow, with the clients faked
// ---------------------------------------------------------------------------

type LogEntry = unknown[];

/** The log has this entry (the entries are [name, ...arguments]). */
function logHas(log: LogEntry[], entry: LogEntry): boolean {
  return log.some((candidate) => isDeepStrictEqual(candidate, entry));
}

const names = (log: LogEntry[]): unknown[] => log.map((entry) => entry[0]);

interface FakeServerOptions {
  /** What site/info answers: {} is factory-default, a localId an existing site, a cloudId a bound one. */
  info?: SiteInfo;
  fail?: string | null;
  log?: LogEntry[];
  /** Logins with one of these passwords are rejected with an AuthError. */
  rejectedPasswords?: string[];
  /**
   * Raised by the named method instead of its normal behaviour. For login it
   * applies to the login with NX_SERVER_PASSWORD only, so the factory login
   * still works; for logout to the final one main() makes.
   */
  throwOn?: Partial<Record<"getSiteInfo" | "setup" | "login" | "logout", Error>>;
}

/** Records the order of calls. `fail` names a method that raises ApiError. */
class FakeServer implements ServerApi {
  log: LogEntry[];
  info: SiteInfo;
  rejectedPasswords: string[];
  fail: string | null;
  throwOn: NonNullable<FakeServerOptions["throwOn"]>;
  token: string | null = null;
  loggedOut = false;
  host = "";
  verifyTls = true;

  constructor({ info = {}, fail = null, log, rejectedPasswords = [], throwOn = {} }: FakeServerOptions = {}) {
    this.log = log ?? [];
    // What every server reports: the Cloud it belongs to and its brand.
    this.info = { ...SERVER_BUILD, ...info };
    this.rejectedPasswords = rejectedPasswords;
    this.fail = fail;
    this.throwOn = throwOn;
  }

  _do(name: string, ...args: unknown[]): void {
    this.log.push([name, ...args]);
    if (this.fail === name) throw new ApiError(`${name} failed`);
  }

  async getSiteInfo(): Promise<SiteInfo> {
    if (this.throwOn.getSiteInfo) throw this.throwOn.getSiteInfo;
    this._do("server.get_site_info");
    return { ...this.info };
  }

  async setup(
    siteName: string,
    adminPassword: string | null,
    settings: Settings,
    cloud?: CloudAuth,
  ): Promise<void> {
    if (this.throwOn.setup) throw this.throwOn.setup;
    if (cloud === undefined) {
      this._do("server.setup", siteName, adminPassword, settings);
    } else {
      this._do("server.setup", siteName, adminPassword, settings, cloud);
    }
    if (!this.token) throw new assert.AssertionError({ message: "site/setup was called without a login" });
  }

  async login(username: string, password: string): Promise<string> {
    if (this.throwOn.login && password !== "admin") throw this.throwOn.login;
    this._do("server.login", username, password);
    if (this.rejectedPasswords.includes(password)) {
      throw new AuthError("Login rejected (HTTP 401). Check the user name and password.");
    }
    this.token = "tok";
    return this.token;
  }

  async cloudBind(authKey: string, owner: string, siteId: string, organizationId: string | null = null): Promise<void> {
    this._do("server.cloud_bind", authKey, owner, siteId, organizationId);
  }

  async applySettings(wanted: Settings): Promise<Settings> {
    this._do("server.apply_settings", wanted);
    return { statisticsAllowed: false };
  }

  async logout(): Promise<void> {
    this.log.push(["server.logout"]);
    this.token = null;
    if (this.throwOn.logout && names(this.log).includes("server.apply_settings")) {
      throw this.throwOn.logout;
    }
    this.loggedOut = true;
  }
}

const SERVER_BUILD: SiteInfo = { cloudHost: "cloud.example.com", customization: "default" };

/**
 * Also stands in for the makeCloud factory: `make` records the URL the flow
 * chose and returns the fake itself.
 */
class FakeCloud implements CloudApi {
  log: LogEntry[];
  fail: string | null;
  url: string | null = null;
  getMfaCode: MfaCodeSource | null | undefined = undefined;
  loggedOut = false;

  constructor({ fail = null, log }: { fail?: string | null; log?: LogEntry[] } = {}) {
    this.log = log ?? [];
    this.fail = fail;
  }

  make = (url: string): FakeCloud => {
    this.url = url;
    return this;
  };

  _do(name: string, ...args: unknown[]): void {
    this.log.push([name, ...args]);
    if (this.fail === name) throw new ApiError(`${name} failed`);
  }

  async login(username: string, password: string, getMfaCode: MfaCodeSource | null = null): Promise<string> {
    this._do("cloud.login", username, password);
    this.getMfaCode = getMfaCode;
    return "cloud-token";
  }

  async registerSite(siteName: string, customization: string, organizationId: string | null = null) {
    this._do("cloud.register_site", siteName, customization, organizationId);
    return { siteId: "site-id-1", authKey: "auth-key-1" };
  }

  async logout(): Promise<void> {
    this.log.push(["cloud.logout"]);
    this.loggedOut = true;
  }
}

const THREE_TRUE: Settings = {
  autoDiscoveryEnabled: true,
  cameraSettingsOptimization: true,
  statisticsAllowed: true,
};

const FLOW_CONFIG: Config = {
  host: "https://server:7001",
  password: "admin-pass",
  siteName: "My Site",
  connectToCloud: false,
};
const FLOW_CLOUD_CONFIG: Config = {
  ...FLOW_CONFIG,
  connectToCloud: true,
  cloudHost: "https://cloud.example.com",
  cloudUser: "owner@example.com",
  cloudPassword: "cloud-pass",
  organizationId: null,
};

const EXISTING: SiteInfo = { localId: "{1b2c}", name: "Front Office" };
const EXISTING_BOUND: SiteInfo = { ...EXISTING, cloudId: "cloud-site-9" };

test("a new server is set up with the factory login, then the new password", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ log });

  const summary = await configureSite(FLOW_CONFIG, THREE_TRUE, server, null);

  assert.deepEqual(names(log), [
    "server.get_site_info",
    "server.login",
    "server.setup",
    "server.logout",
    "server.login",
    "server.apply_settings",
  ]);
  assert.deepEqual(log[1], ["server.login", "admin", "admin"]);
  assert.deepEqual(log[2], ["server.setup", "My Site", "admin-pass", THREE_TRUE]);
  assert.deepEqual(log[4], ["server.login", "admin", "admin-pass"]);
  assert.equal(summary.setUp, true);
  assert.equal(summary.siteName, "My Site");
  assert.equal(summary.cloud, "not connected");
});

test("a new server whose factory login is rejected is not set up", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ log, rejectedPasswords: ["admin"] });

  await rejectsWith(() => configureSite(FLOW_CONFIG, THREE_TRUE, server, null), ApiError, /factory login/);

  assert.ok(!names(log).includes("server.setup"));
});

test("a refused setup stops the run", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ log, fail: "server.setup" });

  await rejectsWith(() => configureSite(FLOW_CONFIG, THREE_TRUE, server, null), ApiError);

  assert.ok(!names(log).includes("server.apply_settings"));
});

test("an existing site is refused without --yes and nothing is changed", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ info: EXISTING, log });

  const error = await rejectsWith(
    () => configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make),
    ExistingSiteError,
  );

  assert.deepEqual(names(log), ["server.get_site_info"]);
  assert.ok(error.message.includes("Front Office"));
  assert.ok(error.message.includes("--yes"));
});

test("an existing site with --yes is updated under its real name", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ info: EXISTING, log });

  const summary = await configureSite(FLOW_CONFIG, THREE_TRUE, server, null, true);

  assert.deepEqual(names(log), ["server.get_site_info", "server.login", "server.apply_settings"]);
  assert.deepEqual(log[1], ["server.login", "admin", "admin-pass"]);
  assert.equal(summary.setUp, false);
  assert.equal(summary.siteName, "Front Office");
});

test("an existing unbound site with --yes is registered under its real name", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ info: EXISTING, log });

  const summary = await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make, true);

  assert.ok(logHas(log, ["cloud.register_site", "Front Office", "default", null]));
  assert.equal(summary.cloud, "connected");
});

test("a site already bound to the Cloud is not registered again", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ info: EXISTING_BOUND, log });

  const summary = await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make, true);

  assert.ok(!names(log).some((name) => String(name).startsWith("cloud.")));
  assert.ok(!names(log).includes("server.cloud_bind"));
  assert.equal(summary.cloud, "already");
  assert.equal(summary.cloudId, "cloud-site-9");
});

/**
 * site/setup carries "cloud" instead of "local": no local admin password is
 * set, and the server rolls the setup back if the bind fails.
 */
test("a new cloud site is set up and bound in one site/setup", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ log });
  const cloud = new FakeCloud({ log });

  const summary = await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, cloud.make);

  // The Cloud login comes before anything on the server changes.
  assert.deepEqual(names(log), [
    "server.get_site_info",
    "cloud.login",
    "server.login",
    "cloud.register_site",
    "server.setup",
    "server.logout",
  ]);
  assert.ok(logHas(log, ["server.login", "admin", "admin"]));
  assert.ok(logHas(log, ["cloud.register_site", "My Site", "default", null]));
  assert.ok(
    logHas(log, [
      "server.setup",
      "My Site",
      null,
      THREE_TRUE,
      { authKey: "auth-key-1", owner: "owner@example.com", siteId: "site-id-1" },
    ]),
  );
  assert.equal(summary.cloud, "connected");
  assert.equal(summary.setUp, true);
  assert.equal(cloud.url, "https://cloud.example.com");
});

test("an existing site with --yes is still bound with cloud_bind", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ info: EXISTING, log });

  await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make, true);

  assert.deepEqual(names(log), [
    "server.get_site_info",
    "cloud.login",
    "server.login",
    "cloud.register_site",
    "server.cloud_bind",
    "server.apply_settings",
  ]);
  assert.ok(logHas(log, ["server.cloud_bind", "auth-key-1", "owner@example.com", "site-id-1", null]));
});

test("the flow passes the organization to both Cloud calls", async () => {
  const log: LogEntry[] = [];
  const config: Config = { ...FLOW_CLOUD_CONFIG, organizationId: "org-1" };

  await configureSite(config, THREE_TRUE, new FakeServer({ log }), new FakeCloud({ log }).make);

  assert.ok(logHas(log, ["cloud.register_site", "My Site", "default", "org-1"]));
  assert.ok(
    logHas(log, [
      "server.setup",
      "My Site",
      null,
      THREE_TRUE,
      { authKey: "auth-key-1", owner: "owner@example.com", siteId: "site-id-1", organizationId: "org-1" },
    ]),
  );
});

test("a new site is set up with the defaults for what the file leaves out", async () => {
  const log: LogEntry[] = [];
  await configureSite(FLOW_CONFIG, { statisticsAllowed: false }, new FakeServer({ log }), null);

  assert.ok(logHas(log, ["server.setup", "My Site", "admin-pass", { ...THREE_TRUE, statisticsAllowed: false }]));
  assert.ok(logHas(log, ["server.apply_settings", { statisticsAllowed: false }]));
});

test("an existing site is patched only with what the file names", async () => {
  // An administrator turned autoDiscoveryEnabled off. A file that names only
  // statisticsAllowed must not turn it back on.
  const log: LogEntry[] = [];
  await configureSite(FLOW_CONFIG, { statisticsAllowed: false }, new FakeServer({ info: EXISTING, log }), null, true);

  assert.ok(logHas(log, ["server.apply_settings", { statisticsAllowed: false }]));
});

test("an existing site with no settings named gets no settings call", async () => {
  const log: LogEntry[] = [];
  const summary = await configureSite(FLOW_CONFIG, {}, new FakeServer({ info: EXISTING, log }), null, true);

  assert.ok(!names(log).includes("server.apply_settings"));
  assert.deepEqual(summary.settingsChanged, {});
});

test("the cloud and customization come from the server", async () => {
  // A white-label server joins its own Cloud under its own customization.
  const log: LogEntry[] = [];
  const cloud = new FakeCloud({ log });
  const server = new FakeServer({
    log,
    info: { cloudHost: "cloud.brand.example", customization: "brand_x" },
  });
  const config: Config = { ...FLOW_CLOUD_CONFIG, cloudHost: null };

  const summary = await configureSite(config, THREE_TRUE, server, cloud.make);

  assert.equal(cloud.url, "https://cloud.brand.example");
  assert.ok(logHas(log, ["cloud.register_site", "My Site", "brand_x", null]));
  assert.equal(summary.cloudUrl, "https://cloud.brand.example");
});

test("NX_CLOUD_HOST naming another Cloud stops before anything changes", async () => {
  const log: LogEntry[] = [];
  const server = new FakeServer({ log, info: { cloudHost: "cloud.brand.example" } });
  const config: Config = { ...FLOW_CLOUD_CONFIG, cloudHost: "https://nxvms.com" };

  const error = await rejectsWith(
    () => configureSite(config, THREE_TRUE, server, new FakeCloud({ log }).make),
    ApiError,
  );

  assert.deepEqual(names(log), ["server.get_site_info"]);
  assert.ok(error.message.includes("https://cloud.brand.example"));
  assert.ok(error.message.includes("NX_CLOUD_HOST"));
});

test("NX_CLOUD_HOST naming the same Cloud is accepted", async () => {
  const cloud = new FakeCloud();
  const config: Config = { ...FLOW_CLOUD_CONFIG, cloudHost: "https://CLOUD.example.com" };
  await configureSite(config, THREE_TRUE, new FakeServer(), cloud.make);
  assert.equal(cloud.url, "https://cloud.example.com");
});

test("the default port in NX_CLOUD_HOST names the same Cloud", async () => {
  // https://x and https://x:443 are the same Cloud.
  const cloud = new FakeCloud();
  const config: Config = { ...FLOW_CLOUD_CONFIG, cloudHost: "https://cloud.example.com:443" };
  await configureSite(config, THREE_TRUE, new FakeServer(), cloud.make);
  assert.equal(cloud.url, "https://cloud.example.com");
});

test("another port in NX_CLOUD_HOST names another Cloud", async () => {
  const config: Config = { ...FLOW_CLOUD_CONFIG, cloudHost: "https://cloud.example.com:8443" };
  await assert.rejects(
    configureSite(config, THREE_TRUE, new FakeServer(), new FakeCloud().make),
    (error) => error instanceof ApiError && /NX_CLOUD_HOST/.test(error.message),
  );
});

for (const missing of ["cloudHost", "customization"]) {
  test(`a server that does not report its ${missing} cannot be connected`, async () => {
    const log: LogEntry[] = [];
    const server = new FakeServer({ log, info: { [missing]: "" } });
    await rejectsWith(
      () => configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make),
      ApiError,
      /cloudHost and customization/,
    );
    assert.deepEqual(names(log), ["server.get_site_info"]);
  });
}

test("a bound site needs no cloud host from the server", async () => {
  const server = new FakeServer({ info: { ...EXISTING_BOUND, cloudHost: "" } });
  const summary = await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud().make, true);
  assert.equal(summary.cloud, "already");
});

test("a rejected login with the new password is an AuthError", async () => {
  const server = new FakeServer({ rejectedPasswords: ["admin-pass"] });
  await rejectsWith(() => configureSite(FLOW_CONFIG, THREE_TRUE, server, null), AuthError);
});

test("the summary reports which settings were changed", async () => {
  const summary = await configureSite(FLOW_CONFIG, THREE_TRUE, new FakeServer(), null);
  assert.deepEqual(summary.settingsChanged, { statisticsAllowed: false });
});

for (const [failing, later] of [
  ["server.get_site_info", ["server.login", "server.setup", "cloud.login"]],
  ["server.setup", ["cloud.login", "server.apply_settings"]],
  ["server.login", ["cloud.login", "cloud.register_site", "server.apply_settings"]],
  ["cloud.login", ["cloud.register_site", "server.cloud_bind", "server.apply_settings"]],
  ["cloud.register_site", ["server.cloud_bind", "server.apply_settings"]],
] as const) {
  test(`a failing ${failing} stops the flow before the next ones`, async () => {
    const log: LogEntry[] = [];
    const server = new FakeServer({ log, fail: failing.startsWith("server.") ? failing : null });
    const cloud = new FakeCloud({ log, fail: failing.startsWith("cloud.") ? failing : null });

    await rejectsWith(() => configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, cloud.make), ApiError);

    const ran = names(log);
    assert.ok(ran.includes(failing));
    const after = ran.slice(ran.indexOf(failing) + 1);
    assert.ok(!later.some((step) => after.includes(step)));
  });
}

// ---------------------------------------------------------------------------
// The summary text
// ---------------------------------------------------------------------------

function summaryOf(overrides: Partial<Summary> = {}): Summary {
  return {
    siteName: "My Site",
    setUp: true,
    cloud: "not connected",
    cloudId: null,
    cloudUrl: null,
    settingsChanged: {},
    ...overrides,
  };
}

test("the summary names the Cloud account as owner for a personal site", () => {
  const text = formatSummary(
    FLOW_CLOUD_CONFIG,
    summaryOf({ cloud: "connected", cloudUrl: "https://cloud.example.com" }),
  );
  assert.ok(text.includes("connected to https://cloud.example.com, owned by owner@example.com"));
});

test("the summary names the organization as owner for an organization site", () => {
  const config: Config = { ...FLOW_CLOUD_CONFIG, organizationId: "org-1" };
  const text = formatSummary(
    config,
    summaryOf({ cloud: "connected", cloudUrl: "https://cloud.example.com" }),
  );
  assert.ok(text.includes("owned by organization org-1"));
  assert.ok(!text.includes("owner@example.com"));
});

test("the summary says when the site was already connected", () => {
  const text = formatSummary(FLOW_CLOUD_CONFIG, summaryOf({ cloud: "already", cloudId: "cloud-site-9" }));
  assert.ok(text.includes("already connected (Cloud id cloud-site-9)"));
});

test("the summary uses the real site name of an existing site", () => {
  const text = formatSummary(FLOW_CONFIG, summaryOf({ siteName: "Front Office", setUp: false }));
  assert.ok(text.includes("Site name       : Front Office"));
  assert.ok(!text.includes("My Site"));
  assert.ok(text.includes("already belonged to a site"));
});

test("the summary says when nothing is connected or changed", () => {
  const text = formatSummary(FLOW_CONFIG, summaryOf());
  assert.ok(text.includes("not connected"));
  assert.ok(text.includes("none"));
});

test("the summary lists changed settings with lowercase values", () => {
  const text = formatSummary(FLOW_CONFIG, summaryOf({ settingsChanged: { statisticsAllowed: false } }));
  assert.ok(text.includes("statisticsAllowed=false"));
});

// ---------------------------------------------------------------------------
// main(): exit codes and output
// ---------------------------------------------------------------------------

interface Fakes {
  log: LogEntry[];
  server: FakeServer | null;
  cloud: FakeCloud | null;
  info: SiteInfo;
  serverFail: string | null;
  cloudFail: string | null;
  serverThrowOn: FakeServerOptions["throwOn"];
  out: ReturnType<typeof capture>;
  err: ReturnType<typeof capture>;
  deps: MainDeps;
}

/** Swap the real clients for fakes that share one call log. */
function makeFakes(): Fakes {
  const fakes: Fakes = {
    log: [],
    server: null,
    cloud: null,
    info: {},
    serverFail: null,
    cloudFail: null,
    serverThrowOn: {},
    out: capture(),
    err: capture(),
    deps: {},
  };
  fakes.deps = {
    env: {},
    stdout: fakes.out,
    stderr: fakes.err,
    makeServer: (host, verifyTls) => {
      fakes.server = new FakeServer({
        info: fakes.info,
        log: fakes.log,
        fail: fakes.serverFail,
        throwOn: fakes.serverThrowOn,
      });
      fakes.server.host = host;
      fakes.server.verifyTls = verifyTls;
      return fakes.server;
    },
    makeCloud: (url) => {
      fakes.cloud = new FakeCloud({ log: fakes.log, fail: fakes.cloudFail });
      return fakes.cloud.make(url);
    },
  };
  return fakes;
}

function writeEnvFile(dir: string, values: Record<string, string>): string {
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, Object.entries(values).map(([k, v]) => `${k}=${v}`).join("\n"), "utf-8");
  return file;
}

function writeSettingsFile(dir: string, text: string): string {
  const file = path.join(dir, "site_settings.json");
  fs.writeFileSync(file, text, "utf-8");
  return file;
}

/** A settings path that does not exist, so main() uses the defaults. */
const noSettings = (dir: string): string => path.join(dir, "none.json");

/** A settings file that names one setting, so the settings step runs. */
const oneSetting = (dir: string): string => writeSettingsFile(dir, '{"statisticsAllowed": false}');

test("main runs the flow, prints a summary and exits 0", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", oneSetting(dir)],
    fakes.deps,
  );

  assert.equal(code, 0);
  assert.ok(fakes.out.text.includes("My Site"));
  assert.ok(fakes.out.text.includes("statisticsAllowed"));
  assert.equal(fakes.server!.loggedOut, true);
  assert.equal(fakes.server!.host, "https://server:7001");
});

test("main with a missing required value exits 2 and runs nothing", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  const env = Object.fromEntries(Object.entries(SERVER_ENV).filter(([name]) => name !== "NX_SITE_NAME"));

  const code = await main(["--dotenv", writeEnvFile(dir, env)], fakes.deps);

  assert.equal(code, 2);
  assert.ok(fakes.err.text.includes("NX_SITE_NAME"));
  assert.deepEqual(fakes.log, []);
});

test("main with a server address that is not a URL exits 2 before any client is built", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir), "--host", "not-a-url"],
    fakes.deps,
  );

  assert.equal(code, 2);
  assert.equal(
    fakes.err.text,
    "ERROR: The server address must be a full URL such as https://192.168.1.10:7001, " +
      'not "not-a-url" (NX_SERVER_HOST or --host).\n',
  );
  assert.equal(fakes.server, null);
  assert.deepEqual(fakes.log, []);
});

test("main with an NX_CLOUD_HOST that is not a URL exits 2 before any client is built", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  const env = { ...CLOUD_ENV, NX_CLOUD_HOST: "ftp://h" };

  const code = await main(["--dotenv", writeEnvFile(dir, env), "--settings-file", noSettings(dir)], fakes.deps);

  assert.equal(code, 2);
  assert.equal(
    fakes.err.text,
    'ERROR: NX_CLOUD_HOST must be a full URL such as https://nxvms.com, not "ftp://h".\n',
  );
  assert.equal(fakes.server, null);
  assert.equal(fakes.cloud, null);
});

test("main with a .env path that cannot be read exits 2 and runs nothing", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();

  const code = await main(["--dotenv", dir, "--settings-file", noSettings(dir)], fakes.deps);

  assert.equal(code, 2);
  assert.ok(fakes.err.text.startsWith(`ERROR: Cannot read ${dir}: `), fakes.err.text);
  assert.ok(fakes.err.text.endsWith(".\n"), fakes.err.text);
  assert.equal(fakes.server, null);
});

test("main with a settings file that cannot be read exits 2 and runs nothing", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  const settingsDir = path.join(dir, "settings-dir");
  fs.mkdirSync(settingsDir);

  const code = await main(["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", settingsDir], fakes.deps);

  assert.equal(code, 2);
  assert.ok(fakes.err.text.startsWith(`ERROR: Cannot read ${settingsDir}: `), fakes.err.text);
  assert.ok(!fakes.err.text.includes("not found"), fakes.err.text);
  assert.equal(fakes.server, null);
});

test("main with no .env file at the given path reads the environment and runs", async () => {
  // A missing .env is not an error: the values may all be in the environment.
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.deps.env = { ...SERVER_ENV };

  const code = await main(
    ["--dotenv", path.join(dir, "missing.env"), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 0, fakes.err.text);
  assert.ok(fakes.err.text.includes("not found. A new site gets the default settings"));
});

test("main with an unsupported setting exits 2 and runs nothing", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  const settings = writeSettingsFile(dir, '{"auditTrailEnabled": true}');

  const code = await main(["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", settings], fakes.deps);

  assert.equal(code, 2);
  assert.ok(fakes.err.text.includes("auditTrailEnabled"));
  assert.deepEqual(fakes.log, []);
});

test("main says so when the settings file is not found", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();

  await main(["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", path.join(dir, "typo.json")], fakes.deps);

  assert.ok(fakes.err.text.includes("typo.json"));
});

for (const failing of ["server.get_site_info", "server.setup", "server.login", "server.apply_settings"]) {
  test(`main exits 1 when ${failing} fails and still logs out`, async () => {
    const dir = tmpDir();
    const fakes = makeFakes();
    fakes.serverFail = failing;

    const code = await main(
      ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", oneSetting(dir)],
      fakes.deps,
    );

    assert.equal(code, 1);
    assert.ok(fakes.err.text.includes(`${failing} failed`));
    assert.equal(fakes.server!.loggedOut, true);
  });
}

for (const failing of ["cloud.login", "cloud.register_site"]) {
  test(`main exits 1 when ${failing} fails and still logs out`, async () => {
    const dir = tmpDir();
    const fakes = makeFakes();
    fakes.cloudFail = failing;

    const code = await main(
      ["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--settings-file", noSettings(dir)],
      fakes.deps,
    );

    assert.equal(code, 1);
    assert.equal(fakes.server!.loggedOut, true);
  });
}

test("main exits 1 on a rejected login", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.serverThrowOn = {
    login: new AuthError("Login forbidden (HTTP 403). This account may not do this."),
  };

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 1);
  assert.ok(fakes.err.text.includes("may not do this"));
});

test("main exits 1 with a hint when the server is unreachable", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.serverThrowOn = {
    getSiteInfo: new TypeError("fetch failed", {
      cause: Object.assign(new Error("no route"), { code: "ECONNREFUSED" }),
    }),
  };

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 1);
  assert.ok(fakes.err.text.includes("https://server:7001"));
});

test("main exits 1 naming the host when a request gets a status it does not handle", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.serverThrowOn = {
    login: new HttpError(500, "POST", "https://server:7001/rest/v4/login/sessions"),
  };

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 1);
  assert.ok(
    fakes.err.text.endsWith(
      "\nERROR: could not complete a request to https://server:7001: " +
        "HTTP 500\n",
    ),
    fakes.err.text,
  );
  assert.equal(fakes.server!.loggedOut, true);
});

test("main exits 1 naming the host on a socket error that carries its own code", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.serverThrowOn = {
    setup: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  };

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 1);
  assert.ok(
    fakes.err.text.endsWith(
      "\nERROR: could not complete a request to https://server:7001: read ECONNRESET\n",
    ),
    fakes.err.text,
  );
});

test("main rethrows an error it does not recognise, so a bug shows its stack trace", async () => {
  // No catch-all: only login, API, TLS and request failures become exit 1.
  const dir = tmpDir();
  const fakes = makeFakes();
  const bug = new RangeError("a bug in the sample");
  fakes.serverThrowOn = { setup: bug };

  let caught: unknown;
  try {
    await main(["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)], fakes.deps);
  } catch (error) {
    caught = error;
  }

  assert.equal(caught, bug);
  assert.ok(!fakes.err.text.includes("ERROR"), fakes.err.text);
  // The session is still released on the way out.
  assert.equal(fakes.server!.loggedOut, true);
});

test("main suggests --insecure on a certificate error", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.serverThrowOn = {
    getSiteInfo: Object.assign(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("self signed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
      }),
      { url: "https://server:7001/rest/v4/site/info" },
    ),
  };

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 1);
  assert.ok(
    fakes.err.text.endsWith(
      "ERROR: certificate verification failed for https://server:7001. A local " +
        "server uses a self-signed certificate, so add --insecure.\n",
    ),
    fakes.err.text,
  );
});

test("a cloud certificate failure does not suggest --insecure", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  // The real Cloud client, so send() attaches the url to fetch's error.
  delete fakes.deps.makeCloud;
  fakes.deps.fetchImpl = (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("unable to get local issuer certificate"), {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      }),
    });
  }) as unknown as MainDeps["fetchImpl"];

  const code = await main(
    ["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  const err = fakes.err.text;
  assert.equal(code, 1);
  assert.ok(err.includes("certificate verification failed for https://cloud.example.com."), err);
  assert.ok(err.includes("--insecure applies to the server only"), err);
  assert.ok(!err.includes("so add --insecure"), err);
});

test("a TLS error that is not a certificate failure is reported as it is", async () => {
  // For example https pointed at an http port: --insecure would not help.
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.serverThrowOn = {
    getSiteInfo: Object.assign(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("wrong version number"), { code: "ERR_SSL_WRONG_VERSION_NUMBER" }),
      }),
      { url: "https://server:7001/rest/v4/site/info" },
    ),
  };

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  const err = fakes.err.text;
  assert.equal(code, 1);
  assert.ok(err.includes("ERROR: could not complete a request to https://server:7001: "), err);
  assert.ok(err.includes("wrong version number"), err);
  assert.ok(!err.includes("--insecure"), err);
});

test("a failed logout is not fatal", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.serverThrowOn = {
    logout: new TypeError("fetch failed", { cause: new Error("gone") }),
  };

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", oneSetting(dir)],
    fakes.deps,
  );

  assert.equal(code, 0);
});

test("--insecure turns TLS verification off for the server only", async () => {
  const dir = tmpDir();
  const envFile = writeEnvFile(dir, SERVER_ENV);
  const none = noSettings(dir);
  const fakes = makeFakes();

  await main(["--dotenv", envFile, "--settings-file", none], fakes.deps);
  assert.equal(fakes.server!.verifyTls, true);

  await main(["--dotenv", envFile, "--settings-file", none, "--insecure"], fakes.deps);
  assert.equal(fakes.server!.verifyTls, false);
});

test("main refuses an existing site without --yes and exits 1", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.info = EXISTING;

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 1);
  assert.ok(fakes.err.text.includes("--yes"));
  assert.deepEqual(names(fakes.log), ["server.get_site_info", "server.logout"]);
});

test("main with --yes updates an existing site", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  fakes.info = EXISTING;

  const code = await main(
    ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", oneSetting(dir), "--yes"],
    fakes.deps,
  );

  assert.equal(code, 0, fakes.err.text);
  assert.ok(fakes.out.text.includes("Front Office"));
  assert.ok(names(fakes.log).includes("server.apply_settings"));
});

test("main connects to the Cloud only when asked", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();

  await main(["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)], fakes.deps);

  assert.equal(fakes.cloud, null);
});

test("main with the Cloud prints the owner", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();

  const code = await main(
    ["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 0);
  assert.ok(fakes.out.text.includes("connected to https://cloud.example.com, owned by owner@example.com"));
});

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

test("a missing settings file names no settings", () => {
  assert.deepEqual(loadSettings(path.join(tmpDir(), "no-such-file.json")), {});
});

for (const name of ["autoDiscoveryEnabled", "cameraSettingsOptimization", "statisticsAllowed"]) {
  test(`a false for ${name} goes out as false under the same name`, () => {
    // The wire field name is the key in the file, unchanged.
    const file = writeSettingsFile(tmpDir(), `{"${name}": false}`);

    assert.deepEqual(loadSettings(file), { [name]: false });
  });
}

for (const value of ['"false"', "0", "1", "null", "[]"]) {
  test(`a non-boolean value ${value} is a config error`, () => {
    const file = writeSettingsFile(tmpDir(), `{"autoDiscoveryEnabled": ${value}}`);
    throwsWith(() => loadSettings(file), ConfigError, /autoDiscoveryEnabled/);
  });
}

for (const value of ['"false"', "null", "1", "[]"]) {
  test(`the message for a non-boolean ${value} shows the value as JSON text`, () => {
    // "false" in quotes is a string, and the quotes in the message say so.
    const file = writeSettingsFile(tmpDir(), `{"statisticsAllowed": ${value}}`);
    const error = throwsWith(() => loadSettings(file), ConfigError);
    assert.equal(error.message, `statisticsAllowed must be true or false, not ${value}.`);
  });
}

test("a settings path that exists but cannot be read is a config error naming it", () => {
  const dir = tmpDir();
  const error = throwsWith(() => loadSettings(dir), ConfigError);
  assert.ok(error.message.startsWith(`Cannot read ${dir}: `), error.message);
  assert.match(error.message, /EISDIR.*\.$/);
});

test("an unsupported setting is a config error that points at the README", () => {
  const file = writeSettingsFile(tmpDir(), '{"auditTrailEnabled": true}');
  const error = throwsWith(() => loadSettings(file), ConfigError);
  assert.ok(error.message.includes("auditTrailEnabled"));
  assert.ok(error.message.includes("README"));
});

for (const text of ["{not json", "[true, false]", '"text"']) {
  test(`a settings file that is not a JSON object (${text}) is a config error`, () => {
    const file = writeSettingsFile(tmpDir(), text);
    throwsWith(() => loadSettings(file), ConfigError, /JSON/);
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** A server client that is logged in, so it sends a bearer header. */
function loggedInClient(replies: Array<[string, string, FakeReply]> = []) {
  const made = makeClient(replies);
  made.client.token = "tok-1";
  return made;
}

test("get_site_info needs no login and returns the reply", async () => {
  const info = { name: "Front Office", localId: "{1b2c}" };
  const { client, calls } = makeClient([["/site/info", "GET", { json: info }]]);

  assert.deepEqual(await client.getSiteInfo(), info);
  const call = calls[0]!;
  assert.equal(call.method, "GET");
  assert.ok(call.url.endsWith("/rest/v4/site/info"));
  assert.equal(call.headers.Authorization, undefined);
});

test("a site info reply that is not a JSON object is an ApiError", async () => {
  const { client } = makeClient([["/site/info", "GET", { json: ["x"] }]]);
  await rejectsWith(() => client.getSiteInfo(), ApiError);
});

test("setup without a login is refused before anything is sent", async () => {
  // site/setup needs an administrator, so an anonymous call cannot work.
  const { client, calls } = makeClient();
  await rejectsWith(() => client.setup("My Site", "admin-pass", THREE_TRUE), ApiError, /Not logged in/);
  assert.deepEqual(calls, []);
});

test("the fake server refuses an anonymous setup like a real one", async () => {
  const { client } = makeClient();
  client.token = "tok-1";
  client.authHeaders = () => ({});
  await rejectsWith(() => client.setup("My Site", "admin-pass", THREE_TRUE), ApiError, /401/);
});

test("setup posts name, password and settings with the bearer token", async () => {
  const { client, calls } = loggedInClient();

  await client.setup("My Site", "admin-pass", THREE_TRUE);

  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/rest/v4/site/setup"));
  assert.equal(call.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(call.body, {
    name: "My Site",
    local: { password: "admin-pass" },
    settings: THREE_TRUE,
  });
});

for (const status of [400, 401, 403, 409, 422, 500, 503]) {
  test(`a refused setup (HTTP ${status}) raises with its status and body`, async () => {
    const { client } = loggedInClient([["/site/setup", "POST", { status, text: "password too weak" }]]);

    const error = await rejectsWith(() => client.setup("My Site", "admin-pass", THREE_TRUE), ApiError);

    assert.ok(error.message.includes(String(status)));
    assert.ok(error.message.includes("password too weak"));
  });
}

test("setup keeps only the start of a long error body", async () => {
  const { client } = loggedInClient([["/site/setup", "POST", { status: 400, text: "x".repeat(5000) }]]);
  const error = await rejectsWith(() => client.setup("My Site", "admin-pass", THREE_TRUE), ApiError);
  assert.ok(error.message.length < 400);
});

test("get_settings returns the settings object", async () => {
  const current = { siteName: "My Site", autoDiscoveryEnabled: false };
  const { client, calls } = makeClient([["/site/settings", "GET", { json: current }]]);
  client.token = "tok-1";

  assert.deepEqual(await client.getSettings(), current);

  const call = calls[0]!;
  assert.equal(call.method, "GET");
  assert.ok(call.url.endsWith("/rest/v4/site/settings"));
});

test("get_settings without login raises", async () => {
  await rejectsWith(() => makeClient().client.getSettings(), ApiError);
});

test("apply_settings patches only the settings that differ", async () => {
  const current = {
    autoDiscoveryEnabled: true,
    cameraSettingsOptimization: false,
    statisticsAllowed: true,
  };
  const { client, calls } = makeClient([["/site/settings", "GET", { json: current }]]);
  client.token = "tok-1";

  const changed = await client.applySettings(THREE_TRUE);

  assert.deepEqual(changed, { cameraSettingsOptimization: true });
  const call = calls.at(-1)!;
  assert.equal(call.method, "PATCH");
  assert.ok(call.url.endsWith("/rest/v4/site/settings"));
  assert.deepEqual(call.body, { cameraSettingsOptimization: true });
});

test("cloud_bind sends key, owner and site id", async () => {
  const { client, calls } = makeClient();
  client.token = "tok-1";

  await client.cloudBind("auth-key-1", "owner@example.com", "site-id-1");

  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/rest/v4/cloud/bind"));
  assert.deepEqual(call.body, {
    authKey: "auth-key-1",
    owner: "owner@example.com",
    siteId: "site-id-1",
  });
});

test("cloud_bind without login raises", async () => {
  await rejectsWith(() => makeClient().client.cloudBind("k", "o@example.com", "s"), ApiError);
});

test("cloud login requests a cloud-wide bearer token", async () => {
  const { client, calls } = makeCloudClient([
    ["/cdb/oauth2/token", "POST", { json: { access_token: "nxcdb-1" } }],
  ]);

  const token = await client.login("owner@example.com", "cloud-pass");

  assert.equal(token, "nxcdb-1");
  assert.deepEqual(client.authHeaders(), { Authorization: "Bearer nxcdb-1" });
  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://cloud.example.com/cdb/oauth2/token");
  assert.deepEqual(call.body, {
    grant_type: "password",
    response_type: "token",
    client_id: "3rdParty",
    username: "owner@example.com",
    password: "cloud-pass",
  });
  assert.ok(!("scope" in (call.body as object)), "a scoped token cannot register a new site");
});

for (const status of [401, 403]) {
  test(`cloud login ${status} raises AuthError`, async () => {
    const { client } = makeCloudClient([["/cdb/oauth2/token", "POST", { status }]]);
    await rejectsWith(() => client.login("owner@example.com", "wrong"), AuthError, /Cloud/);
  });
}

test("cloud login without an access_token raises ApiError", async () => {
  const { client } = makeCloudClient([["/cdb/oauth2/token", "POST", { json: {} }]]);
  await rejectsWith(() => client.login("owner@example.com", "cloud-pass"), ApiError);
  assert.deepEqual(client.authHeaders(), {});
});

const REGISTERED = { id: "site-id-1", authKey: "auth-key-1", name: "My Site" };

test("register_site for a personal account has no organizationId", async () => {
  const { client, calls } = makeCloudClient([["/cdb/systems/bind", "POST", { json: REGISTERED }]]);
  client.token = "nxcdb-1";

  const result = await client.registerSite("My Site", "default");

  assert.deepEqual(result, { siteId: "site-id-1", authKey: "auth-key-1" });
  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://cloud.example.com/cdb/systems/bind");
  assert.deepEqual(call.body, { name: "My Site", customization: "default", opaque: "" });
  assert.ok(!("organizationId" in (call.body as object)));
});

test("register_site for an organization uses the partners api", async () => {
  const { client, calls } = makeCloudClient([
    ["/partners/api/v3/cloud_systems/", "POST", { json: REGISTERED }],
  ]);
  client.token = "nxcdb-1";

  const result = await client.registerSite("My Site", "default", "org-1");

  assert.deepEqual(result, { siteId: REGISTERED.id, authKey: REGISTERED.authKey });
  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://cloud.example.com/partners/api/v3/cloud_systems/");
  assert.deepEqual(call.body, {
    name: "My Site",
    customization: "default",
    opaque: "",
    organization: "org-1",
  });
});

/**
 * The server's cloud/bind requires owner, also with an organizationId
 * ("Missing required parameter: owner" otherwise).
 */
test("cloud_bind for an organization still sends the owner", async () => {
  const { client, calls } = makeClient();
  client.token = "tok-1";

  await client.cloudBind("auth-key-1", "owner@example.com", "site-id-1", "org-1");

  assert.deepEqual(calls[0]!.body, {
    authKey: "auth-key-1",
    owner: "owner@example.com",
    siteId: "site-id-1",
    organizationId: "org-1",
  });
});

test("register_site without login raises", async () => {
  await rejectsWith(() => makeCloudClient().client.registerSite("My Site", "default"), ApiError);
});

for (const payload of [{}, { id: "site-id-1" }, { authKey: "k" }]) {
  test(`register_site reply ${JSON.stringify(payload)} raises ApiError`, async () => {
    const { client } = makeCloudClient([["/cdb/systems/bind", "POST", { json: payload }]]);
    client.token = "nxcdb-1";
    await rejectsWith(() => client.registerSite("My Site", "default"), ApiError);
  });
}

test("apply_settings sends nothing when everything already matches", async () => {
  const { client, calls } = makeClient([["/site/settings", "GET", { json: { ...THREE_TRUE } }]]);
  client.token = "tok-1";

  assert.deepEqual(await client.applySettings(THREE_TRUE), {});
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

// ---------------------------------------------------------------------------
// Replies that are not JSON (a proxy's HTML error page, a cut-off body)
// ---------------------------------------------------------------------------

test("a server login reply that is not JSON raises ApiError", async () => {
  const { client } = makeClient([["/login/sessions", "POST", { notJson: true }]]);
  const error = await rejectsWith(() => client.login("admin", "secret"), ApiError);
  assert.equal(error.message, "Login response was not valid JSON.");
  assert.equal(client.token, null);
});

test("a settings reply that is not JSON raises ApiError", async () => {
  const { client, calls } = makeClient([["/site/settings", "GET", { notJson: true }]]);
  client.token = "tok-1";
  const error = await rejectsWith(() => client.applySettings(THREE_TRUE), ApiError);
  assert.equal(error.message, "Settings response was not valid JSON.");
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("a Cloud login reply that is not JSON raises ApiError", async () => {
  const { client } = makeCloudClient([["/cdb/oauth2/token", "POST", { notJson: true }]]);
  const error = await rejectsWith(() => client.login("owner@example.com", "cloud-pass"), ApiError);
  assert.equal(error.message, "Cloud login response was not valid JSON.");
  assert.equal(client.token, null);
});

test("a Cloud bind reply that is not JSON raises ApiError", async () => {
  const { client } = makeCloudClient([["/cdb/systems/bind", "POST", { notJson: true }]]);
  client.token = "nxcdb-1";
  const error = await rejectsWith(() => client.registerSite("My Site", "default"), ApiError);
  assert.equal(error.message, "Cloud bind reply was not valid JSON.");
});

// ---------------------------------------------------------------------------
// The transport: --insecure reaches the server only
// ---------------------------------------------------------------------------

interface TransportCall {
  host: string;
  rejectUnauthorized: unknown;
}

/**
 * Replace https.request for the duration of `run`, so the real transports can
 * be exercised with no network. Every request is answered by `answer` and its
 * TLS option is recorded.
 */
async function withFakeHttps(
  answer: (url: URL) => { status?: number; json?: unknown; headers?: Record<string, string> },
  run: (calls: TransportCall[]) => Promise<void>,
): Promise<void> {
  const calls: TransportCall[] = [];
  const mutable = https as unknown as { request: unknown };
  const original = mutable.request;
  mutable.request = (
    target: URL,
    options: { rejectUnauthorized: unknown },
    onResponse: (res: EventEmitter) => void,
  ) => {
    calls.push({ host: target.host, rejectUnauthorized: options.rejectUnauthorized });
    const reply = answer(target);
    const req = Object.assign(new EventEmitter(), {
      setTimeout: () => req,
      destroy: () => req,
      end: () => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: reply.status ?? 200,
          headers: reply.headers ?? {},
        });
        onResponse(res);
        res.emit("data", Buffer.from(JSON.stringify(reply.json ?? {})));
        res.emit("end");
      },
    });
    return req;
  };
  try {
    await run(calls);
  } finally {
    mutable.request = original;
  }
}

test("the Cloud client's own transport verifies TLS", async () => {
  await withFakeHttps(
    () => ({ json: { access_token: "nxcdb-1" } }),
    async (calls) => {
      await new NxCloudClient("https://cloud.example.com").login("owner@example.com", "cloud-pass");
      assert.deepEqual(calls, [{ host: "cloud.example.com", rejectUnauthorized: true }]);
    },
  );
});

test("the server client's transport skips TLS verification only when told to", async () => {
  await withFakeHttps(
    () => ({ json: { token: "tok-1" } }),
    async (calls) => {
      await new NxServerClient("https://server:7001").login("admin", "pw");
      await new NxServerClient("https://server:7001", { verifyTls: false }).login("admin", "pw");
      assert.deepEqual(calls.map((call) => call.rejectUnauthorized), [true, false]);
    },
  );
});

test("with --insecure the real clients skip verification for the server, never for the Cloud", async () => {
  const dir = tmpDir();
  const out = capture();
  const err = capture();
  let revoked: string | null = null;
  const answer = (url: URL): { status?: number; json?: unknown } => {
    if (url.pathname.startsWith("/cdb/oauth2/token/")) {
      revoked = url.pathname; // the DELETE that revokes the Cloud token
      return {};
    }
    if (url.pathname.endsWith("/site/info")) return { json: SERVER_BUILD };
    if (url.pathname.endsWith("/login/sessions")) return { json: { token: "tok-1" } };
    if (url.pathname.endsWith("/oauth2/token")) return { json: { access_token: "nxcdb-1" } };
    if (url.pathname.endsWith("/systems/bind")) return { json: { id: "site-id-1", authKey: "auth-key-1" } };
    return {};
  };

  await withFakeHttps(answer, async (calls) => {
    const code = await main(
      ["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--settings-file", noSettings(dir), "--insecure"],
      { env: {}, stdout: out, stderr: err },
    );
    assert.equal(code, 0, err.text);

    const verifyFor = (host: string) =>
      new Set(calls.filter((call) => call.host === host).map((call) => call.rejectUnauthorized));
    assert.deepEqual([...verifyFor("server:7001")], [false]);
    assert.deepEqual([...verifyFor("cloud.example.com")], [true]);
    assert.equal(revoked, "/cdb/oauth2/token/nxcdb-1");
  });
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test("--dotenv is the config flag here, not --env-file", () => {
  assert.equal(parseArgs(["--dotenv", "../../.env"]).envFile, "../../.env");
  assert.throws(() => parseArgs(["--env-file", "../../.env"]), /Unknown argument: --env-file/);
});

test("parseArgs reads every flag and defaults the rest", () => {
  const args = parseArgs([
    "--host", "https://h:7001", "--password", "pw", "--dotenv", "my.env",
    "--settings-file", "s.json", "--insecure", "--mfa-code", "123456", "--yes",
  ]);
  assert.equal(args.host, "https://h:7001");
  assert.equal(args.password, "pw");
  assert.equal(args.envFile, "my.env");
  assert.equal(args.settingsFile, "s.json");
  assert.equal(args.insecure, true);
  assert.equal(args.mfaCode, "123456");
  assert.equal(args.yes, true);
  assert.equal(args.help, false);

  const defaults = parseArgs([]);
  assert.equal(defaults.host, null);
  assert.equal(defaults.password, null);
  assert.equal(defaults.envFile, ".env");
  assert.ok(defaults.settingsFile.endsWith("site_settings.json"));
  assert.equal(defaults.insecure, false);
  assert.equal(defaults.mfaCode, null);
  assert.equal(defaults.yes, false);
  assert.equal(defaults.help, false);
});

test("--flag=value works for every flag that takes a value", () => {
  const args = parseArgs([
    "--host=https://h:7001", "--password=pw", "--dotenv=my.env", "--settings-file=s.json",
    "--mfa-code=123456",
  ]);
  assert.equal(args.host, "https://h:7001");
  assert.equal(args.password, "pw");
  assert.equal(args.envFile, "my.env");
  assert.equal(args.settingsFile, "s.json");
  assert.equal(args.mfaCode, "123456");
});

test("a value may itself contain an equals sign", () => {
  assert.equal(parseArgs(["--password=a=b"]).password, "a=b");
});

for (const flag of ["--host", "--password", "--dotenv", "--settings-file", "--mfa-code"]) {
  test(`${flag} without a value is an error`, () => {
    assert.throws(() => parseArgs([flag]), new RegExp(`Missing value for ${flag}`));
  });
}

test("--insecure and --yes take no value", () => {
  assert.throws(() => parseArgs(["--insecure=true"]), /--insecure takes no value/);
  assert.throws(() => parseArgs(["--yes=true"]), /--yes takes no value/);
});

test("an unknown flag is an error that names it", () => {
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument: --bogus/);
  assert.throws(() => parseArgs(["-x"]), /Unknown argument: -x/);
});

test("a stray positional argument is an error that names it", () => {
  assert.throws(() => parseArgs(["extra"]), /Unexpected argument: extra/);
});

test("-h and --help both ask for the usage text", () => {
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);
});

test("a bad command line exits 2, prints the problem and the usage, and runs nothing", async () => {
  for (const argv of [["--password"], ["--bogus"], ["--insecure=1"], ["extra"]]) {
    const fakes = makeFakes();

    const code = await main(argv, fakes.deps);

    assert.equal(code, 2, JSON.stringify(argv));
    assert.match(fakes.err.text, /Usage:/);
    assert.equal(fakes.out.text, "");
    assert.deepEqual(fakes.log, []);
  }
});

for (const [argv, message] of [
  [["extra"], "Unexpected argument: extra"],
  [["--bogus"], "Unknown argument: --bogus"],
  [["--password"], "Missing value for --password"],
  [["--insecure=1"], "--insecure takes no value"],
] as const) {
  test(`a bad command line (${argv.join(" ")}) prints ERROR: and the message on its own line, then the usage`, async () => {
    const fakes = makeFakes();

    const code = await main([...argv], fakes.deps);

    assert.equal(code, 2);
    assert.ok(
      fakes.err.text.startsWith(`ERROR: ${message}\nUsage:\n`),
      `stderr was: ${fakes.err.text}`,
    );
  });
}

test("--help prints the usage on stdout, exits 0 and runs nothing", async () => {
  const fakes = makeFakes();

  const code = await main(["--help"], fakes.deps);

  assert.equal(code, 0);
  assert.match(fakes.out.text, /Usage:/);
  assert.match(fakes.out.text, /--dotenv/);
  assert.equal(fakes.err.text, "");
  assert.deepEqual(fakes.log, []);
});

// ---------------------------------------------------------------------------
// Redirects, non-object replies, broken addresses, Cloud safety
// ---------------------------------------------------------------------------

for (const status of [301, 302, 303, 307, 308]) {
  test(`a redirect (HTTP ${status}) is an error and is not followed`, async () => {
    // Following it could turn a POST into a GET that "succeeds".
    await withFakeHttps(
      () => ({ status, headers: { location: "https://elsewhere/" } }),
      async (calls) => {
        const client = new NxServerClient("https://server:7001");
        client.token = "tok-1";

        const error = await rejectsWith(() => client.setup("My Site", "admin-pass", THREE_TRUE), ApiError);

        assert.deepEqual(calls.map((call) => call.host), ["server:7001"]);
        assert.ok(error.message.includes(`HTTP ${status}`), error.message);
        assert.ok(error.message.includes("to https://elsewhere)"), error.message);
        assert.ok(error.message.startsWith("https://server:7001 answered with a redirect"), error.message);
        assert.ok(!error.message.includes("/rest"), error.message);
      },
    );
  });
}

test("the Cloud client refuses redirects too", async () => {
  await withFakeHttps(
    () => ({ status: 302, headers: { location: "https://x/" } }),
    async () => {
      const cloud = new NxCloudClient("https://cloud.example.com");
      await rejectsWith(() => cloud.login("owner@example.com", "cloud-pass"), ApiError, /redirect/);
    },
  );
});

for (const body of [[], [1], null, "text", 5]) {
  test(`a reply that is JSON but not an object (${JSON.stringify(body)}) is an ApiError`, async () => {
    const { client } = loggedInClient([["/site/settings", "GET", { json: body }]]);
    await rejectsWith(() => client.getSettings(), ApiError, /Settings response was not a JSON object/);
  });
}

test("a login reply of null is an ApiError, not a crash", async () => {
  const { client } = makeClient([["/login/sessions", "POST", { json: null }]]);
  await rejectsWith(() => client.login("admin", "pw"), ApiError, /Login response was not a JSON object/);
});

test("a site info reply of null is an ApiError, not a crash", async () => {
  const { client } = makeClient([["/site/info", "GET", { json: null }]]);
  await rejectsWith(() => client.getSiteInfo(), ApiError, /Site info response was not a JSON object/);
});

test("Cloud replies of null are ApiErrors, not crashes", async () => {
  const login = makeCloudClient([["/cdb/oauth2/token", "POST", { json: null }]]);
  await rejectsWith(
    () => login.client.login("owner@example.com", "cloud-pass"),
    ApiError,
    /Cloud login response was not a JSON object/,
  );
  const bind = makeCloudClient([["/cdb/systems/bind", "POST", { json: null }]]);
  bind.client.token = "t";
  await rejectsWith(
    () => bind.client.registerSite("My Site", "default"),
    ApiError,
    /Cloud bind reply was not a JSON object/,
  );
});

for (const payload of [
  { id: 7, authKey: "k" },
  { id: "i", authKey: 9 },
  { id: ["i"], authKey: "k" },
]) {
  test(`a bind reply id and key must be text (${JSON.stringify(payload)})`, async () => {
    const { client } = makeCloudClient([["/cdb/systems/bind", "POST", { json: payload }]]);
    client.token = "t";
    await rejectsWith(() => client.registerSite("My Site", "default"), ApiError, /both an id and an authKey/);
  });
}

for (const bad of ["http://[abc", "https://[::1"]) {
  test(`a broken IPv6 address ${JSON.stringify(bad)} is a config error, not a crash`, () => {
    throwsWith(() => resolveConfig({}, { ...SERVER_ENV, NX_SERVER_HOST: bad }, {}), ConfigError, /full URL/);
  });
}

test("a broken cloud host reported by the server is an ApiError", () => {
  throwsWith(() => cloudTarget(FLOW_CLOUD_CONFIG, { cloudHost: "[abc", customization: "default" }), ApiError);
});

test("NX_CLOUD_HOST must be https", () => {
  throwsWith(
    () => resolveConfig({}, { ...CLOUD_ENV, NX_CLOUD_HOST: "http://nxvms.com" }, {}),
    ConfigError,
    /https:\/\//,
  );
});

test("a Cloud the server reports as plain http is refused", () => {
  throwsWith(
    () =>
      cloudTarget(
        { ...FLOW_CLOUD_CONFIG, cloudHost: null },
        { cloudHost: "http://cloud.example.com", customization: "default" },
      ),
    ApiError,
    /not an https:\/\/ address/,
  );
});

test("with --insecure the cloud host must be given", () => {
  // Without a checked certificate the server could be anyone, so the Cloud it
  // names must not receive the Cloud password.
  const env = Object.fromEntries(Object.entries(CLOUD_ENV).filter(([name]) => name !== "NX_CLOUD_HOST"));
  throwsWith(() => resolveConfig({ insecure: true }, env, {}), ConfigError, /With --insecure, set NX_CLOUD_HOST/);
  assert.ok(resolveConfig({ insecure: true }, { ...CLOUD_ENV }, {}).cloudHost);
  assert.equal(resolveConfig({}, env, {}).cloudHost, null);
});

test("main exits 2 for --insecure with the Cloud and no NX_CLOUD_HOST", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  const env = Object.fromEntries(Object.entries(CLOUD_ENV).filter(([name]) => name !== "NX_CLOUD_HOST"));

  const code = await main(
    ["--dotenv", writeEnvFile(dir, env), "--insecure", "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 2);
  assert.ok(fakes.err.text.includes("NX_CLOUD_HOST"));
  assert.deepEqual(fakes.log, []);
  assert.equal(fakes.server, null);
});

// ---------------------------------------------------------------------------
// Cloud login first, two-factor accounts, and which host an error names
// ---------------------------------------------------------------------------

test("a failed cloud login leaves a new server untouched", async () => {
  const log: LogEntry[] = [];
  await rejectsWith(
    () =>
      configureSite(
        FLOW_CLOUD_CONFIG,
        THREE_TRUE,
        new FakeServer({ log }),
        new FakeCloud({ log, fail: "cloud.login" }).make,
      ),
    ApiError,
  );
  assert.deepEqual(names(log), ["server.get_site_info", "cloud.login"]);
});

test("an existing site is refused before the cloud login", async () => {
  const log: LogEntry[] = [];
  await rejectsWith(
    () =>
      configureSite(
        FLOW_CLOUD_CONFIG,
        THREE_TRUE,
        new FakeServer({ info: EXISTING, log }),
        new FakeCloud({ log }).make,
      ),
    ExistingSiteError,
  );
  assert.deepEqual(names(log), ["server.get_site_info"]);
});

test("a failed cloud request names the cloud, not the server", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  const makeCloud = fakes.deps.makeCloud!;
  fakes.deps.makeCloud = (url) => {
    const cloud = makeCloud(url) as FakeCloud;
    cloud.registerSite = async () => {
      throw new HttpError(403, "POST", "https://cloud.example.com/cdb/systems/bind");
    };
    return cloud;
  };

  const code = await main(
    ["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 1);
  assert.ok(fakes.err.text.includes("could not complete a request to https://cloud.example.com:"));
  assert.ok(!fakes.err.text.includes("server:7001"));
});

test("a cloud request that fails on the network names the cloud, not the server", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();
  delete fakes.deps.makeCloud;
  fakes.deps.fetchImpl = (async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  }) as unknown as MainDeps["fetchImpl"];

  const code = await main(
    ["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 1);
  assert.ok(fakes.err.text.includes("could not complete a request to https://cloud.example.com:"));
  assert.ok(!fakes.err.text.includes("server:7001"));
});

// ---------------------------------------------------------------------------
// Two-factor authentication on the Cloud account
// ---------------------------------------------------------------------------

const TWO_FA_LOGIN: [string, string, FakeReply] = [
  "/cdb/oauth2/token",
  "POST",
  { json: { access_token: "t-2fa", error: "second_factor_required" } },
];

test("a two-factor login is confirmed with the code, then used", async () => {
  // The Cloud answers HTTP 200 with a token and second_factor_required; the
  // same token works once GET .../2fa/totp/key/{code}?token=... accepts it.
  const { client, calls } = makeCloudClient([
    TWO_FA_LOGIN,
    ["/totp/key/123456?token=t-2fa", "GET", { json: {} }],
  ]);

  const token = await client.login("owner@example.com", "cloud-pass", () => " 123456 ");

  assert.equal(token, "t-2fa");
  assert.deepEqual(client.authHeaders(), { Authorization: "Bearer t-2fa" });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.method, "GET");
  const url = new URL(calls[1]!.url);
  assert.equal(
    url.origin + url.pathname,
    "https://cloud.example.com/cdb/account/self/2fa/totp/key/123456",
  );
  assert.equal(url.searchParams.get("token"), "t-2fa");
});

test("a redirect on the two-factor call names no token or code", async () => {
  // The confirmation URL carries the code and the Cloud token; a redirect
  // error must name only the addresses' origins.
  const { client } = makeCloudClient([
    ["/cdb/oauth2/token", "POST", { json: { access_token: "SECRET", error: "second_factor_required" } }],
    [
      "/totp/key/123456?token=SECRET",
      "GET",
      { status: 302, headers: { location: "https://proxy.example:8443/login?token=SECRET2" } },
    ],
  ]);

  const error = await rejectsWith(
    () => client.login("owner@example.com", "cloud-pass", () => "123456"),
    ApiError,
  );

  assert.ok(
    error.message.startsWith(
      "https://cloud.example.com answered with a redirect (HTTP 302 to https://proxy.example:8443).",
    ),
    error.message,
  );
  assert.ok(!error.message.includes("SECRET"), error.message);
  assert.ok(!error.message.includes("123456"), error.message);
  assert.ok(!error.message.includes("/cdb"), error.message);
});

test("a redirect with a relative or broken Location names what it can", async () => {
  for (const [location, expected] of [
    ["/login?token=x", "(HTTP 302 to https://cloud.example.com)."],
    ["http://[bad", "(HTTP 302)."],
  ] as const) {
    const { client } = makeCloudClient([
      ["/cdb/oauth2/token", "POST", { status: 302, headers: { location } }],
    ]);
    const error = await rejectsWith(() => client.login("owner@example.com", "cloud-pass"), ApiError);
    assert.ok(error.message.includes(expected), error.message);
    assert.ok(!error.message.includes("token=x"), error.message);
  }
});

test("a two-factor login awaits a code source that prompts", async () => {
  const { client } = makeCloudClient([TWO_FA_LOGIN]);
  assert.equal(await client.login("owner@example.com", "cloud-pass", async () => "123456"), "t-2fa");
});

test("a two-factor login without a code says how to give one", async () => {
  const { client, calls } = makeCloudClient([TWO_FA_LOGIN]);

  const error = await rejectsWith(() => client.login("owner@example.com", "cloud-pass", null), AuthError);

  assert.equal(
    error.message,
    "Cloud login for owner@example.com needs a two-factor code. Run again with " +
      "--mfa-code <the 6-digit code from your authenticator app>, or run it in a " +
      "terminal to be asked for one.",
  );
  assert.equal(client.token, null);
  assert.equal(calls.length, 1);
});

for (const status of [400, 401, 403]) {
  test(`a wrong two-factor code (HTTP ${status}) is an AuthError`, async () => {
    // The Cloud answers a wrong code with 403 "Wrong totp".
    const { client } = makeCloudClient([
      TWO_FA_LOGIN,
      ["/totp/key/000000?token=t-2fa", "GET", { status }],
    ]);

    await rejectsWith(
      () => client.login("owner@example.com", "cloud-pass", () => "000000"),
      AuthError,
      /two-factor code was not accepted/,
    );

    assert.equal(client.token, null);
  });
}

test("an account without two-factor is never asked for a code", async () => {
  const { client, calls } = makeCloudClient([
    ["/cdb/oauth2/token", "POST", { json: { access_token: "t" } }],
  ]);

  const mustNotBeCalled = (): string => {
    throw new Error("asked for a code");
  };

  assert.equal(await client.login("owner@example.com", "cloud-pass", mustNotBeCalled), "t");
  assert.equal(calls.length, 1);
});

test("the flow hands the code source to the cloud login", async () => {
  const cloud = new FakeCloud();
  const source: MfaCodeSource = () => "123456";
  await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, new FakeServer(), cloud.make, false, source);
  assert.equal(cloud.getMfaCode, source);
});

test("the code comes from the flag first", async () => {
  const source = mfaCodeSource({ mfaCode: "654321" }, {}, { stdin: { isTTY: true } });
  assert.ok(source);
  assert.equal(await source(), "654321");
});

test("without the flag a terminal is asked for the code", async () => {
  const asked: string[] = [];
  const source = mfaCodeSource(
    { mfaCode: null },
    { cloudUser: "owner@example.com" },
    {
      stdin: { isTTY: true },
      ask: (prompt) => {
        asked.push(prompt);
        return " 111222 ";
      },
    },
  );
  assert.ok(source);
  assert.equal(await source(), "111222");
  assert.deepEqual(asked, ["Two-factor code for owner@example.com: "]);
});

test("without the flag or a terminal there is no code", () => {
  assert.equal(mfaCodeSource({ mfaCode: null }, {}, { stdin: { isTTY: false } }), null);
});

test("--mfa-code is a command line flag", () => {
  assert.equal(parseArgs(["--mfa-code", "123456"]).mfaCode, "123456");
});

test("an HTTP error never carries the URL, which can hold a token or a two-factor code", () => {
  const error = new HttpError(
    500,
    "GET",
    "https://cloud.example.com/cdb/account/self/2fa/totp/key/123456?token=SECRET",
  );
  assert.equal(error.message, "HTTP 500");
  assert.ok(!error.message.includes("SECRET"));
  assert.ok(!error.message.includes("123456"));
});

test("an HTTP error includes the server's reason but not the URL", async () => {
  const { client } = makeClient([
    [
      "/cloud/bind",
      "POST",
      {
        status: 422,
        json: { error: "4", errorId: "cantProcessRequest", errorString: "Site is already bound." },
      },
    ],
  ]);
  client.token = "tok-SECRET";

  const error = await rejectsWith(
    () => client.cloudBind("auth-key-1", "owner@example.com", "site-id-1"),
    HttpError,
  );
  assert.equal(error.message, "HTTP 422: Site is already bound.");
  assert.ok(!error.message.includes("SECRET"));
  assert.ok(!error.message.includes("server:7001"));
});

test("a Channel Partners error shows the detail from its errors list", async () => {
  const { client } = makeClient([
    [
      "/cloud/bind",
      "POST",
      {
        status: 403,
        json: {
          type: "client_error",
          errors: [{ code: "permission_denied", detail: "You do not have permission.", attr: null }],
        },
      },
    ],
  ]);
  client.token = "tok-1";

  const error = await rejectsWith(
    () => client.cloudBind("auth-key-1", "owner@example.com", "site-id-1"),
    HttpError,
  );
  assert.equal(error.message, "HTTP 403: You do not have permission.");
});

// ---------------------------------------------------------------------------
// The Cloud token is revoked at the end of every run
// ---------------------------------------------------------------------------

test("cloud logout deletes the token and clears it", async () => {
  const { client, calls } = makeCloudClient();
  client.token = "cloud/tok";

  await client.logout();

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.url, "https://cloud.example.com/cdb/oauth2/token/cloud%2Ftok");
  assert.equal(call.headers.Authorization, "Bearer cloud/tok");
  assert.equal(client.token, null);
  assert.deepEqual(client.authHeaders(), {});
});

test("cloud logout without a token is a no-op", async () => {
  const { client, calls } = makeCloudClient();

  await client.logout();

  assert.deepEqual(calls, []);
});

test("main revokes the Cloud token after a run", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();

  const code = await main(
    ["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--settings-file", noSettings(dir)],
    fakes.deps,
  );

  assert.equal(code, 0, fakes.err.text);
  assert.equal(fakes.cloud!.loggedOut, true);
  assert.deepEqual(names(fakes.log).slice(-2), ["server.logout", "cloud.logout"]);
});

for (const failing of ["cloud.register_site", "server.setup"]) {
  test(`main revokes the Cloud token after a failed run (${failing})`, async () => {
    const dir = tmpDir();
    const fakes = makeFakes();
    if (failing.startsWith("cloud.")) fakes.cloudFail = failing;
    else fakes.serverFail = failing;

    const code = await main(
      ["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--settings-file", noSettings(dir)],
      fakes.deps,
    );

    assert.equal(code, 1);
    assert.equal(fakes.cloud!.loggedOut, true);
  });
}

test("a run without the Cloud revokes nothing", async () => {
  const dir = tmpDir();
  const fakes = makeFakes();

  await main(["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", noSettings(dir)], fakes.deps);

  assert.equal(fakes.cloud, null);
  assert.ok(!names(fakes.log).includes("cloud.logout"));
});

test("setup for a cloud site sends cloud instead of local", async () => {
  const { client, calls } = loggedInClient();
  const cloud: CloudAuth = { authKey: "k", owner: "owner@example.com", siteId: "s" };

  await client.setup("My Site", null, THREE_TRUE, cloud);

  const call = calls[0]!;
  assert.equal(call.method, "POST");
  assert.ok(call.url.endsWith("/rest/v4/site/setup"));
  assert.deepEqual(call.body, { name: "My Site", settings: THREE_TRUE, cloud });
});
