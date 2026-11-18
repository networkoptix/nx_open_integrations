// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

/**
 * Offline tests for rest_configure_site.mjs.
 *
 * These run with no VMS server, no Cloud account and no network.
 *
 * Run from this folder:  node --test test_rest_configure_site.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import {
  ApiError,
  errorText,
  AuthError,
  ConfigError,
  ExistingSiteError,
  HttpError,
  NxCloudClient,
  NxServerClient,
  cloudTarget,
  configureSite,
  formatSummary,
  loadEnvFile,
  loadSettings,
  main as realMain,
  makeFetch,
  mfaCodeSource,
  parseArgs,
  resolveConfig,
} from "./rest_configure_site.mjs";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A fake fetch response. `payload` is what json() returns, `text` the body. */
function fakeResponse(status = 200, payload = undefined, text = "") {
  return { status, payload: payload ?? {}, text };
}

/**
 * Stands in for fetch, recording every call it receives as
 * { method, url, body, headers }. `responses` is a list of
 * [method, urlSuffix, response]; the first match wins, anything else is a 200.
 */
function fakeFetch(responses = []) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    const headers = { ...(init.headers ?? {}) };
    calls.push({ method, url, body, headers });
    if (url.endsWith("/site/setup") && !("Authorization" in headers)) {
      // What a real server does: site/setup needs an administrator.
      return {
        status: 401,
        ok: false,
        json: async () => ({}),
        text: async () => "Unauthorized",
      };
    }
    const match = responses.find(([m, suffix]) => m === method && url.endsWith(suffix));
    const reply = match ? match[2] : fakeResponse(200, {});
    return {
      status: reply.status,
      ok: reply.status >= 200 && reply.status < 300,
      json: async () => (reply.notJson ? JSON.parse(reply.text) : reply.payload),
      text: async () => reply.text,
    };
  };
  return { fetchImpl, calls };
}

/** A 200 whose body is not JSON, such as the HTML page of a proxy. */
function notJsonResponse() {
  return { status: 200, payload: {}, text: "<html>Bad gateway</html>", notJson: true };
}

function makeClient(responses) {
  const fake = fakeFetch(responses);
  const client = new NxServerClient("https://server:7001", { fetchImpl: fake.fetchImpl });
  return { client, calls: fake.calls };
}

function makeCloudClient(responses) {
  const fake = fakeFetch(responses);
  const client = new NxCloudClient("https://cloud.example.com", { fetchImpl: fake.fetchImpl });
  return { client, calls: fake.calls };
}

/** An in-memory stand-in for process.stdout / process.stderr. */
function memoryStream() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    text: () => Buffer.concat(chunks).toString("utf-8"),
  };
}

/** A fresh temp directory, removed when the test ends. */
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nx-configure-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test("login posts credentials and stores token", async () => {
  const { client, calls } = makeClient([
    ["POST", "/login/sessions", fakeResponse(200, { token: "tok-1" })],
  ]);

  const token = await client.login("admin", "secret");

  assert.equal(token, "tok-1");
  assert.equal(client.token, "tok-1");
  assert.equal(client.headers.Authorization, "Bearer tok-1");

  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { username: "admin", password: "secret" });
  assert.ok(calls[0].url.endsWith("/rest/v4/login/sessions"));
});

for (const status of [401, 403]) {
  test(`login unauthorized raises AuthError (${status})`, async () => {
    const { client } = makeClient([["POST", "/login/sessions", fakeResponse(status)]]);
    await assert.rejects(() => client.login("admin", "wrong"), AuthError);
  });
}

test("login 403 says the account may not do this", async () => {
  // A 403 is not a typo in the password. The account lacks the rights.
  const { client } = makeClient([["POST", "/login/sessions", fakeResponse(403)]]);
  await assert.rejects(() => client.login("admin", "secret"), /may not do this/);
});

test("login 401 points at the credentials", async () => {
  const { client } = makeClient([["POST", "/login/sessions", fakeResponse(401)]]);
  await assert.rejects(() => client.login("admin", "wrong"), /user name and password/);
});

test("login without token in response raises ApiError", async () => {
  const { client } = makeClient([["POST", "/login/sessions", fakeResponse(200, {})]]);
  await assert.rejects(() => client.login("admin", "secret"), ApiError);
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test("logout deletes the session and clears the token", async () => {
  const { client, calls } = makeClient();
  client.token = "tok-1";
  client.headers.Authorization = "Bearer tok-1";

  await client.logout();

  const last = calls[calls.length - 1];
  assert.equal(last.method, "DELETE");
  assert.ok(last.url.endsWith("/rest/v4/login/sessions/tok-1"));
  assert.equal(client.token, null);
  assert.equal("Authorization" in client.headers, false);
});

test("logout without a token is a noop", async () => {
  const { client, calls } = makeClient();
  await client.logout();
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SERVER_ENV = {
  NX_SERVER_HOST: "https://server:7001",
  NX_SERVER_PASSWORD: "admin-pass",
  NX_SITE_NAME: "My Site",
};

const without = (object, name) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => key !== name));

test("loadEnvFile reads pairs and skips comments, blanks and quotes", (t) => {
  const file = path.join(tempDir(t), "alt.env");
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

test("loadEnvFile of a missing file is empty", (t) => {
  assert.deepEqual(loadEnvFile(path.join(tempDir(t), "missing.env")), {});
});

test("an env file that exists but cannot be read is a config error", (t) => {
  // A directory stands in for any unreadable path. It behaves the same on
  // every platform, which a permission bit does not.
  const dir = tempDir(t);
  assert.throws(() => loadEnvFile(dir), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.message.startsWith(`Cannot read ${dir}: `));
    assert.match(err.message, /: .+\.$/);
    return true;
  });
});

test("config reads the server and site variables", () => {
  const config = resolveConfig({}, { ...SERVER_ENV }, {});

  assert.equal(config.host, "https://server:7001");
  assert.equal(config.password, "admin-pass");
  assert.equal(config.siteName, "My Site");
});

test("cli beats environment beats dotenv for host and password", () => {
  const dotenv = { ...SERVER_ENV };

  assert.equal(
    resolveConfig({}, dotenv, { NX_SERVER_HOST: "https://from-env:7001" }).host,
    "https://from-env:7001",
  );
  assert.equal(
    resolveConfig({ host: "https://from-cli:7001" }, dotenv, {
      NX_SERVER_HOST: "https://from-env:7001",
    }).host,
    "https://from-cli:7001",
  );
  assert.equal(resolveConfig({}, dotenv, {}).host, "https://server:7001");

  assert.equal(resolveConfig({}, dotenv, { NX_SERVER_PASSWORD: "env-pass" }).password, "env-pass");
  assert.equal(
    resolveConfig({ password: "cli-pass" }, dotenv, { NX_SERVER_PASSWORD: "env-pass" }).password,
    "cli-pass",
  );
});

test("the site name has no flag so the environment beats dotenv", () => {
  assert.equal(
    resolveConfig({}, { ...SERVER_ENV }, { NX_SITE_NAME: "From Env" }).siteName,
    "From Env",
  );
});

test("trailing slash is stripped from the host", () => {
  const env = { ...SERVER_ENV, NX_SERVER_HOST: "https://server:7001/" };
  assert.equal(resolveConfig({}, env, {}).host, "https://server:7001");
});

const CLOUD_ENV = {
  ...SERVER_ENV,
  NX_CONNECT_TO_CLOUD: "true",
  NX_CLOUD_HOST: "https://cloud.example.com/",
  NX_CLOUD_USER: "owner@example.com",
  NX_CLOUD_PASSWORD: "cloud-pass",
};

test("connecting to the cloud is off by default and needs no cloud values", () => {
  const config = resolveConfig({}, { ...SERVER_ENV }, {});
  assert.equal(config.connectToCloud, false);
});

for (const [text, expected] of [
  ["true", true], ["TRUE", true], ["1", true],
  ["false", false], ["False", false], ["0", false],
]) {
  test(`connect to cloud accepts true false 1 and 0 (${text})`, () => {
    const env = { ...CLOUD_ENV, NX_CONNECT_TO_CLOUD: text };
    assert.equal(resolveConfig({}, env, {}).connectToCloud, expected);
  });
}

for (const text of ["yes", "on", "maybe", "2"]) {
  test(`connect to cloud rejects anything else (${text})`, () => {
    const env = { ...CLOUD_ENV, NX_CONNECT_TO_CLOUD: text };
    assert.throws(() => resolveConfig({}, env, {}), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /NX_CONNECT_TO_CLOUD/);
      return true;
    });
  });
}

for (const missing of ["NX_CLOUD_USER", "NX_CLOUD_PASSWORD"]) {
  test(`connecting without a cloud value is a config error naming it (${missing})`, () => {
    assert.throws(() => resolveConfig({}, without(CLOUD_ENV, missing), {}), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, new RegExp(missing));
      return true;
    });
  });
}

test("cloud values are read when connecting", () => {
  const config = resolveConfig({}, { ...CLOUD_ENV, NX_ORGANIZATION_ID: "org-1" }, {});
  assert.equal(config.cloudHost, "https://cloud.example.com");
  assert.equal(config.cloudUser, "owner@example.com");
  assert.equal(config.cloudPassword, "cloud-pass");
  assert.equal(config.organizationId, "org-1");
});

test("the cloud host is optional and the organization defaults to null", () => {
  const config = resolveConfig({}, without(CLOUD_ENV, "NX_CLOUD_HOST"), {});
  assert.equal(config.cloudHost, null);
  assert.equal(config.organizationId, null);
});

