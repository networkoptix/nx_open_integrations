// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-backup-client.mjs. No browser, no server, no network:
 * every call goes through an injected fake fetch.
 *
 * The dump is opaque binary. The spec documents no response schema for
 * GET /rest/v4/site/database, so these tests assert what the client does with
 * the bytes rather than what shape they have.
 *
 * Run from this folder:  node --test test_nx_backup_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxBackupClient,
  defaultOutName,
  loadServerHost,
  confirmsHost,
  AuthError,
  ApiError,
} from "./nx-backup-client.mjs";

// ---------------------------------------------------------------------------
// Fake HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Build a fake fetch plus the list it records into. Replies are matched by a
 * substring of the URL and the method, so a test says what it means rather
 * than counting calls.
 */
export function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: { ...(init.headers ?? {}) }, body: init.body });

    const match = replies.find(([suffix, m]) => url.includes(suffix) && m === method);
    const reply = match ? match[2] : { status: 200, json: {} };
    if (reply.throws) throw reply.throws;

    const status = reply.status ?? 200;
    const bytes = reply.bytes ?? new Uint8Array(0);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: (name) => (reply.headers ?? {})[String(name).toLowerCase()] ?? null,
      },
      json: async () => {
        if (reply.json === undefined) throw new Error("not json");
        return reply.json;
      },
      text: async () => reply.text ?? "",
      blob: async () => new Blob([bytes]),
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fetchImpl, calls };
}

const LOGIN_OK = ["/login/sessions", "POST", { status: 200, json: { token: "tok-1" } }];

export function makeClient(replies) {
  const { fetchImpl, calls } = fakeFetch(replies);
  return { client: new NxBackupClient({ fetchImpl }), calls };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test("login posts the credentials through the proxy route and stores the token", async () => {
  const { client, calls } = makeClient([LOGIN_OK]);

  const token = await client.login("admin", "secret");

  assert.equal(token, "tok-1");
  assert.equal(client.token, "tok-1");
  assert.equal(calls[0].method, "POST");
  // Relative, same-origin, and through /server: never straight at the VMS host.
  assert.equal(calls[0].url, "/server/rest/v4/login/sessions");
  assert.deepEqual(JSON.parse(calls[0].body), {
    username: "admin",
    password: "secret",
    setCookie: false,
  });
});

for (const status of [401, 403]) {
  test(`login throws AuthError on ${status}`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", { status }]]);
    await assert.rejects(() => client.login("admin", "wrong"), AuthError);
  });
}

test("login throws ApiError when the response carries no token", async () => {
  const { client } = makeClient([["/login/sessions", "POST", { status: 200, json: {} }]]);
  await assert.rejects(() => client.login("admin", "secret"), ApiError);
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test("logout deletes the session and clears the token", async () => {
  const { client, calls } = makeClient([LOGIN_OK]);
  await client.login("admin", "secret");

  await client.logout();

  const last = calls[calls.length - 1];
  assert.equal(last.method, "DELETE");
  assert.equal(last.url, "/server/rest/v4/login/sessions/tok-1");
  assert.equal(client.token, null);
});

test("logout without a token makes no request", async () => {
  const { client, calls } = makeClient([]);
  await client.logout();
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------------------
// The default dump name, which must match the CLI versions
// ---------------------------------------------------------------------------

test("the default output name matches the CLI format", () => {
  const moment = new Date(Date.UTC(2026, 8, 14, 3, 12, 0));

  assert.equal(
    defaultOutName("https://192.168.1.10:7001", moment),
    "nx-site-database-192-168-1-10-7001-20260914T031200Z.db",
  );
  assert.equal(
    defaultOutName("", moment),
    "nx-site-database-site-20260914T031200Z.db",
  );
});

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

test("backup gets the site database route with the bearer token", async () => {
  const { client, calls } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, bytes: new Uint8Array([1, 2]) }],
  ]);
  await client.login("admin", "secret");

  await client.backupDatabase();

  const last = calls[calls.length - 1];
  assert.equal(last.method, "GET");
  assert.equal(last.url, "/server/rest/v4/site/database");
  assert.equal(last.headers.Authorization, "Bearer tok-1");
});

test("backup returns a Blob of the exact bytes, not decoded text", async () => {
  // Opaque binary: bytes that are not valid UTF-8 must survive untouched.
  const dump = new Uint8Array([0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x1a, 0x80, 0x81]);
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, bytes: dump }],
  ]);
  await client.login("admin", "secret");

  const blob = await client.backupDatabase();

  assert.ok(blob instanceof Blob, "backupDatabase must hand back a Blob");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), dump);
});

test("backup rejects an empty dump", async () => {
  // A zero byte body is never a valid dump, and a browser would otherwise
  // cheerfully offer to save an empty file.
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, bytes: new Uint8Array(0) }],
  ]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.backupDatabase(), ApiError);
});

