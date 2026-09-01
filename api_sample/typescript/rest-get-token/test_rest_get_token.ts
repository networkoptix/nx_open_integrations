// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for rest_get_token.ts. No network, no server needed.
 *
 * Run from this folder:  node --test test_rest_get_token.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { FetchImpl, LoginResponse } from "../nx-types.ts";

import {
  NxLoginClient,
  formatSession,
  resolveConfig,
  parseArgs,
  main,
  suppressTlsWarning,
  AuthError,
  ApiError,
} from "./rest_get_token.ts";

const SESSION: LoginResponse = {
  id: "{aaaa-bbbb}",
  username: "admin",
  token: "abc123",
  ageS: 0,
  expiresInS: 600,
};

interface FakeResponseInit {
  status?: number;
  json?: unknown;
  text?: string;
}

function makeResponse({ status = 200, json = null, text = "" }: FakeResponseInit = {}): Response {
  return {
    status,
    ok: status < 400,
    async json() {
      if (json === null) throw new Error("no json");
      return json;
    },
    async text() {
      return text;
    },
  } as unknown as Response;
}

interface RecordedCalls {
  post: { url: string; body: unknown } | null;
  gets: Array<{ url: string; headers: unknown }>;
  deleteUrl: string | null;
  deleteHeaders: unknown;
  deleteCalls: number;
}

interface FakeFetch {
  impl: FetchImpl;
  calls: RecordedCalls;
}

/**
 * Serves queued responses per verb and records every call.
 *
 * `get` accepts an array because this sample calls GET twice: once to use the
 * token, once after logout to prove it is dead. An Error simulates an
 * unreachable server.
 */
function fakeFetch(
  {
    post = null,
    get = null,
    del = null,
  }: {
    post?: Response | Error | null;
    get?: Response | Error | Array<Response | Error> | null;
    del?: Response | Error | null;
  } = {},
): FakeFetch {
  const queue: Array<Response | Error> = Array.isArray(get) ? [...get] : get ? [get] : [];
  const calls: RecordedCalls = {
    post: null,
    gets: [],
    deleteUrl: null,
    deleteHeaders: null,
    deleteCalls: 0,
  };
  const impl = (async (url: string, options: RequestInit = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST") {
      calls.post = {
        url: String(url),
        body: options.body ? JSON.parse(String(options.body)) : null,
      };
      if (post instanceof Error) throw post;
      return post as Response;
    }
    if (method === "DELETE") {
      calls.deleteUrl = String(url);
      calls.deleteHeaders = options.headers;
      calls.deleteCalls += 1;
      if (del instanceof Error) throw del;
      return del as Response;
    }
    calls.gets.push({ url: String(url), headers: options.headers });
    const next = queue.length ? queue.shift() : makeResponse({ json: {} });
    if (next instanceof Error) throw next;
    return next as Response;
  }) as unknown as FetchImpl;
  return { impl, calls };
}

function makeClient(fetchOpts: Parameters<typeof fakeFetch>[0] = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxLoginClient("https://srv:7001", "admin", "pw", { fetchImpl: f.impl });
  return { client, f };
}

// ---------------------------------------------------------------------------
// Step 1 — login()
// ---------------------------------------------------------------------------

test("login posts credentials to v4 and stores the token", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: SESSION }) });

  const result = await client.login();

  assert.equal(client.token, "abc123");
  assert.equal(f.calls.post?.url, "https://srv:7001/rest/v4/login/sessions");
  assert.deepEqual(f.calls.post?.body, {
    username: "admin",
    password: "pw",
    setCookie: false,
  });
  // The whole session object comes back, not just the token string.
  assert.equal(result.expiresInS, 600);
  assert.equal(result.id, "{aaaa-bbbb}");
});