test("NX_CUSTOMIZATION is not read any more", () => {
  // The server reports its own customization, see cloudTarget.
  const config = resolveConfig({}, { ...CLOUD_ENV, NX_CUSTOMIZATION: "metavms" }, {});
  assert.equal("customization" in config, false);
});

for (const missing of ["NX_SERVER_HOST", "NX_SERVER_PASSWORD", "NX_SITE_NAME"]) {
  test(`a missing required value is a config error naming it (${missing})`, () => {
    assert.throws(() => resolveConfig({}, without(SERVER_ENV, missing), {}), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, new RegExp(missing));
      return true;
    });
  });
}

// A value that is not a full URL would only fail later, deep inside a request.
// The last one matters: the URL parser accepts it and encodes the space.
const BAD_URLS = [
  "not-a-url", "ftp://h", "https://", "https://my server:7001", "https://server:7001/a b",
];

for (const bad of BAD_URLS) {
  test(`a server address that is not a full http url is a config error (${bad})`, () => {
    const expected =
      "The server address must be a full URL such as https://192.168.1.10:7001, " +
      `not ${JSON.stringify(bad)} (NX_SERVER_HOST or --host).`;
    const isExpected = (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message, expected);
      return true;
    };

    assert.throws(() => resolveConfig({}, { ...SERVER_ENV, NX_SERVER_HOST: bad }, {}), isExpected);
    assert.throws(() => resolveConfig({ host: bad }, { ...SERVER_ENV }, {}), isExpected);
  });

  test(`a cloud address that is not a full http url is a config error (${bad})`, () => {
    assert.throws(() => resolveConfig({}, { ...CLOUD_ENV, NX_CLOUD_HOST: bad }, {}), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(
        err.message,
        `NX_CLOUD_HOST must be a full URL such as https://nxvms.com, not ${JSON.stringify(bad)}.`,
      );
      return true;
    });
  });
}

test("an https server address is accepted, in any letter case", () => {
  for (const host of ["https://server:7001", "HTTPS://server:7001", "https://[::1]:7001"]) {
    assert.equal(resolveConfig({}, { ...SERVER_ENV, NX_SERVER_HOST: host }, {}).host, host);
  }
});

// The server's login works over http, so the password would go out in
// cleartext, and every Bearer call after it is refused with 403.
for (const plain of ["http://h", "http://192.168.1.10:7001", "HTTP://server:7001"]) {
  test(`a plain http server address is a config error (${plain})`, () => {
    const expected =
      "The server address must be an https:// address, because the admin password " +
      `is sent there, not "${plain}" (NX_SERVER_HOST or --host).`;
    const isExpected = (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message, expected);
      return true;
    };

    assert.throws(() => resolveConfig({}, { ...SERVER_ENV, NX_SERVER_HOST: plain }, {}), isExpected);
    assert.throws(() => resolveConfig({ host: plain }, { ...SERVER_ENV }, {}), isExpected);
  });
}

test("the cloud address is not checked when the cloud is not used", () => {
  const env = { ...SERVER_ENV, NX_CLOUD_HOST: "not-a-url" };
  assert.equal(resolveConfig({}, env, {}).connectToCloud, false);
});

// ---------------------------------------------------------------------------
// The whole flow, with the clients faked
// ---------------------------------------------------------------------------

const THREE_TRUE = {
  autoDiscoveryEnabled: true,
  cameraSettingsOptimization: true,
  statisticsAllowed: true,
};

/**
 * Records the order of calls. `fail` names a method that raises ApiError.
 *
 * `info` is what site/info answers: {} is a factory-default server, a localId
 * makes it a server that already belongs to a site, a cloudId a bound one.
 */
class FakeServer {
  constructor({ info = {}, fail = null, log = [], rejectedPasswords = [] } = {}) {
    this.log = log;
    // What every server reports: the Cloud it belongs to and its brand.
    this.info = { ...SERVER_BUILD, ...info };
    this.rejectedPasswords = rejectedPasswords;
    this.fail = fail;
    this.token = null;
    this.loggedOut = false;
  }

  _do(name, ...args) {
    this.log.push([name, ...args]);
    if (this.fail === name) throw new ApiError(`${name} failed`);
  }

  async getSiteInfo() {
    this._do("server.get_site_info");
    return { ...this.info };
  }

  async setup(siteName, adminPassword, settings, cloud = null) {
    if (cloud === null) {
      this._do("server.setup", siteName, adminPassword, settings);
    } else {
      this._do("server.setup", siteName, adminPassword, settings, cloud);
    }
    if (!this.token) throw new Error("site/setup was called without a login");
  }

  async login(username, password) {
    this._do("server.login", username, password);
    if (this.rejectedPasswords.includes(password)) {
      throw new AuthError("Login rejected (HTTP 401). Check the user name and password.");
    }
    this.token = "tok";
  }

  async cloudBind(authKey, owner, siteId, organizationId = null) {
    this._do("server.cloud_bind", authKey, owner, siteId, organizationId);
  }

  async applySettings(wanted) {
    this._do("server.apply_settings", wanted);
    return { statisticsAllowed: false };
  }

  async logout() {
    this.log.push(["server.logout"]);
    this.token = null;
    this.loggedOut = true;
  }
}

const SERVER_BUILD = { cloudHost: "cloud.example.com", customization: "default" };

/**
 * `make` also stands in for the makeCloud factory: calling it records the URL
 * the flow chose and returns the fake itself.
 */
class FakeCloud {
  constructor({ fail = null, log = [] } = {}) {
    this.log = log;
    this.fail = fail;
    this.url = null;
    this.make = (url) => {
      this.url = url;
      return this;
    };
  }

  _do(name, ...args) {
    this.log.push([name, ...args]);
    if (this.fail === name) throw new ApiError(`${name} failed`);
  }

  async login(username, password, getMfaCode = null) {
    this._do("cloud.login", username, password);
    this.getMfaCode = getMfaCode;
  }

  async registerSite(siteName, customization, organizationId = null) {
    this._do("cloud.register_site", siteName, customization, organizationId);
    return { siteId: "site-id-1", authKey: "auth-key-1" };
  }

  async logout() {
    this.log.push(["cloud.logout"]);
    this.loggedOut = true;
  }
}

const FLOW_CONFIG = {
  host: "https://server:7001",
  password: "admin-pass",
  siteName: "My Site",
  connectToCloud: false,
};
const FLOW_CLOUD_CONFIG = {
  ...FLOW_CONFIG,
  connectToCloud: true,
  cloudHost: "https://cloud.example.com",
  cloudUser: "owner@example.com",
  cloudPassword: "cloud-pass",
  organizationId: null,
};

const EXISTING = { localId: "{1b2c}", name: "Front Office" };
const EXISTING_BOUND = { ...EXISTING, cloudId: "cloud-site-9" };
const YES = { allowExisting: true };

/** True when `log` holds an entry deep equal to `entry`. */
const logged = (log, entry) =>
  log.some((item) => {
    try {
      assert.deepEqual(item, entry);
      return true;
    } catch {
      return false;
    }
  });

const names = (log) => log.map((entry) => entry[0]);

test("a new server is set up with the factory login then the new password", async () => {
  const log = [];
  const server = new FakeServer({ log });

  const summary = await configureSite(FLOW_CONFIG, THREE_TRUE, server, null);

  assert.deepEqual(names(log), [
    "server.get_site_info", "server.login", "server.setup",
    "server.logout", "server.login", "server.apply_settings",
  ]);
  assert.deepEqual(log[1], ["server.login", "admin", "admin"]);
  assert.deepEqual(log[2], ["server.setup", "My Site", "admin-pass", THREE_TRUE]);
  assert.deepEqual(log[4], ["server.login", "admin", "admin-pass"]);
  assert.equal(summary.setUp, true);
  assert.equal(summary.siteName, "My Site");
  assert.equal(summary.cloud, "not connected");
});

test("a new server whose factory login is rejected is not set up", async () => {
  const log = [];
  const server = new FakeServer({ log, rejectedPasswords: ["admin"] });

  await assert.rejects(
    () => configureSite(FLOW_CONFIG, THREE_TRUE, server, null),
    (err) => err instanceof ApiError && /factory login \(admin\/admin\)/.test(err.message),
  );
  assert.equal(names(log).includes("server.setup"), false);
});

test("a refused setup stops the run", async () => {
  const log = [];
  const server = new FakeServer({ log, fail: "server.setup" });

  await assert.rejects(() => configureSite(FLOW_CONFIG, THREE_TRUE, server, null), ApiError);
  assert.equal(names(log).includes("server.apply_settings"), false);
});

test("an existing site is refused without --yes and nothing is changed", async () => {
  const log = [];
  const server = new FakeServer({ info: EXISTING, log });

  await assert.rejects(
    () => configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make),
    (err) => {
      assert.ok(err instanceof ExistingSiteError);
      assert.equal(
        err.message,
        'https://server:7001 already belongs to the site "Front Office". Refusing to ' +
          "change it without --yes. With --yes its settings are updated and it is " +
          "connected to the Cloud.",
      );
      return true;
    },
  );
  assert.deepEqual(names(log), ["server.get_site_info"]);
});

test("an existing site with --yes is updated under its real name", async () => {
  const log = [];
  const server = new FakeServer({ info: EXISTING, log });

  const summary = await configureSite(FLOW_CONFIG, THREE_TRUE, server, null, YES);

  assert.deepEqual(names(log), ["server.get_site_info", "server.login", "server.apply_settings"]);
  assert.deepEqual(log[1], ["server.login", "admin", "admin-pass"]);
  assert.equal(summary.setUp, false);
  assert.equal(summary.siteName, "Front Office");
});