test("backup throws AuthError on 401", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 401, bytes: new Uint8Array([1]) }],
  ]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.backupDatabase(), AuthError);
});

test("backup's 403 names the role and the fresh-session rule", async () => {
  // The spec's permission line is "Administrator with a fresh session", and a
  // 403 here is nearly always one of those two, so the message must say both.
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 403, bytes: new Uint8Array([1]) }],
  ]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.backupDatabase(), (err) => {
    assert.ok(err instanceof AuthError);
    const m = err.message.toLowerCase();
    assert.ok(m.includes("administrator"), "must name the role");
    assert.ok(m.includes("fresh session"), "must name the fresh-session rule");
    return true;
  });
});

test("backup throws ApiError on a server error", async () => {
  // The body is non-empty on purpose: an error page must be rejected on its
  // status, not incidentally by the empty-dump check.
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", {
      status: 500,
      bytes: new TextEncoder().encode("<html>Internal Server Error</html>"),
    }],
  ]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.backupDatabase(), ApiError);
});

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** A stand-in for the File a browser hands back from <input type="file">. */
function fakeFile(bytes, name = "site.db") {
  return new File([bytes], name, { type: "application/octet-stream" });
}

test("restore refuses without explicit confirmation, and makes no request", async () => {
  // Loading a dump replaces the whole site configuration and restarts the
  // server. The guard lives here, not in the page, so it is testable: DOM is
  // out of scope for a browser sample's tests.
  const { client, calls } = makeClient([LOGIN_OK]);
  await client.login("admin", "secret");
  const before = calls.length;

  await assert.rejects(
    () => client.restoreDatabase(fakeFile(new Uint8Array([1, 2, 3]))),
    /confirm/i,
  );
  assert.equal(calls.length, before, "no request may be sent without confirmation");
});

test("restore refuses a zero byte file before any request", async () => {
  const { client, calls } = makeClient([LOGIN_OK]);
  await client.login("admin", "secret");
  const before = calls.length;

  await assert.rejects(
    () => client.restoreDatabase(fakeFile(new Uint8Array(0)), { confirmed: true }),
    /empty/i,
  );
  assert.equal(calls.length, before, "an empty file must never reach the server");
});

test("restore posts the file bytes unchanged as application/octet-stream", async () => {
  // No multipart wrapper, no base64, no FormData: the raw dump.
  const payload = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x81, 0x0d, 0x0a]);
  const { client, calls } = makeClient([
    LOGIN_OK,
    ["/site/database", "POST", { status: 200 }],
  ]);
  await client.login("admin", "secret");

  await client.restoreDatabase(fakeFile(payload), { confirmed: true });

  const last = calls[calls.length - 1];
  assert.equal(last.method, "POST");
  assert.equal(last.url, "/server/rest/v4/site/database");
  assert.equal(last.headers["Content-Type"], "application/octet-stream");
  assert.ok(!(last.body instanceof FormData), "must not be multipart");
  assert.deepEqual(new Uint8Array(await new Response(last.body).arrayBuffer()), payload);
});

for (const status of [401, 403]) {
  test(`restore throws AuthError on ${status}`, async () => {
    const { client } = makeClient([
      LOGIN_OK,
      ["/site/database", "POST", { status }],
    ]);
    await client.login("admin", "secret");

    await assert.rejects(
      () => client.restoreDatabase(fakeFile(new Uint8Array([1])), { confirmed: true }),
      (err) => {
        assert.ok(err instanceof AuthError);
        const m = err.message.toLowerCase();
        assert.ok(m.includes("administrator") && m.includes("fresh session"));
        return true;
      },
    );
  });
}

test("restore treats the proxy's dropped-connection marker as success", async () => {
  // The spec says the server restarts after loading, so it can cut the
  // connection before answering. In a browser, fetch would surface that as a
  // bare "Failed to fetch" with no status and no cause, which is also what a
  // dead proxy and a dead network look like. Treating every post-request
  // failure as success would report a failed restore as a successful one.
  //
  // So the proxy, which CAN see the socket error, reports the code in a header
  // and the client keys off that. This is the browser's replacement for the
  // cause.code check the Node and TypeScript versions use.
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "POST", {
      status: 502,
      headers: { "x-nx-upstream-error": "ECONNRESET" },
    }],
  ]);
  await client.login("admin", "secret");

  await client.restoreDatabase(fakeFile(new Uint8Array([1])), { confirmed: true });
});

test("restore does NOT treat an ordinary proxy failure as success", async () => {
  // A 502 with no marker means the proxy could not reach the server at all.
  // The dump never landed, and saying "Accepted" would be a lie.
  const { client } = makeClient([
    LOGIN_OK,
    ["/site/database", "POST", { status: 502, text: "Proxy could not reach ..." }],
  ]);
  await client.login("admin", "secret");

  await assert.rejects(
    () => client.restoreDatabase(fakeFile(new Uint8Array([1])), { confirmed: true }),
    ApiError,
  );
});

