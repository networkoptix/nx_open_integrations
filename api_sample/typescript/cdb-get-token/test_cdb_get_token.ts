// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for cdb_get_token.ts. No network, no account needed.
 *
 * Run from this folder:  node --test test_cdb_get_token.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { FetchImpl } from "../nx-types.ts";

import {
  buildTokenRequest,
  getToken,
  resolveConfig,
  loadEnvFile,
  parseArgs,
  AuthError,
  ApiError,
  type CliArgs,
} from "./cdb_get_token.ts";

/** A fetch double that also records the calls it received. */
interface RecordingFetch extends FetchImpl {
  calls: Array<{ url: string; body: Record<string, unknown> | null }>;
}

interface FakeFetchOptions {
  status?: number;
  json?: Record<string, unknown> | null;
  text?: string;
}

/**
 * A fake fetch. Records the URL + parsed JSON body it was called with, and
 * returns a canned Response-like object.
 */
function fakeFetch(
  { status = 200, json = null, text = "" }: FakeFetchOptions = {},
): RecordingFetch {
  const calls: Array<{ url: string; body: Record<string, unknown> | null }> =
    [];
  const impl = (async (url, options) => {
    const bodyStr =
      options && typeof options.body === "string" ? options.body : null;
    calls.push({
      url: String(url),
      body: bodyStr ? (JSON.parse(bodyStr) as Record<string, unknown>) : null,
    });
    return {
      status,
      ok: status < 400,
      async json() {
        if (json === null) {
          throw new Error("no json");
        }
        return json;
      },
      async text() {
        return text;
      },
    } as Response;
  }) as RecordingFetch;
  impl.calls = calls;
  return impl;
}

/** Build a CliArgs object with sensible defaults for resolveConfig tests. */
function cliArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    host: null,
    user: null,
    password: null,
    mfaCode: null,
    cloudSystemId: null,
    envFile: ".env",
    insecure: false,
    tokenOnly: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildTokenRequest(): the request body
// ---------------------------------------------------------------------------

test("body has the minimal fields", () => {
  const body = buildTokenRequest("me@x.com", "pw");
  assert.deepEqual(body, {
    grant_type: "password",
    response_type: "token",
    client_id: "3rdParty",
    username: "me@x.com",
    password: "pw",
  });
});

test("body adds mfaCode only when given", () => {
  assert.ok(!("mfaCode" in buildTokenRequest("u", "p")));
  assert.equal(buildTokenRequest("u", "p", "123456").mfaCode, "123456");
});

test("body adds scope only when site id given", () => {
  assert.ok(!("scope" in buildTokenRequest("u", "p")));
  const body = buildTokenRequest("u", "p", null, "sys-1");
  assert.equal(body.scope, "cloudSystemId=sys-1");
});

// ---------------------------------------------------------------------------
// getToken(): the call + response handling
// ---------------------------------------------------------------------------

test("getToken success returns the token and calls the right URL", async () => {
  const f = fakeFetch({ json: { access_token: "nxcdb-xyz", expires_in: 3600 } });
  const data = await getToken("https://nxvms.com", "me@x.com", "pw", {
    fetchImpl: f,
  });

  assert.equal(data.access_token, "nxcdb-xyz");
  assert.equal(f.calls[0]?.url, "https://nxvms.com/cdb/oauth2/token");
  assert.equal(f.calls[0]?.body?.username, "me@x.com");
});

test("getToken trims a trailing slash in the host", async () => {
  const f = fakeFetch({ json: { access_token: "t" } });
  await getToken("https://nxvms.com/", "u", "p", { fetchImpl: f });
  assert.equal(f.calls[0]?.url, "https://nxvms.com/cdb/oauth2/token");
});

test("getToken raises AuthError on bad credentials", async () => {
  const f = fakeFetch({ status: 401, text: "no" });
  await assert.rejects(
    () => getToken("https://nxvms.com", "u", "p", { fetchImpl: f }),
    AuthError,
  );
});

test("getToken raises ApiError when token missing", async () => {
  const f = fakeFetch({ json: { something: 1 } });
  await assert.rejects(
    () => getToken("https://nxvms.com", "u", "p", { fetchImpl: f }),
    ApiError,
  );
});

test("getToken raises ApiError on a non-auth HTTP error", async () => {
  const f = fakeFetch({ status: 500, text: "boom" });
  await assert.rejects(
    () => getToken("https://nxvms.com", "u", "p", { fetchImpl: f }),
    ApiError,
  );
});

// ---------------------------------------------------------------------------
// config + CLI parsing
// ---------------------------------------------------------------------------

test("CLI flag overrides env var and .env file", () => {
  const config = resolveConfig(
    cliArgs({ user: "cli-user" }),
    { NX_CLOUD_USER: "file-user" },
    { NX_CLOUD_USER: "env-user" },
  );
  assert.equal(config.user, "cli-user");
});

test("env var overrides .env file when no CLI flag", () => {
  const config = resolveConfig(
    cliArgs(),
    { NX_CLOUD_USER: "file-user" },
    { NX_CLOUD_USER: "env-user" },
  );
  assert.equal(config.user, "env-user");
});

test(".env file is used when nothing else is set", () => {
  const config = resolveConfig(cliArgs(), { NX_CLOUD_USER: "file-user" }, {});
  assert.equal(config.user, "file-user");
});

test("loadEnvFile returns {} for a missing file", () => {
  assert.deepEqual(loadEnvFile("/no/such/.env"), {});
});

test("parseArgs handles --flag value, --flag=value, and booleans", () => {
  const flags = parseArgs([
    "--host",
    "https://nxvms.com",
    "--user=me@x.com",
    "--insecure",
    "--token-only",
  ]);
  assert.equal(flags.host, "https://nxvms.com");
  assert.equal(flags.user, "me@x.com");
  assert.equal(flags.insecure, true);
  assert.equal(flags.tokenOnly, true);
});

test("parseArgs throws on an unknown argument", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown argument/);
});