test("an existing unbound site with --yes is registered under its real name", async () => {
  const log = [];
  const server = new FakeServer({ info: EXISTING, log });

  const summary = await configureSite(
    FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make, YES,
  );

  assert.ok(logged(log, ["cloud.register_site", "Front Office", "default", null]));
  assert.equal(summary.cloud, "connected");
});

test("a site already bound to the cloud is not registered again", async () => {
  const log = [];
  const server = new FakeServer({ info: EXISTING_BOUND, log });

  const summary = await configureSite(
    FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make, YES,
  );

  assert.deepEqual(names(log).filter((name) => name.startsWith("cloud.")), []);
  assert.equal(names(log).includes("server.cloud_bind"), false);
  assert.equal(summary.cloud, "already");
  assert.equal(summary.cloudId, "cloud-site-9");
});

/**
 * site/setup carries "cloud" instead of "local": no local admin password
 * is set, and the server rolls the setup back if the bind fails.
 */
test("a new cloud site is set up and bound in one site/setup", async () => {
  const log = [];
  const server = new FakeServer({ log });
  const cloud = new FakeCloud({ log });

  const summary = await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, cloud.make);

  // The Cloud login comes before anything on the server changes.
  assert.deepEqual(names(log), [
    "server.get_site_info", "cloud.login", "server.login",
    "cloud.register_site", "server.setup", "server.logout",
  ]);
  assert.ok(logged(log, ["server.login", "admin", "admin"]));
  assert.ok(logged(log, ["cloud.register_site", "My Site", "default", null]));
  assert.ok(
    logged(log, [
      "server.setup", "My Site", null, THREE_TRUE,
      { authKey: "auth-key-1", owner: "owner@example.com", siteId: "site-id-1" },
    ]),
  );
  assert.equal(summary.cloud, "connected");
  assert.equal(summary.setUp, true);
});

test("an existing site with --yes is still bound with cloud_bind", async () => {
  const log = [];
  const server = new FakeServer({ info: EXISTING, log });

  await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make, YES);

  assert.deepEqual(names(log), [
    "server.get_site_info", "cloud.login", "server.login",
    "cloud.register_site", "server.cloud_bind", "server.apply_settings",
  ]);
  assert.ok(
    logged(log, ["server.cloud_bind", "auth-key-1", "owner@example.com", "site-id-1", null]),
  );
});

test("the flow passes the organization to both cloud calls", async () => {
  const log = [];
  const config = { ...FLOW_CLOUD_CONFIG, organizationId: "org-1" };

  await configureSite(config, THREE_TRUE, new FakeServer({ log }), new FakeCloud({ log }).make);

  assert.ok(logged(log, ["cloud.register_site", "My Site", "default", "org-1"]));
  assert.ok(
    logged(log, [
      "server.setup", "My Site", null, THREE_TRUE,
      {
        authKey: "auth-key-1", owner: "owner@example.com",
        siteId: "site-id-1", organizationId: "org-1",
      },
    ]),
  );
});

test("a new site is set up with the defaults for what the file leaves out", async () => {
  const log = [];
  await configureSite(FLOW_CONFIG, { statisticsAllowed: false }, new FakeServer({ log }), null);

  assert.ok(
    logged(log, ["server.setup", "My Site", "admin-pass", { ...THREE_TRUE, statisticsAllowed: false }]),
  );
  assert.ok(logged(log, ["server.apply_settings", { statisticsAllowed: false }]));
});

test("an existing site is patched only with what the file names", async () => {
  // An administrator turned autoDiscoveryEnabled off. A file that names only
  // statisticsAllowed must not turn it back on.
  const log = [];
  await configureSite(
    FLOW_CONFIG, { statisticsAllowed: false }, new FakeServer({ info: EXISTING, log }), null, YES,
  );

  assert.ok(logged(log, ["server.apply_settings", { statisticsAllowed: false }]));
});

test("an existing site with no settings named gets no settings call", async () => {
  const log = [];
  const summary = await configureSite(
    FLOW_CONFIG, {}, new FakeServer({ info: EXISTING, log }), null, YES,
  );

  assert.equal(names(log).includes("server.apply_settings"), false);
  assert.deepEqual(summary.settingsChanged, {});
});

test("the cloud and customization come from the server", async () => {
  // A white-label server joins its own Cloud under its own customization.
  const log = [];
  const cloud = new FakeCloud({ log });
  const server = new FakeServer({
    log,
    info: { cloudHost: "cloud.brand.example", customization: "brand_x" },
  });
  const config = { ...FLOW_CLOUD_CONFIG, cloudHost: null };

  const summary = await configureSite(config, THREE_TRUE, server, cloud.make);

  assert.equal(cloud.url, "https://cloud.brand.example");
  assert.ok(logged(log, ["cloud.register_site", "My Site", "brand_x", null]));
  assert.equal(summary.cloudUrl, "https://cloud.brand.example");
});

test("NX_CLOUD_HOST naming another cloud stops before anything changes", async () => {
  const log = [];
  const server = new FakeServer({ log, info: { cloudHost: "cloud.brand.example" } });
  const config = { ...FLOW_CLOUD_CONFIG, cloudHost: "https://nxvms.com" };

  await assert.rejects(
    () => configureSite(config, THREE_TRUE, server, new FakeCloud({ log }).make),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.ok(err.message.includes("https://cloud.brand.example"));
      assert.ok(err.message.includes("NX_CLOUD_HOST"));
      return true;
    },
  );
  assert.deepEqual(names(log), ["server.get_site_info"]);
});

test("NX_CLOUD_HOST naming the same cloud is accepted", async () => {
  const cloud = new FakeCloud();
  const config = { ...FLOW_CLOUD_CONFIG, cloudHost: "https://CLOUD.example.com" };
  await configureSite(config, THREE_TRUE, new FakeServer(), cloud.make);
  assert.equal(cloud.url, "https://cloud.example.com");
});

test("the default port in NX_CLOUD_HOST names the same Cloud", async () => {
  // https://x and https://x:443 are the same Cloud.
  const cloud = new FakeCloud();
  const config = { ...FLOW_CLOUD_CONFIG, cloudHost: "https://cloud.example.com:443" };
  await configureSite(config, THREE_TRUE, new FakeServer(), cloud.make);
  assert.equal(cloud.url, "https://cloud.example.com");
});

test("another port in NX_CLOUD_HOST names another Cloud", async () => {
  const config = { ...FLOW_CLOUD_CONFIG, cloudHost: "https://cloud.example.com:8443" };
  await assert.rejects(
    configureSite(config, THREE_TRUE, new FakeServer(), new FakeCloud().make),
    (error) => error instanceof ApiError && /NX_CLOUD_HOST/.test(error.message),
  );
});

for (const missing of ["cloudHost", "customization"]) {
  test(`a server that does not report its cloud cannot be connected (${missing})`, async () => {
    const log = [];
    const server = new FakeServer({ log, info: { [missing]: "" } });
    await assert.rejects(
      () => configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud({ log }).make),
      (err) => err instanceof ApiError && /cloudHost and customization/.test(err.message),
    );
    assert.deepEqual(names(log), ["server.get_site_info"]);
  });
}

test("a bound site needs no cloud host from the server", async () => {
  const server = new FakeServer({ info: { ...EXISTING_BOUND, cloudHost: "" } });
  const summary = await configureSite(
    FLOW_CLOUD_CONFIG, THREE_TRUE, server, new FakeCloud().make, YES,
  );
  assert.equal(summary.cloud, "already");
});

test("a rejected login with the new password is an AuthError", async () => {
  const server = new FakeServer({ rejectedPasswords: ["admin-pass"] });
  await assert.rejects(() => configureSite(FLOW_CONFIG, THREE_TRUE, server, null), AuthError);
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
]) {
  test(`a failing step stops the flow before the next ones (${failing})`, async () => {
    const log = [];
    const server = new FakeServer({ log, fail: failing.startsWith("server.") ? failing : null });
    const cloud = new FakeCloud({ log, fail: failing.startsWith("cloud.") ? failing : null });

    await assert.rejects(
      () => configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, server, cloud.make),
      ApiError,
    );

    const ran = names(log);
    assert.ok(ran.includes(failing));
    const after = ran.slice(ran.indexOf(failing) + 1);
    assert.deepEqual(later.filter((name) => after.includes(name)), []);
  });
}

// ---------------------------------------------------------------------------
// The summary text
// ---------------------------------------------------------------------------

const summaryOf = (overrides = {}) => ({
  siteName: "My Site",
  setUp: true,
  cloud: "not connected",
  cloudId: null,
  cloudUrl: null,
  settingsChanged: {},
  ...overrides,
});

test("the summary names the cloud account as owner for a personal site", () => {
  const text = formatSummary(
    FLOW_CLOUD_CONFIG,
    summaryOf({ cloud: "connected", cloudUrl: "https://cloud.example.com" }),
  );
  assert.ok(text.includes("connected to https://cloud.example.com, owned by owner@example.com"));
});

test("the summary names the organization as owner for an organization site", () => {
  const config = { ...FLOW_CLOUD_CONFIG, organizationId: "org-1" };
  const text = formatSummary(
    config,
    summaryOf({ cloud: "connected", cloudUrl: "https://cloud.example.com" }),
  );
  assert.ok(text.includes("owned by organization org-1"));
  assert.equal(text.includes("owner@example.com"), false);
});