test("login unauthorized raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 401, text: "bad creds" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("login forbidden raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 403, text: "nope" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("login without a token raises ApiError", async () => {
  const { client } = makeClient({
    post: makeResponse({ json: { id: "x", username: "admin" } }),
  });
  await assert.rejects(() => client.login(), ApiError);
});

test("login on an unreachable server raises ApiError", async () => {
  const { client } = makeClient({ post: new Error("boom") });
  await assert.rejects(() => client.login(), ApiError);
});

// ---------------------------------------------------------------------------
// Step 2 — getCurrentSession()
// ---------------------------------------------------------------------------

test("getCurrentSession uses the bearer header on the current path", async () => {
  const { client, f } = makeClient({ get: makeResponse({ json: SESSION }) });
  client.token = "abc123";

  const data = await client.getCurrentSession();

  const call = f.calls.gets[0];
  assert.equal(call?.url, "https://srv:7001/rest/v4/login/sessions/current");
  // The path uses the sentinel; the header carries the token.
  assert.equal((call?.headers as Record<string, string>).Authorization, "Bearer abc123");
  assert.ok(!call?.url.includes("abc123"));
  assert.equal(data.username, "admin");
});

test("getCurrentSession without login raises", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.getCurrentSession(), ApiError);
});

test("getCurrentSession rejected raises AuthError", async () => {
  const { client } = makeClient({ get: makeResponse({ status: 401, text: "expired" }) });
  client.token = "abc123";
  await assert.rejects(() => client.getCurrentSession(), AuthError);
});

// ---------------------------------------------------------------------------
// Step 4 — tokenStillWorks() must NOT throw: a 401 here is the good outcome
// ---------------------------------------------------------------------------

test("tokenStillWorks reports live while the session is live", async () => {
  const { client } = makeClient({ get: makeResponse({ json: SESSION }) });
  assert.deepEqual(await client.tokenStillWorks("abc123"), { isLive: true, status: 200 });
});

test("tokenStillWorks reports dead after logout without throwing", async () => {
  const { client } = makeClient({ get: makeResponse({ status: 401, text: "unauthorized" }) });
  assert.deepEqual(await client.tokenStillWorks("abc123"), { isLive: false, status: 401 });
});

test("tokenStillWorks reports unknown when the server is unreachable", async () => {
  const { client } = makeClient({ get: new Error("boom") });
  assert.deepEqual(await client.tokenStillWorks("abc123"), { isLive: false, status: null });
});

// ---------------------------------------------------------------------------
// Step 3 — logout()
// ---------------------------------------------------------------------------

test("logout deletes the v4 session and clears the token", async () => {
  const { client, f } = makeClient({ del: makeResponse({ json: {} }) });
  client.token = "abc123";

  assert.equal(await client.logout(), true);
  assert.equal(f.calls.deleteCalls, 1);
  assert.equal(f.calls.deleteUrl, "https://srv:7001/rest/v4/login/sessions/current");
  // The path uses the sentinel; the header carries the token.
  assert.ok(!f.calls.deleteUrl?.includes("abc123"));
  assert.equal(
    (f.calls.deleteHeaders as Record<string, string>).Authorization,
    "Bearer abc123",
  );
  assert.equal(client.token, null);
});

test("logout without a token is a no-op", async () => {
  const { client, f } = makeClient();
  assert.equal(await client.logout(), false);
  assert.equal(f.calls.deleteCalls, 0);
});

test("logout swallows a network error", async () => {
  const { client } = makeClient({ del: new Error("boom") });
  client.token = "abc123";

  assert.equal(await client.logout(), false); // reported, not thrown
  assert.equal(client.token, null); // still forgotten locally
});

// ---------------------------------------------------------------------------
// Config precedence + flags
// ---------------------------------------------------------------------------

test("config uses the NX_SERVER_* vars (env beats file)", () => {
  const config = resolveConfig(
    { host: null, user: null, password: null },
    { NX_SERVER_HOST: "https://file:7001" },
    { NX_SERVER_HOST: "https://env:7001" },
  );
  assert.equal(config.host, "https://env:7001");
});