// ---------------------------------------------------------------------------
// Session handling
// ---------------------------------------------------------------------------

test("every call logs in immediately before it, and no token can be injected", async () => {
  // "Administrator with a fresh session" is the spec's own permission line, so
  // the login must be the call right before the database call.
  const backup = makeClient([
    LOGIN_OK,
    ["/site/database", "GET", { status: 200, bytes: new Uint8Array([1]) }],
  ]);
  await backup.client.login("admin", "secret");
  await backup.client.backupDatabase();
  assert.deepEqual(
    backup.calls.map((c) => [c.method, c.url]),
    [
      ["POST", "/server/rest/v4/login/sessions"],
      ["GET", "/server/rest/v4/site/database"],
    ],
  );

  const restore = makeClient([LOGIN_OK, ["/site/database", "POST", { status: 200 }]]);
  await restore.client.login("admin", "secret");
  await restore.client.restoreDatabase(fakeFile(new Uint8Array([1])), { confirmed: true });
  assert.deepEqual(
    restore.calls.map((c) => [c.method, c.url]),
    [
      ["POST", "/server/rest/v4/login/sessions"],
      ["POST", "/server/rest/v4/site/database"],
    ],
  );

  // The constructor takes a baseUrl and a fetch, and nothing else. There is no
  // seam for a token minted earlier.
  const fresh = new NxBackupClient({ token: "stale-token", fetchImpl: async () => {} });
  assert.equal(fresh.token, null);
});

// ---------------------------------------------------------------------------
// Which server this page talks to
// ---------------------------------------------------------------------------

test("loadServerHost reads the dev server's --server-host from /config.json", async () => {
  const { fetchImpl, calls } = fakeFetch([
    ["/config.json", "GET", { json: { serverHost: "https://192.168.1.10:7001/" } }],
  ]);
  assert.equal(await loadServerHost({ fetchImpl }), "https://192.168.1.10:7001");
  assert.equal(calls[0].url, "/config.json");
});

test("loadServerHost answers empty when no server is configured or it cannot ask", async () => {
  const none = fakeFetch([["/config.json", "GET", { json: { serverHost: "" } }]]);
  assert.equal(await loadServerHost({ fetchImpl: none.fetchImpl }), "");
  const missing = fakeFetch([["/config.json", "GET", { status: 404 }]]);
  assert.equal(await loadServerHost({ fetchImpl: missing.fetchImpl }), "");
  const down = fakeFetch([["/config.json", "GET", { throws: new TypeError("Failed to fetch") }]]);
  assert.equal(await loadServerHost({ fetchImpl: down.fetchImpl }), "");
});

test("the restore confirmation accepts the configured address, and only that", () => {
  const host = "https://192.168.1.10:7001";
  assert.equal(confirmsHost(host, host), true);
  assert.equal(confirmsHost(`  ${host}/ `, host), true);
  assert.equal(confirmsHost("https://192.168.1.11:7001", host), false);
  assert.equal(confirmsHost("", host), false);
  // The page used to compare against its own placeholder text, so typing that
  // phrase was the only way through. Nothing confirms without a real address.
  assert.equal(confirmsHost("the configured server", ""), false);
  assert.equal(confirmsHost("", ""), false);
});

test("a dump is named after the configured server", () => {
  const name = defaultOutName("https://192.168.1.10:7001", new Date("2026-10-01T08:09:10Z"));
  assert.equal(name, "nx-site-database-192-168-1-10-7001-20261001T080910Z.db");
});

test("the default fetch is called unbound, as a browser requires", async () => {
  // A browser throws "Illegal invocation" when window.fetch runs with any
  // other `this`. Node does not, so stand in a fetch that checks.
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (input) {
    if (this !== undefined && this !== globalThis) {
      throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
    }
    return Promise.resolve({
      status: 200,
      ok: true,
      json: async () => ({ token: "tok-1" }),
      url: String(input),
    });
  };
  try {
    const client = new NxBackupClient();
    assert.equal(await client.login("admin", "secret"), "tok-1");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the default output name drops IPv6 brackets", () => {
  assert.equal(
    defaultOutName("https://[fe80::1]:7001", new Date("2026-10-01T08:09:10Z")),
    "nx-site-database-fe80--1-7001-20261001T080910Z.db",
  );
});

test("a proxy timeout after the upload is an unknown outcome, not a failure", async () => {
  // The server may be loading the dump; telling the operator it was not
  // applied invites a second load into a server that is restarting.
  const { fetchImpl } = fakeFetch([
    LOGIN_OK,
    ["/site/database", "POST", { status: 502, headers: { "x-nx-upstream-error": "UPSTREAM_TIMEOUT" } }],
  ]);
  const client = new NxBackupClient({ fetchImpl });
  await client.login("admin", "secret");

  await assert.rejects(
    () => client.restoreDatabase(new Blob(["a dump"]), { confirmed: true }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /may have loaded it/);
      return true;
    },
  );
});