test("the summary says when the site was already connected", () => {
  const text = formatSummary(
    FLOW_CLOUD_CONFIG,
    summaryOf({ cloud: "already", cloudId: "cloud-site-9" }),
  );
  assert.ok(text.includes("already connected (Cloud id cloud-site-9), left as it was"));
});

test("the summary uses the real site name of an existing site", () => {
  const text = formatSummary(FLOW_CONFIG, summaryOf({ siteName: "Front Office", setUp: false }));
  assert.ok(text.includes("Site name       : Front Office"));
  assert.equal(text.includes("My Site"), false);
  assert.ok(text.includes("Set up          : no, the server already belonged to a site"));
});

test("the summary says when nothing is connected or changed", () => {
  const text = formatSummary(FLOW_CONFIG, summaryOf());
  assert.ok(text.includes("not connected"));
  assert.ok(text.includes("none"));
});

test("the summary lists changed settings with lowercase values", () => {
  const text = formatSummary(
    FLOW_CONFIG,
    summaryOf({ settingsChanged: { statisticsAllowed: false } }),
  );
  assert.ok(text.includes("statisticsAllowed=false"));
});

// ---------------------------------------------------------------------------
// main(): exit codes and output
// ---------------------------------------------------------------------------

/**
 * Swap the real clients for fakes that share one call log. `overrides` replaces
 * a method on every FakeServer.
 */
function makeFakes() {
  const state = {
    log: [],
    server: null,
    cloud: null,
    info: {},
    serverFail: null,
    cloudFail: null,
    overrides: {},
    stdout: memoryStream(),
    stderr: memoryStream(),
  };
  state.deps = {
    env: {},
    stdout: state.stdout,
    stderr: state.stderr,
    makeServer(host, { verifyTls = true } = {}) {
      state.server = Object.assign(new FakeServer({
        info: state.info,
        log: state.log,
        fail: state.serverFail,
      }), {
        host,
        verifyTls,
        ...state.overrides,
      });
      return state.server;
    },
    // Records the TLS setting the way the real NxCloudClient takes it: not
    // passed means verification stays on.
    makeCloud(url, { verifyTls = true } = {}) {
      state.cloud = new FakeCloud({ log: state.log, fail: state.cloudFail });
      state.cloud.verifyTls = verifyTls;
      return state.cloud.make(url);
    },
  };
  return state;
}

function writeEnvFile(dir, values) {
  const file = path.join(dir, ".env");
  fs.writeFileSync(
    file,
    Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n"),
    "utf-8",
  );
  return file;
}

function writeSettingsFile(dir, text) {
  const file = path.join(dir, "site_settings.json");
  fs.writeFileSync(file, text, "utf-8");
  return file;
}

const run = (fakes, argv) => realMain(argv, fakes.deps);

test("main runs the flow, prints a summary and exits 0", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", writeSettingsFile(dir, '{"statisticsAllowed": false}'),
  ]);

  assert.equal(code, 0);
  const output = fakes.stdout.text();
  assert.ok(output.includes("My Site"));
  assert.ok(output.includes("statisticsAllowed"));
  assert.equal(fakes.server.loggedOut, true);
  assert.equal(fakes.server.host, "https://server:7001");
});

test("main with a missing required value exits 2 and runs nothing", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, ["--dotenv", writeEnvFile(dir, without(SERVER_ENV, "NX_SITE_NAME"))]);

  assert.equal(code, 2);
  assert.match(fakes.stderr.text(), /NX_SITE_NAME/);
  assert.deepEqual(fakes.log, []);
});

test("main with a bad server address exits 2 before any client is built", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--host", "not-a-url"]);

  assert.equal(code, 2);
  assert.match(fakes.stderr.text(), /^ERROR: The server address must be a full URL/);
  assert.equal(fakes.server, null);
  assert.deepEqual(fakes.log, []);
});

test("main with a bad cloud address exits 2 before any client is built", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, { ...CLOUD_ENV, NX_CLOUD_HOST: "ftp://h" }),
  ]);

  assert.equal(code, 2);
  assert.match(fakes.stderr.text(), /^ERROR: NX_CLOUD_HOST must be a full URL/);
  assert.equal(fakes.server, null);
  assert.equal(fakes.cloud, null);
});

test("main with an unreadable env file exits 2 and runs nothing", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, ["--dotenv", dir]);

  assert.equal(code, 2);
  assert.ok(fakes.stderr.text().startsWith(`ERROR: Cannot read ${dir}: `));
  assert.equal(fakes.server, null);
});

test("main with an unreadable settings file exits 2 and runs nothing", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, ["--dotenv", writeEnvFile(dir, SERVER_ENV), "--settings-file", dir]);

  assert.equal(code, 2);
  assert.ok(fakes.stderr.text().startsWith(`ERROR: Cannot read ${dir}: `));
  assert.equal(fakes.server, null);
});

test("main with an unsupported setting exits 2 and runs nothing", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  const settings = writeSettingsFile(dir, '{"auditTrailEnabled": true}');

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", settings,
  ]);

  assert.equal(code, 2);
  assert.match(fakes.stderr.text(), /auditTrailEnabled/);
  assert.deepEqual(fakes.log, []);
});

test("main says so when the settings file is not found", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "typo.json"),
  ]);

  assert.match(fakes.stderr.text(), /typo\.json/);
});

for (const failing of [
  "server.get_site_info", "server.setup", "server.login", "server.apply_settings",
]) {
  test(`main exits 1 when a server step fails and still logs out (${failing})`, async (t) => {
    const dir = tempDir(t);
    const fakes = makeFakes();
    fakes.serverFail = failing;

    const code = await run(fakes, [
      "--dotenv", writeEnvFile(dir, SERVER_ENV),
      "--settings-file", writeSettingsFile(dir, '{"statisticsAllowed": false}'),
    ]);

    assert.equal(code, 1);
    assert.ok(fakes.stderr.text().includes(`${failing} failed`));
    assert.equal(fakes.server.loggedOut, true);
  });
}

for (const failing of ["cloud.login", "cloud.register_site"]) {
  test(`main exits 1 when a cloud step fails and still logs out (${failing})`, async (t) => {
    const dir = tempDir(t);
    const fakes = makeFakes();
    fakes.cloudFail = failing;

    const code = await run(fakes, [
      "--dotenv", writeEnvFile(dir, CLOUD_ENV),
      "--settings-file", path.join(dir, "none.json"),
    ]);

    assert.equal(code, 1);
    assert.equal(fakes.server.loggedOut, true);
  });
}

test("main exits 1 on a rejected login", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  fakes.overrides.login = async function (username, password) {
    if (password === "admin") {
      // the factory login still works
      this.token = "tok";
      return;
    }
    throw new AuthError("Login forbidden (HTTP 403). This account may not do this.");
  };

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(code, 1);
  assert.match(fakes.stderr.text(), /may not do this/);
});

test("main exits 1 with a hint when the server is unreachable", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  fakes.overrides.getSiteInfo = async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("no route"), { code: "ECONNREFUSED" }),
    });
  };

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(code, 1);
  assert.match(fakes.stderr.text(), /https:\/\/server:7001/);
});

test("main suggests insecure on a certificate error", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  fakes.overrides.getSiteInfo = async () => {
    throw Object.assign(new Error("self-signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      url: "https://server:7001/rest/v4/site/info",
    });
  };

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(code, 1);
  assert.ok(
    fakes.stderr.text().endsWith(
      "ERROR: certificate verification failed for https://server:7001. A local " +
        "server uses a self-signed certificate, so add --insecure.\n",
    ),
    fakes.stderr.text(),
  );
});

test("a cloud certificate failure does not suggest insecure", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  const makeCloud = fakes.deps.makeCloud;
  fakes.deps.makeCloud = (url) => {
    const cloud = makeCloud(url);
    cloud.login = async () => {
      throw Object.assign(new Error("unable to get local issuer certificate"), {
        code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        url: "https://cloud.example.com/cdb/oauth2/token",
      });
    };
    return cloud;
  };

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, CLOUD_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  const err = fakes.stderr.text();
  assert.equal(code, 1);
  assert.ok(err.includes("certificate verification failed for https://cloud.example.com."), err);
  assert.ok(err.includes("--insecure applies to the server only"), err);
  assert.ok(!err.includes("so add --insecure"), err);
});

test("a TLS error that is not a certificate failure is reported as it is", async (t) => {
  // For example https pointed at an http port: --insecure would not help.
  const dir = tempDir(t);
  const fakes = makeFakes();
  fakes.overrides.getSiteInfo = async () => {
    throw Object.assign(new Error("wrong version number"), {
      code: "ERR_SSL_WRONG_VERSION_NUMBER",
      url: "https://server:7001/rest/v4/site/info",
    });
  };

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  const err = fakes.stderr.text();
  assert.equal(code, 1);
  assert.ok(err.includes("ERROR: could not complete a request to https://server:7001: "), err);
  assert.ok(err.includes("wrong version number"), err);
  assert.ok(!err.includes("--insecure"), err);
});

test("a failed logout is not fatal", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  fakes.overrides.logout = async function () {
    // Only the final logout, the one main() makes after the run.
    this.token = null;
    if (names(this.log).includes("server.apply_settings")) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("gone"), { code: "ECONNRESET" }),
      });
    }
  };

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(code, 0);
});

test("insecure turns tls verification off for the server only", async (t) => {
  const dir = tempDir(t);
  const envFile = writeEnvFile(dir, SERVER_ENV);
  const none = path.join(dir, "none.json");

  const first = makeFakes();
  await run(first, ["--dotenv", envFile, "--settings-file", none]);
  assert.equal(first.server.verifyTls, true);

  const second = makeFakes();
  await run(second, ["--dotenv", envFile, "--settings-file", none, "--insecure"]);
  assert.equal(second.server.verifyTls, false);
});