test("config lets a CLI flag beat the environment", () => {
  const config = resolveConfig({ host: "https://cli:7001" }, {}, {
    NX_SERVER_HOST: "https://env:7001",
  });
  assert.equal(config.host, "https://cli:7001");
});

test("parseArgs reads --dotenv, not --env-file", () => {
  const flags = parseArgs(["--host", "https://h:7001", "--dotenv", "../../.env", "--insecure"]);
  assert.equal(flags.host, "https://h:7001");
  assert.equal(flags.envFile, "../../.env");
  assert.equal(flags.insecure, true);
  // --env-file is a Node built-in, so the sample must not accept it.
  assert.throws(() => parseArgs(["--env-file", "x"]), /Unknown argument/);
});

// ---------------------------------------------------------------------------
// TLS warning suppression (the --insecure counterpart of Python's urllib3 call)
// ---------------------------------------------------------------------------

test("suppressTlsWarning hides only the NODE_TLS_REJECT_UNAUTHORIZED warning", () => {
  const original = process.emitWarning;
  try {
    const seen: string[] = [];
    process.emitWarning = ((warning: string | Error) => {
      seen.push(String(warning));
    }) as typeof process.emitWarning;

    suppressTlsWarning();

    process.emitWarning(
      "Setting the NODE_TLS_REJECT_UNAUTHORIZED environment variable to '0' ...",
    );
    process.emitWarning("something else entirely");

    // The TLS one is swallowed; anything else still gets through.
    assert.deepEqual(seen, ["something else entirely"]);

    // Calling it again must not stack another wrapper.
    const afterFirst = process.emitWarning;
    suppressTlsWarning();
    assert.equal(process.emitWarning, afterFirst);
  } finally {
    process.emitWarning = original;
  }
});

// ---------------------------------------------------------------------------
// Pretty printing
// ---------------------------------------------------------------------------

test("formatSession shows the lifetime fields", () => {
  const out = formatSession(SESSION);
  assert.ok(out.includes("abc123"));
  assert.ok(out.includes("{aaaa-bbbb}"));
  assert.ok(out.includes("600 seconds"));
});

test("formatSession omits absent lifetime fields", () => {
  const out = formatSession({ token: "t", id: "i", username: "u" });
  assert.ok(!out.includes("expires in"));
  assert.ok(!out.includes("age"));
});

// ---------------------------------------------------------------------------
// main() end to end (all HTTP mocked)
// ---------------------------------------------------------------------------

test("main returns 2 when config is missing", async () => {
  const code = await main(["--dotenv", "/nonexistent/.env", "--host", "https://h:7001"]);
  assert.equal(code, 2);
});

test("main rejects an unknown flag with exit code 2", async () => {
  assert.equal(await main(["--bogus"]), 2);
});

test("main walks the whole session lifecycle", async () => {
  // main() builds its own client, so stub the global fetch for this test.
  const f = fakeFetch({
    post: makeResponse({ json: SESSION }),
    get: [makeResponse({ json: SESSION }), makeResponse({ status: 401, text: "gone" })],
    del: makeResponse({ json: {} }),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.impl;
  try {
    const code = await main([
      "--host",
      "https://srv:7001",
      "--user",
      "admin",
      "--password",
      "pw",
      "--dotenv",
      "/nonexistent/.env",
    ]);
    assert.equal(code, 0);
    // All four steps happened, in order, exactly once each.
    assert.ok(f.calls.post?.url.endsWith("/rest/v4/login/sessions"));
    assert.equal(f.calls.gets.length, 2);
    assert.equal(f.calls.deleteCalls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("main returns 1 on bad credentials and leaves nothing to release", async () => {
  const f = fakeFetch({ post: makeResponse({ status: 401, text: "bad creds" }) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = f.impl;
  try {
    const code = await main([
      "--host",
      "https://srv:7001",
      "--user",
      "admin",
      "--password",
      "wrong",
      "--dotenv",
      "/nonexistent/.env",
    ]);
    assert.equal(code, 1);
    assert.equal(f.calls.deleteCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