test("insecure never turns TLS verification off for the Cloud", async (t) => {
  // The Cloud password must never be sent without a certificate check.
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, CLOUD_ENV),
    "--settings-file", path.join(dir, "none.json"),
    "--insecure",
  ]);

  assert.equal(code, 0, fakes.stderr.text());
  assert.equal(fakes.server.verifyTls, false);
  assert.equal(fakes.cloud.verifyTls, true);
});

test("main refuses an existing site without --yes and exits 1", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  fakes.info = EXISTING;

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(code, 1);
  assert.match(fakes.stderr.text(), /^ERROR: .*--yes/m);
  assert.deepEqual(names(fakes.log), ["server.get_site_info", "server.logout"]);
});

test("main with --yes updates an existing site", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  fakes.info = EXISTING;

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", writeSettingsFile(dir, '{"statisticsAllowed": false}'),
    "--yes",
  ]);

  assert.equal(code, 0);
  assert.ok(fakes.stdout.text().includes("Front Office"));
  assert.ok(names(fakes.log).includes("server.apply_settings"));
});

test("main connects to the cloud only when asked", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(fakes.cloud, null);
});

test("main with cloud prints the owner", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, CLOUD_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(code, 0);
  assert.ok(fakes.stdout.text().includes("owner@example.com"));
});

// ---------------------------------------------------------------------------
// The settings file
// ---------------------------------------------------------------------------

test("a missing settings file names no settings", (t) => {
  assert.deepEqual(loadSettings(path.join(tempDir(t), "no-such-file.json")), {});
});

for (const name of ["autoDiscoveryEnabled", "cameraSettingsOptimization", "statisticsAllowed"]) {
  test(`a false in the file goes out as false under the same name (${name})`, (t) => {
    // The wire field name is the key in the file, unchanged.
    const file = writeSettingsFile(tempDir(t), `{"${name}": false}`);

    assert.deepEqual(loadSettings(file), { [name]: false });
  });
}

for (const value of ['"false"', "0", "1", "null", "[]"]) {
  test(`a non-boolean value is a config error (${value})`, (t) => {
    const file = writeSettingsFile(tempDir(t), `{"autoDiscoveryEnabled": ${value}}`);
    assert.throws(() => loadSettings(file), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /autoDiscoveryEnabled/);
      return true;
    });
  });
}

test("a settings file that exists but cannot be read is a config error", (t) => {
  const dir = tempDir(t);
  assert.throws(() => loadSettings(dir), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.message.startsWith(`Cannot read ${dir}: `));
    assert.match(err.message, /: .+\.$/);
    return true;
  });
});

for (const [value, shown] of [
  ['"false"', '"false"'],
  ["null", "null"],
  ["1", "1"],
  ["[]", "[]"],
]) {
  test(`a non-boolean value is named as its json text (${value})`, (t) => {
    const file = writeSettingsFile(tempDir(t), `{"statisticsAllowed": ${value}}`);
    assert.throws(() => loadSettings(file), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.message, `statisticsAllowed must be true or false, not ${shown}.`);
      return true;
    });
  });
}

test("an unsupported setting is a config error that points at the readme", (t) => {
  const file = writeSettingsFile(tempDir(t), '{"auditTrailEnabled": true}');
  assert.throws(() => loadSettings(file), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.ok(err.message.includes("auditTrailEnabled"));
    assert.ok(err.message.includes("README"));
    return true;
  });
});

for (const text of ["{not json", "[true, false]", '"text"']) {
  test(`a settings file that is not a json object is a config error (${text})`, (t) => {
    const file = writeSettingsFile(tempDir(t), text);
    assert.throws(() => loadSettings(file), (err) => {
      assert.ok(err instanceof ConfigError);
      assert.match(err.message, /JSON/);
      return true;
    });
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/** A client that holds a bearer token, as after a login. */
function loggedInClient(responses) {
  const made = makeClient(responses);
  made.client._storeToken("tok-1");
  return made;
}

test("get site info needs no login and returns the reply", async () => {
  const info = { name: "Front Office", localId: "{1b2c}" };
  const { client, calls } = makeClient([["GET", "/site/info", fakeResponse(200, info)]]);

  assert.deepEqual(await client.getSiteInfo(), info);
  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].url.endsWith("/rest/v4/site/info"));
  assert.equal("Authorization" in calls[0].headers, false);
});

test("a site info reply that is not a json object is an ApiError", async () => {
  const { client } = makeClient([["GET", "/site/info", fakeResponse(200, ["x"])]]);
  await assert.rejects(() => client.getSiteInfo(), ApiError);
});

test("setup without a login is refused before anything is sent", async () => {
  // site/setup needs an administrator, so an anonymous call cannot work.
  const { client, calls } = makeClient();
  await assert.rejects(() => client.setup("My Site", "admin-pass", THREE_TRUE), /Not logged in/);
  assert.deepEqual(calls, []);
});

test("the fake server refuses an anonymous setup like a real one", async () => {
  const { client } = makeClient();
  client.token = "tok-1"; // bypass the guard, send no Authorization
  await assert.rejects(
    () => client.setup("My Site", "admin-pass", THREE_TRUE),
    (err) => err instanceof ApiError && /401/.test(err.message),
  );
});

test("setup posts name, password and settings with the bearer token", async () => {
  const { client, calls } = loggedInClient();

  await client.setup("My Site", "admin-pass", THREE_TRUE);

  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/rest/v4/site/setup"));
  assert.equal(calls[0].headers.Authorization, "Bearer tok-1");
  assert.deepEqual(calls[0].body, {
    name: "My Site",
    local: { password: "admin-pass" },
    settings: THREE_TRUE,
  });
});

test("setup for a cloud site sends cloud instead of local", async () => {
  const { client, calls } = loggedInClient();
  const cloud = { authKey: "k", owner: "owner@example.com", siteId: "s" };

  await client.setup("My Site", null, THREE_TRUE, cloud);

  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/rest/v4/site/setup"));
  assert.deepEqual(calls[0].body, { name: "My Site", settings: THREE_TRUE, cloud });
});

for (const status of [400, 401, 403, 409, 422, 500, 503]) {
  test(`a refused setup raises with its status and body (${status})`, async () => {
    // Only a 2xx is success. A 3xx is refused before this, as a redirect (see
    // "a redirect is an error and is not followed").
    const { client } = loggedInClient([
      ["POST", "/site/setup", fakeResponse(status, undefined, "password too weak")],
    ]);

    await assert.rejects(
      () => client.setup("My Site", "admin-pass", THREE_TRUE),
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, `Site setup was refused (HTTP ${status}: password too weak).`);
        return true;
      },
    );
  });
}

test("setup keeps only the start of a long error body", async () => {
  const { client } = loggedInClient([
    ["POST", "/site/setup", fakeResponse(400, undefined, "x".repeat(5000))],
  ]);
  await assert.rejects(
    () => client.setup("My Site", "admin-pass", THREE_TRUE),
    (err) => err instanceof ApiError && err.message.length < 400,
  );
});

test("get settings returns the settings object", async () => {
  const current = { siteName: "My Site", autoDiscoveryEnabled: false };
  const { client, calls } = makeClient([["GET", "/site/settings", fakeResponse(200, current)]]);
  client.token = "tok-1";

  assert.deepEqual(await client.getSettings(), current);

  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].url.endsWith("/rest/v4/site/settings"));
});

test("get settings without login raises", async () => {
  await assert.rejects(() => makeClient().client.getSettings(), ApiError);
});

test("apply settings patches only the settings that differ", async () => {
  const current = {
    autoDiscoveryEnabled: true,
    cameraSettingsOptimization: false,
    statisticsAllowed: true,
  };
  const { client, calls } = makeClient([["GET", "/site/settings", fakeResponse(200, current)]]);
  client.token = "tok-1";

  const changed = await client.applySettings(THREE_TRUE);

  assert.deepEqual(changed, { cameraSettingsOptimization: true });
  const last = calls[calls.length - 1];
  assert.equal(last.method, "PATCH");
  assert.ok(last.url.endsWith("/rest/v4/site/settings"));
  assert.deepEqual(last.body, { cameraSettingsOptimization: true });
});

test("cloud bind sends key, owner and site id", async () => {
  const { client, calls } = makeClient();
  client.token = "tok-1";

  await client.cloudBind("auth-key-1", "owner@example.com", "site-id-1");

  assert.equal(calls[0].method, "POST");
  assert.ok(calls[0].url.endsWith("/rest/v4/cloud/bind"));
  assert.deepEqual(calls[0].body, {
    authKey: "auth-key-1",
    owner: "owner@example.com",
    siteId: "site-id-1",
  });
});

test("cloud bind without login raises", async () => {
  await assert.rejects(() => makeClient().client.cloudBind("k", "o@example.com", "s"), ApiError);
});

test("cloud login requests a cloud wide bearer token", async () => {
  const { client, calls } = makeCloudClient([
    ["POST", "/cdb/oauth2/token", fakeResponse(200, { access_token: "nxcdb-1" })],
  ]);

  const token = await client.login("owner@example.com", "cloud-pass");

  assert.equal(token, "nxcdb-1");
  assert.equal(client.headers.Authorization, "Bearer nxcdb-1");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://cloud.example.com/cdb/oauth2/token");
  assert.deepEqual(calls[0].body, {
    grant_type: "password",
    response_type: "token",
    client_id: "3rdParty",
    username: "owner@example.com",
    password: "cloud-pass",
  });
  assert.equal("scope" in calls[0].body, false, "a scoped token cannot register a new site");
});

for (const status of [401, 403]) {
  test(`cloud login rejected raises AuthError (${status})`, async () => {
    const { client } = makeCloudClient([["POST", "/cdb/oauth2/token", fakeResponse(status)]]);
    await assert.rejects(() => client.login("owner@example.com", "wrong"), (err) => {
      assert.ok(err instanceof AuthError);
      assert.match(err.message, /Cloud/);
      return true;
    });
  });
}

test("cloud login without access token raises ApiError", async () => {
  const { client } = makeCloudClient([["POST", "/cdb/oauth2/token", fakeResponse(200, {})]]);
  await assert.rejects(() => client.login("owner@example.com", "cloud-pass"), ApiError);
  assert.equal("Authorization" in client.headers, false);
});

const REGISTERED = { id: "site-id-1", authKey: "auth-key-1", name: "My Site" };

test("register site for a personal account has no organization id", async () => {
  const { client, calls } = makeCloudClient([
    ["POST", "/cdb/systems/bind", fakeResponse(200, REGISTERED)],
  ]);
  client.token = "nxcdb-1";

  const result = await client.registerSite("My Site", "default");

  assert.deepEqual(result, { siteId: "site-id-1", authKey: "auth-key-1" });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://cloud.example.com/cdb/systems/bind");
  assert.deepEqual(calls[0].body, { name: "My Site", customization: "default", opaque: "" });
  assert.equal("organizationId" in calls[0].body, false);
});

test("register site for an organization uses the partners api", async () => {
  const { client, calls } = makeCloudClient([
    ["POST", "/partners/api/v3/cloud_systems/", fakeResponse(200, REGISTERED)],
  ]);
  client.token = "nxcdb-1";

  const result = await client.registerSite("My Site", "default", "org-1");

  assert.deepEqual(result, { siteId: REGISTERED.id, authKey: REGISTERED.authKey });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://cloud.example.com/partners/api/v3/cloud_systems/");
  assert.deepEqual(calls[0].body, {
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
test("cloud bind for an organization still sends the owner", async () => {
  const { client, calls } = makeClient();
  client.token = "tok-1";
  await client.cloudBind("auth-key-1", "owner@example.com", "site-id-1", "org-1");
  assert.deepEqual(calls[0].body, {
    authKey: "auth-key-1",
    owner: "owner@example.com",
    siteId: "site-id-1",
    organizationId: "org-1",
  });
});

test("register site without login raises", async () => {
  await assert.rejects(() => makeCloudClient().client.registerSite("My Site", "default"), ApiError);
});

for (const payload of [{}, { id: "site-id-1" }, { authKey: "k" }]) {
  test(`register site response missing id or key raises ApiError (${JSON.stringify(payload)})`, async () => {
    const { client } = makeCloudClient([["POST", "/cdb/systems/bind", fakeResponse(200, payload)]]);
    client.token = "nxcdb-1";
    await assert.rejects(() => client.registerSite("My Site", "default"), ApiError);
  });
}

test("apply settings sends nothing when everything already matches", async () => {
  const { client, calls } = makeClient([
    ["GET", "/site/settings", fakeResponse(200, { ...THREE_TRUE })],
  ]);
  client.token = "tok-1";

  assert.deepEqual(await client.applySettings(THREE_TRUE), {});
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

// ---------------------------------------------------------------------------
// Replies that are not JSON
// ---------------------------------------------------------------------------

const rejectsWithApiError = (call, message) =>
  assert.rejects(call, (err) => {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err.name}`);
    assert.equal(err.message, message);
    return true;
  });

test("a login reply that is not json is an ApiError", async () => {
  const { client } = makeClient([["POST", "/login/sessions", notJsonResponse()]]);
  await rejectsWithApiError(() => client.login("admin", "secret"), "Login response was not valid JSON.");
  assert.equal(client.token, null);
});

test("a settings reply that is not json is an ApiError", async () => {
  const { client } = makeClient([["GET", "/site/settings", notJsonResponse()]]);
  client.token = "tok-1";
  await rejectsWithApiError(() => client.getSettings(), "Settings response was not valid JSON.");
});

test("a cloud login reply that is not json is an ApiError", async () => {
  const { client } = makeCloudClient([["POST", "/cdb/oauth2/token", notJsonResponse()]]);
  await rejectsWithApiError(
    () => client.login("owner@example.com", "cloud-pass"),
    "Cloud login response was not valid JSON.",
  );
});

test("a cloud bind reply that is not json is an ApiError", async () => {
  const { client } = makeCloudClient([["POST", "/cdb/systems/bind", notJsonResponse()]]);
  client.token = "nxcdb-1";
  await rejectsWithApiError(
    () => client.registerSite("My Site", "default"),
    "Cloud bind reply was not valid JSON.",
  );
});

test("main exits 1 with the message when a reply is not json", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  const fake = fakeFetch([["POST", "/login/sessions", notJsonResponse()]]);
  fakes.deps.makeServer = (host) => new NxServerClient(host, { fetchImpl: fake.fetchImpl });

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", writeSettingsFile(dir, "{}"),
  ]);

  assert.equal(code, 1);
  assert.equal(fakes.stderr.text(), "ERROR: Login response was not valid JSON.\n");
});

// ---------------------------------------------------------------------------
// main(): which failures are reported and which are bugs
// ---------------------------------------------------------------------------

/** Run main with the setup step throwing `error`. */
async function runWithSetupThrowing(t, error) {
  const dir = tempDir(t);
  const fakes = makeFakes();
  fakes.overrides.setup = async () => {
    throw error;
  };
  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", writeSettingsFile(dir, "{}"),
  ]);
  return { code, fakes };
}

test("main reports a socket error with the host and the detail", async (t) => {
  const error = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:7001"), {
    code: "ECONNREFUSED",
  });

  const { code, fakes } = await runWithSetupThrowing(t, error);

  assert.equal(code, 1);
  assert.equal(
    fakes.stderr.text(),
    "ERROR: could not complete a request to https://server:7001: " +
      "connect ECONNREFUSED 10.0.0.1:7001\n",
  );
});

test("main reports an unexpected http status with the host", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  const fake = fakeFetch([["POST", "/login/sessions", fakeResponse(500)]]);
  fakes.deps.makeServer = (host) => new NxServerClient(host, { fetchImpl: fake.fetchImpl });

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", writeSettingsFile(dir, "{}"),
  ]);

  assert.equal(code, 1);
  assert.equal(
    fakes.stderr.text(),
    "ERROR: could not complete a request to https://server:7001: HTTP 500\n",
  );
});

for (const bug of [
  new TypeError("x is not a function"),
  new SyntaxError("Unexpected token"),
  new RangeError("out of range"),
  Object.assign(new Error("aborted"), { name: "AbortError" }),
]) {
  test(`main does not swallow a bug, it rethrows it (${bug.name})`, async (t) => {
    const dir = tempDir(t);
    const fakes = makeFakes();
    fakes.overrides.setup = async () => {
      throw bug;
    };

    await assert.rejects(
      () => run(fakes, [
        "--dotenv", writeEnvFile(dir, SERVER_ENV),
        "--settings-file", writeSettingsFile(dir, "{}"),
      ]),
      (err) => err === bug,
    );

    assert.equal(fakes.stderr.text(), "");
    assert.equal(fakes.server.loggedOut, true);
  });
}

// ---------------------------------------------------------------------------
// The command line, and the real transport
// ---------------------------------------------------------------------------

test("--dotenv is the config flag here, not --env-file", () => {
  assert.equal(parseArgs(["--dotenv", "../../.env"]).envFile, "../../.env");
  assert.throws(() => parseArgs(["--env-file", "../../.env"]), /Unknown argument/);
});

test("parseArgs reads every flag and defaults the rest", () => {
  const args = parseArgs([
    "--host", "https://h:7001", "--password=pw", "--settings-file", "s.json", "--insecure",
  ]);
  assert.equal(args.host, "https://h:7001");
  assert.equal(args.password, "pw");
  assert.equal(args.settingsFile, "s.json");
  assert.equal(args.insecure, true);
  assert.equal(parseArgs(["--yes"]).yes, true);
  assert.equal(parseArgs([]).envFile, ".env");
  assert.equal(parseArgs([]).insecure, false);
  assert.equal(parseArgs([]).yes, false);
  assert.equal(parseArgs([]).mfaCode, null);
});

test("a bad command line exits 2", async () => {
  const fakes = makeFakes();
  assert.equal(await run(fakes, ["--password"]), 2);
  assert.equal(await run(fakes, ["--bogus"]), 2);
  assert.deepEqual(fakes.log, []);
});

for (const [argv, message] of [
  [["extra"], "Unexpected argument: extra"],
  [["--bogus"], "Unknown argument: --bogus"],
  [["--password"], "Missing value for --password"],
  [["--mfa-code"], "Missing value for --mfa-code"],
  [["--insecure=yes"], "--insecure takes no value"],
  [["--yes=1"], "--yes takes no value"],
]) {
  test(`a bad command line prints ERROR, the message, then the usage (${argv[0]})`, async () => {
    const fakes = makeFakes();

    assert.equal(await run(fakes, argv), 2);

    const lines = fakes.stderr.text().split("\n");
    assert.equal(lines[0], `ERROR: ${message}`);
    assert.match(lines[1], /^Usage: rest_configure_site\.mjs/);
    assert.equal(fakes.stdout.text(), "");
    assert.deepEqual(fakes.log, []);
  });
}

test("the default transport sends json and a bearer header, and reads the reply", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ token: "tok-1" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const client = new NxServerClient(`http://127.0.0.1:${port}`, {
      fetchImpl: makeFetch({ verifyTls: false }),
    });
    assert.equal(await client.login("admin", "secret"), "tok-1");
    await client.logout();
    assert.equal(seen[0].url, "/rest/v4/login/sessions");
    assert.deepEqual(JSON.parse(seen[0].body), { username: "admin", password: "secret" });
    assert.equal(seen[1].method, "DELETE");
    assert.equal(seen[1].auth, "Bearer tok-1");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// Redirects, non-object replies, broken addresses, Cloud safety
// ---------------------------------------------------------------------------

/**
 * A real local HTTP server that answers every request with one fixed reply, so
 * the real transport (makeFetch) and its redirect handling are exercised.
 * `sent` records each request path. Closed when the test ends.
 */
async function oneReplyServer(t, status, headers = {}, body = "{}") {
  const sent = [];
  const server = http.createServer((req, res) => {
    sent.push(req.url);
    req.resume();
    req.on("end", () => {
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, sent };
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`a redirect is an error and is not followed (${status})`, async (t) => {
    // Following it could turn a POST into a GET that "succeeds".
    const { url, sent } = await oneReplyServer(t, status, { Location: "https://elsewhere/" });
    const client = new NxServerClient(url, { fetchImpl: makeFetch() });
    client._storeToken("tok-1");

    await assert.rejects(
      () => client.setup("My Site", "admin-pass", THREE_TRUE),
      (err) => {
        assert.ok(err instanceof ApiError, `expected an ApiError, got ${err.name}`);
        assert.match(err.message, new RegExp(`HTTP ${status}`));
        assert.ok(err.message.includes("to https://elsewhere)."), err.message);
        return true;
      },
    );
    assert.deepEqual(sent, ["/rest/v4/site/setup"]);
  });
}

test("the cloud client refuses redirects too", async (t) => {
  const { url } = await oneReplyServer(t, 302, { Location: "https://x/" });
  const cloud = new NxCloudClient(url, { fetchImpl: makeFetch() });
  await assert.rejects(
    () => cloud.login("owner@example.com", "cloud-pass"),
    (err) => err instanceof ApiError && /redirect/.test(err.message),
  );
});

/** A 200 whose json() gives `body` as it is, null included. */
const replyOf = (body) => ({ status: 200, payload: body, text: JSON.stringify(body) });

for (const body of [[], [1], null, "text", 5]) {
  test(`a reply that is json but not an object is an ApiError (${JSON.stringify(body)})`, async () => {
    const { client } = makeClient([["GET", "/site/settings", replyOf(body)]]);
    client.token = "tok-1";
    await rejectsWithApiError(() => client.getSettings(), "Settings response was not a JSON object.");
  });
}

test("a login reply of null is an ApiError, not a crash", async () => {
  const { client } = makeClient([["POST", "/login/sessions", replyOf(null)]]);
  await rejectsWithApiError(() => client.login("admin", "pw"), "Login response was not a JSON object.");
});

test("a cloud login reply of null is an ApiError, not a crash", async () => {
  const { client } = makeCloudClient([["POST", "/cdb/oauth2/token", replyOf(null)]]);
  await rejectsWithApiError(
    () => client.login("owner@example.com", "cloud-pass"),
    "Cloud login response was not a JSON object.",
  );
});

test("a cloud bind reply of null is an ApiError, not a crash", async () => {
  const { client } = makeCloudClient([["POST", "/cdb/systems/bind", replyOf(null)]]);
  client.token = "t";
  await rejectsWithApiError(
    () => client.registerSite("My Site", "default"),
    "Cloud bind reply was not a JSON object.",
  );
});

for (const payload of [
  { id: 7, authKey: "k" }, { id: "i", authKey: 9 }, { id: ["i"], authKey: "k" },
]) {
  test(`a bind reply id and key must be text (${JSON.stringify(payload)})`, async () => {
    const { client } = makeCloudClient([["POST", "/cdb/systems/bind", fakeResponse(200, payload)]]);
    client.token = "t";
    await assert.rejects(() => client.registerSite("My Site", "default"), /both an id and an authKey/);
  });
}

for (const bad of ["http://[abc", "https://[::1"]) {
  test(`a broken ipv6 address is a config error, not a crash (${bad})`, () => {
    assert.throws(
      () => resolveConfig({}, { ...SERVER_ENV, NX_SERVER_HOST: bad }, {}),
      (err) => err instanceof ConfigError && /full URL/.test(err.message),
    );
  });
}

test("a broken cloud host reported by the server is an ApiError", () => {
  assert.throws(
    () => cloudTarget(FLOW_CLOUD_CONFIG, { cloudHost: "[abc", customization: "default" }),
    ApiError,
  );
});

test("NX_CLOUD_HOST must be https", () => {
  assert.throws(
    () => resolveConfig({}, { ...CLOUD_ENV, NX_CLOUD_HOST: "http://nxvms.com" }, {}),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(
        err.message,
        "NX_CLOUD_HOST must be an https:// address, because the Cloud password is " +
          'sent there, not "http://nxvms.com".',
      );
      return true;
    },
  );
});

test("a cloud the server reports as plain http is refused", () => {
  assert.throws(
    () => cloudTarget(
      { ...FLOW_CLOUD_CONFIG, cloudHost: null },
      { cloudHost: "http://cloud.example.com", customization: "default" },
    ),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(
        err.message,
        'The server reports its Cloud as "http://cloud.example.com", which is not an ' +
          "https:// address, so the sample will not send the Cloud password there.",
      );
      return true;
    },
  );
});

test("with insecure the cloud host must be given", () => {
  // Without a checked certificate the server could be anyone, so the Cloud it
  // names must not receive the Cloud password.
  const env = without(CLOUD_ENV, "NX_CLOUD_HOST");
  assert.throws(
    () => resolveConfig({ insecure: true }, env, {}),
    (err) => err instanceof ConfigError && /^With --insecure, set NX_CLOUD_HOST/.test(err.message),
  );
  assert.ok(resolveConfig({ insecure: true }, CLOUD_ENV, {}).cloudHost);
  assert.equal(resolveConfig({}, env, {}).cloudHost, null);
});

test("main exits 2 for insecure cloud without a cloud host", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, without(CLOUD_ENV, "NX_CLOUD_HOST")), "--insecure",
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(code, 2);
  assert.match(fakes.stderr.text(), /NX_CLOUD_HOST/);
  assert.equal(fakes.server, null);
  assert.deepEqual(fakes.log, []);
});

// ---------------------------------------------------------------------------
// Cloud login first, two-factor accounts, and which host an error names
// ---------------------------------------------------------------------------

test("a failed cloud login leaves a new server untouched", async () => {
  const log = [];
  await assert.rejects(
    () => configureSite(
      FLOW_CLOUD_CONFIG, THREE_TRUE, new FakeServer({ log }),
      new FakeCloud({ log, fail: "cloud.login" }).make,
    ),
    ApiError,
  );
  assert.deepEqual(names(log), ["server.get_site_info", "cloud.login"]);
});

test("an existing site is refused before the cloud login", async () => {
  const log = [];
  await assert.rejects(
    () => configureSite(
      FLOW_CLOUD_CONFIG, THREE_TRUE, new FakeServer({ info: EXISTING, log }),
      new FakeCloud({ log }).make,
    ),
    ExistingSiteError,
  );
  assert.deepEqual(names(log), ["server.get_site_info"]);
});

test("a failed cloud request names the cloud, not the server", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();
  const makeCloud = fakes.deps.makeCloud;
  fakes.deps.makeCloud = (url) => {
    const cloud = makeCloud(url);
    cloud.registerSite = async () => {
      throw new HttpError(403, "https://cloud.example.com/cdb/systems/bind");
    };
    return cloud;
  };

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, CLOUD_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  const err = fakes.stderr.text();
  assert.equal(code, 1);
  assert.ok(err.includes("could not complete a request to https://cloud.example.com:"), err);
  assert.ok(!err.includes("server:7001"), err);
});

test("an HTTP error and a network error carry the url of the request", async () => {
  const { client } = makeCloudClient([
    ["POST", "/cdb/oauth2/token", fakeResponse(200, { access_token: "t" })],
    ["POST", "/cdb/systems/bind", fakeResponse(403)],
  ]);
  await client.login("owner@example.com", "cloud-pass");
  await assert.rejects(() => client.registerSite("My Site", "default"), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.url, "https://cloud.example.com/cdb/systems/bind");
    return true;
  });

  const offline = new NxCloudClient("https://cloud.example.com", {
    fetchImpl: async () => {
      throw Object.assign(new Error("no route"), { code: "ECONNREFUSED" });
    },
  });
  await assert.rejects(() => offline.login("owner@example.com", "cloud-pass"), (err) => {
    assert.equal(err.url, "https://cloud.example.com/cdb/oauth2/token");
    return true;
  });
});

// ---------------------------------------------------------------------------
// Two-factor authentication on the Cloud account
// ---------------------------------------------------------------------------

const TWO_FA_LOGIN = fakeResponse(200, { access_token: "t-2fa", error: "second_factor_required" });

test("a two-factor login is confirmed with the code, then used", async () => {
  // The Cloud answers HTTP 200 with a token and second_factor_required; the
  // same token works once GET .../2fa/totp/key/{code}?token=... accepts it.
  const { client, calls } = makeCloudClient([
    ["POST", "/cdb/oauth2/token", TWO_FA_LOGIN],
    ["GET", "/totp/key/123456?token=t-2fa", fakeResponse(200, {})],
  ]);

  const token = await client.login("owner@example.com", "cloud-pass", () => " 123456 ");

  assert.equal(token, "t-2fa");
  assert.equal(client.headers.Authorization, "Bearer t-2fa");
  assert.equal(calls[1].method, "GET");
  assert.equal(
    calls[1].url,
    "https://cloud.example.com/cdb/account/self/2fa/totp/key/123456?token=t-2fa",
  );
  const url = new URL(calls[1].url);
  assert.equal(url.searchParams.get("token"), "t-2fa");
  assert.equal("Authorization" in calls[1].headers, false);
});

test("a two-factor login without a code says how to give one", async () => {
  const { client, calls } = makeCloudClient([["POST", "/cdb/oauth2/token", TWO_FA_LOGIN]]);

  await assert.rejects(() => client.login("owner@example.com", "cloud-pass", null), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(
      err.message,
      "Cloud login for owner@example.com needs a two-factor code. Run again with " +
        "--mfa-code <the 6-digit code from your authenticator app>, or run it in a " +
        "terminal to be asked for one.",
    );
    return true;
  });
  assert.equal(client.token, null);
  assert.equal(calls.length, 1);
});

for (const status of [400, 401, 403]) {
  test(`a wrong two-factor code is an auth error (HTTP ${status})`, async () => {
    // The Cloud answers a wrong code with 403 "Wrong totp".
    const { client } = makeCloudClient([
      ["POST", "/cdb/oauth2/token", TWO_FA_LOGIN],
      ["GET", "/totp/key/000000?token=t-2fa", fakeResponse(status)],
    ]);

    await assert.rejects(
      () => client.login("owner@example.com", "cloud-pass", () => "000000"),
      (err) => {
        assert.ok(err instanceof AuthError);
        assert.match(err.message, /two-factor code was not accepted/);
        return true;
      },
    );
    assert.equal(client.token, null);
  });
}

test("an account without two-factor is never asked for a code", async () => {
  const { client, calls } = makeCloudClient([
    ["POST", "/cdb/oauth2/token", fakeResponse(200, { access_token: "t" })],
  ]);
  const mustNotBeCalled = () => {
    throw new Error("asked for a code");
  };

  assert.equal(await client.login("owner@example.com", "cloud-pass", mustNotBeCalled), "t");
  assert.equal(calls.length, 1);
});

test("the flow hands the code source to the cloud login", async () => {
  const cloud = new FakeCloud();
  const source = () => "123456";
  await configureSite(FLOW_CLOUD_CONFIG, THREE_TRUE, new FakeServer(), cloud.make, {
    getMfaCode: source,
  });
  assert.equal(cloud.getMfaCode, source);
});

test("the code comes from the flag first", async () => {
  const source = mfaCodeSource({ mfaCode: "654321" }, {}, { stdin: { isTTY: true } });
  assert.equal(await source(), "654321");
});

test("without the flag a terminal is asked for the code", async () => {
  const asked = [];
  const source = mfaCodeSource(
    { mfaCode: null },
    { cloudUser: "owner@example.com" },
    {
      stdin: { isTTY: true },
      ask: async (prompt) => {
        asked.push(prompt);
        return " 111222 ";
      },
    },
  );
  assert.equal(await source(), "111222");
  assert.deepEqual(asked, ["Two-factor code for owner@example.com: "]);
});

test("without the flag or a terminal there is no code", () => {
  assert.equal(mfaCodeSource({ mfaCode: null }, {}, { stdin: { isTTY: false } }), null);
});

test("--mfa-code is a command-line flag", () => {
  assert.equal(parseArgs(["--mfa-code", "123456"]).mfaCode, "123456");
  assert.equal(parseArgs(["--mfa-code=123456"]).mfaCode, "123456");
});

test("an HTTP error includes the server's reason but not the url", async () => {
  const body = '{"error": "4", "errorId": "cantProcessRequest", "errorString": "Site is already bound."}';
  const { client } = makeClient([["POST", "/rest/v4/cloud/bind", fakeResponse(422, undefined, body)]]);
  client.token = "SECRET-token";

  await assert.rejects(() => client.cloudBind("SECRET-key", "owner@example.com", "site-id-1"), (err) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.message, "HTTP 422: Site is already bound.");
    assert.ok(!err.message.includes("server:7001"), err.message);
    assert.ok(!err.message.includes("SECRET"), err.message);
    return true;
  });
});

test("a Channel Partners error shows the detail from its errors list", async () => {
  const body = JSON.stringify({
    type: "client_error",
    errors: [{ code: "permission_denied", detail: "You do not have permission.", attr: null }],
  });
  assert.equal(await errorText({ text: async () => body }), "You do not have permission.");
});


/**
 * Replace https.request for the length of `run`, answering each Nx call with a
 * canned JSON reply and recording the host and rejectUnauthorized of every
 * request. The real clients and transport run unchanged.
 */
async function withRecordedHttps(replies, run) {
  const seen = [];
  const original = https.request;
  https.request = (target, options, onResponse) => {
    const url = new URL(target);
    seen.push({ host: url.host, rejectUnauthorized: options.rejectUnauthorized });
    const key = Object.keys(replies).find((suffix) => url.pathname.startsWith(suffix));
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      setImmediate(() => {
        onResponse(res);
        res.emit("data", Buffer.from(JSON.stringify(key ? replies[key] : {})));
        res.emit("end");
      });
    };
    return req;
  };
  try {
    return { result: await run(), seen };
  } finally {
    https.request = original;
  }
}

test("with --insecure the real clients skip verification for the server, never for the Cloud", async (t) => {
  const dir = tempDir(t);
  const stderr = memoryStream();
  const { result, seen } = await withRecordedHttps(
    {
      "/rest/v4/site/info": { cloudHost: "cloud.example.com", customization: "default" },
      "/rest/v4/login/sessions": { token: "tok-1" },
      "/cdb/oauth2/token": { access_token: "cloud-tok" },
      "/cdb/systems/bind": { id: "site-id-1", authKey: "auth-key-1" },
    },
    () =>
      realMain(["--dotenv", writeEnvFile(dir, CLOUD_ENV), "--insecure",
            "--settings-file", path.join(dir, "none.json")],
           { env: {}, stdout: memoryStream(), stderr }),
  );

  assert.equal(result, 0, stderr.text());
  const verify = (host) => [...new Set(seen.filter((r) => r.host === host).map((r) => r.rejectUnauthorized))];
  assert.deepEqual(verify("server:7001"), [false]);
  assert.deepEqual(verify("cloud.example.com"), [true]);
});


// ---------------------------------------------------------------------------
// The Cloud token is revoked at the end of every run
// ---------------------------------------------------------------------------

test("cloud logout deletes the token and clears it", async () => {
  const { client, calls } = makeCloudClient();
  client._storeToken("cloud/tok");

  await client.logout();

  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, "https://cloud.example.com/cdb/oauth2/token/cloud%2Ftok");
  assert.equal(client.token, null);
  assert.equal("Authorization" in client.headers, false);
});

test("cloud logout without a token is a no-op", async () => {
  const { client, calls } = makeCloudClient();
  await client.logout();
  assert.deepEqual(calls, []);
});

test("main revokes the Cloud token after a run", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  const code = await run(fakes, [
    "--dotenv", writeEnvFile(dir, CLOUD_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(code, 0, fakes.stderr.text());
  assert.equal(fakes.cloud.loggedOut, true);
  assert.deepEqual(names(fakes.log).slice(-2), ["server.logout", "cloud.logout"]);
});

for (const failing of ["cloud.register_site", "server.setup"]) {
  test(`main revokes the Cloud token after a failed run (${failing})`, async (t) => {
    const dir = tempDir(t);
    const fakes = makeFakes();
    if (failing.startsWith("cloud.")) fakes.cloudFail = failing;
    else fakes.serverFail = failing;

    const code = await run(fakes, [
      "--dotenv", writeEnvFile(dir, CLOUD_ENV),
      "--settings-file", path.join(dir, "none.json"),
    ]);

    assert.equal(code, 1);
    assert.equal(fakes.cloud.loggedOut, true);
  });
}

test("a run without the Cloud revokes nothing", async (t) => {
  const dir = tempDir(t);
  const fakes = makeFakes();

  await run(fakes, [
    "--dotenv", writeEnvFile(dir, SERVER_ENV),
    "--settings-file", path.join(dir, "none.json"),
  ]);

  assert.equal(fakes.cloud, null);
  assert.equal(names(fakes.log).includes("cloud.logout"), false);
});

test("a redirect on the two-factor call names no token or code", async () => {
  // The confirmation URL carries the code and the Cloud token; a redirect
  // error must name only the addresses' origins.
  const cloud = new NxCloudClient("https://cloud.example.com", {
    fetchImpl: async () => ({
      status: 302,
      headers: { location: "https://proxy.example:8443/login?token=SECRET2" },
    }),
  });
  await assert.rejects(() => cloud._confirmSecondFactor("SECRET", "123456"), (err) => {
    assert.ok(err instanceof ApiError, `expected an ApiError, got ${err.name}`);
    assert.ok(
      err.message.startsWith(
        "https://cloud.example.com answered with a redirect " +
          "(HTTP 302 to https://proxy.example:8443).",
      ),
      err.message,
    );
    for (const secret of ["SECRET", "123456", "/cdb"]) {
      assert.equal(err.message.includes(secret), false, err.message);
    }
    return true;
  });
});
