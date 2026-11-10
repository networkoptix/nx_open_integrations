// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-device-agent-settings-client.mjs. No browser, no
 * server, no network: every HTTP call goes through an injected fake fetch.
 *
 * What is worth testing in a sample:
 *   - the auth flow sends what the API expects, and stores the token
 *   - each documented failure mode raises the right error
 *   - response shapes the server really returns are all handled (v4 envelopes!)
 *   - the PUT body keeps only the fields that are really configuration
 *   - apply refuses without explicit confirmation, and sends no request
 *
 * Run from this folder:  node --test test_nx_device_agent_settings_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxDeviceAgentSettingsClient,
  buildApplyBody,
  defaultOutputName,
  formatSettingsFile,
  parseSettingsFile,
  runSession,
  AuthError,
  ApiError,
  EngineReportedError,
  UnknownOutcomeError,
} from "./nx-device-agent-settings-client.mjs";

// ---------------------------------------------------------------------------
// Fake HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Build a fake fetch plus the list it records into. Replies are matched by a
 * substring of the URL and the method, so a test says what it means rather
 * than counting calls.
 */
function fakeFetch(replies) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: { ...(init.headers ?? {}) }, body: init.body, redirect: init.redirect });

    const match = replies.find(([suffix, m]) => url.includes(suffix) && m === method);
    const reply = match ? match[2] : { status: 200, json: {} };
    if (reply.throws) throw reply.throws;

    const status = reply.status ?? 200;
    // `text` wins over `json`; neither means an empty body.
    const text = reply.text ?? (reply.json === undefined ? "" : JSON.stringify(reply.json));
    const headers = Object.fromEntries(
      Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      status,
      type: reply.type ?? "basic",
      ok: status >= 200 && status < 300,
      headers: { get: (n) => headers[String(n).toLowerCase()] ?? null },
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };
  return { fetchImpl, calls };
}

const LOGIN_OK = ["/login/sessions", "POST", { status: 200, json: { token: "tok-1" } }];

function makeClient(replies) {
  const { fetchImpl, calls } = fakeFetch(replies);
  return { client: new NxDeviceAgentSettingsClient({ fetchImpl }), calls };
}

const SETTINGS_URL = "/analytics/engines/engine-1/deviceAgents/device-1/settings";

const BARE_SETTINGS = {
  deviceId: "device-1",
  engineId: "engine-1",
  values: { sensitivity: 50 },
  model: { sensitivity: { type: "SpinBox" } },
  _error: {},
  analyzedStream: "primary",
  disableStreamSelection: false,
};

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

for (const [what, reply, message] of [
  ["a server error", { status: 500 }, "Login failed: HTTP 500."],
  ["a redirect", { status: 302 }, "Login failed: HTTP 302 (redirect not followed)."],
  ["a non-JSON body", { status: 200, text: "<html>" }, "Login failed: the response was not valid JSON."],
  ["no token", { status: 200, json: {} }, "Login failed: the response did not contain a token."],
  ["a JSON list", { status: 200, json: [{ token: "t" }] }, "Login failed: the response did not contain a token."],
  ["a non-string token", { status: 200, json: { token: 7 } }, "Login failed: the response did not contain a token."],
]) {
  test(`login reports ${what} as a login failure, not as unreachable`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", reply]]);
    await assert.rejects(() => client.login("admin", "secret"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.message, message);
      return true;
    });
    assert.equal(client.token, null);
  });
}

test("no request follows a redirect", async () => {
  const { client, calls } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "GET", { status: 200, json: BARE_SETTINGS }],
    [SETTINGS_URL, "PUT", { status: 200, text: "" }],
  ]);
  await client.login("admin", "secret");
  await client.downloadSettings("engine-1", "device-1");
  await client.applySettings("engine-1", "device-1", {}, { confirmed: true });
  await client.logout();

  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(call.redirect, "manual", `${call.method} ${call.url}`);
});

// ---------------------------------------------------------------------------
// downloadSettings(): GET .../settings
// ---------------------------------------------------------------------------

test("download sends GET to the engine and device path", async () => {
  const { client, calls } = makeClient([LOGIN_OK, [SETTINGS_URL, "GET", { status: 200, json: BARE_SETTINGS }]]);
  await client.login("admin", "secret");

  const result = await client.downloadSettings("engine-1", "device-1");

  assert.deepEqual(result, BARE_SETTINGS);
  const last = calls[calls.length - 1];
  assert.equal(last.method, "GET");
  assert.equal(last.url, `/server/rest/v4${SETTINGS_URL}`);
  assert.equal(last.headers.Authorization, "Bearer tok-1");
});

test("download unwraps the v4 reply envelope", async () => {
  // v4 can wrap a single object in {"reply": {...}} as it does for arrays.
  const { client } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "GET", { status: 200, json: { reply: BARE_SETTINGS } }],
  ]);
  await client.login("admin", "secret");

  assert.deepEqual(await client.downloadSettings("engine-1", "device-1"), BARE_SETTINGS);
});

test("download without login throws ApiError", async () => {
  const { client } = makeClient([]);
  await assert.rejects(() => client.downloadSettings("engine-1", "device-1"), ApiError);
});

test("download throws AuthError on 401/403, naming Power User", async () => {
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "GET", { status: 403 }]]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.downloadSettings("engine-1", "device-1"), (err) => {
    assert.ok(err instanceof AuthError);
    assert.match(err.message, /Power User/);
    return true;
  });
});

test("download throws ApiError on a server error", async () => {
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "GET", { status: 500 }]]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.downloadSettings("engine-1", "device-1"), ApiError);
});

test("download treats a redirect as a failure", async () => {
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "GET", { status: 302, json: BARE_SETTINGS }]]);
  await client.login("admin", "secret");

  await assert.rejects(
    () => client.downloadSettings("engine-1", "device-1"),
    /HTTP 302 \(redirect not followed\)/,
  );
});

// What the proxy's x-nx-upstream-error header means on login and download.
const CERT_MESSAGE =
  "Certificate verification failed. Local servers use a self-signed certificate, restart server.mjs with --insecure.";
for (const [code, status, message] of [
  ["ECONNREFUSED", 502, "Could not reach the server (ECONNREFUSED)."],
  ["EADDRNOTAVAIL", 502, "Could not reach the server (EADDRNOTAVAIL)."],
  ["UND_ERR_CONNECT_TIMEOUT", 502, "Could not reach the server (UND_ERR_CONNECT_TIMEOUT)."],
  ["DEPTH_ZERO_SELF_SIGNED_CERT", 502, CERT_MESSAGE],
  ["ERR_SSL_WRONG_VERSION_NUMBER", 502, CERT_MESSAGE],
  ["SOME_NEW_CERT_CODE", 502, CERT_MESSAGE],
  ["UPSTREAM_TIMEOUT", 504, "Could not reach the server: no answer in time."],
  // A bare "SSL" code is not a handshake failure: it can happen mid-stream.
  ["ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC", 502, "The connection to the server was lost (ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC)."],
  // The proxy's own answers: their status is the proxy's, not the VMS server's.
  ["NO_SERVER_HOST", 502, "No VMS server configured. Restart server.mjs with --server-host https://<ip>:7001."],
  ["BAD_REQUEST", 400, "The dev server could not read the request from the page."],
  ["PROXY_ERROR", 500, "The dev server failed while handling the request."],
]) {
  const reply = { status, text: "Proxy says no", headers: { "x-nx-upstream-error": code } };

  test(`login: a proxy ${code} is reported as such, not as "Login failed: HTTP ${status}"`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", reply]]);
    await assert.rejects(() => client.login("admin", "secret"), (err) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.message, message);
      return true;
    });
  });

  test(`download: a proxy ${code} is reported as such`, async () => {
    const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "GET", reply]]);
    await client.login("admin", "secret");
    await assert.rejects(() => client.downloadSettings("engine-1", "device-1"), (err) => {
      assert.equal(err.message, message);
      return true;
    });
  });
}

test("logout: a proxy TLS failure gives a short certificate reason", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    ["/login/sessions/tok-1", "DELETE", { status: 502, headers: { "x-nx-upstream-error": "CERT_HAS_EXPIRED" } }],
  ]);
  await client.login("admin", "secret");
  await assert.rejects(() => client.logout(), {
    message: "Could not log out: certificate verification failed (CERT_HAS_EXPIRED).",
    reason: "certificate verification failed (CERT_HAS_EXPIRED)",
  });
});

test("download treats a redirect the browser held back as a failure", async () => {
  // fetch(..., {redirect: "manual"}) in a browser: status 0, type opaqueredirect.
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "GET", { status: 0, type: "opaqueredirect" }]]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.downloadSettings("engine-1", "device-1"), {
    message: "Reading settings failed: HTTP 3xx (redirect not followed).",
  });
});

for (const [what, reply] of [
  ["a JSON list", { status: 200, json: [BARE_SETTINGS] }],
  ["a non-JSON body", { status: 200, text: "<html>" }],
  ["an empty body", { status: 200, text: "" }],
]) {
  test(`download refuses ${what}`, async () => {
    const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "GET", reply]]);
    await client.login("admin", "secret");

    await assert.rejects(
      () => client.downloadSettings("engine-1", "device-1"),
      /the server did not return a JSON object/,
    );
  });
}

// ---------------------------------------------------------------------------
// buildApplyBody(): the PUT request body the spec defines
// ---------------------------------------------------------------------------

test("buildApplyBody drops deviceId, engineId and _error, and nothing else", () => {
  // deviceId/engineId are not even in the spec's PUT request body: the URL
  // already identifies the device and engine. _error is the source device's
  // error report and must not be echoed back. Everything else is forwarded
  // unchanged.
  const body = buildApplyBody({ ...BARE_SETTINGS, _error: { sensitivity: "out of range" } });

  assert.deepEqual(body, {
    values: { sensitivity: 50 },
    model: { sensitivity: { type: "SpinBox" } },
    analyzedStream: "primary",
    disableStreamSelection: false,
  });
  assert.ok(!("deviceId" in body));
  assert.ok(!("engineId" in body));
  assert.ok(!("_error" in body));
});

test("buildApplyBody refuses a list", () => {
  assert.throws(() => buildApplyBody([{ values: {} }]), /does not hold a JSON object/);
});

// ---------------------------------------------------------------------------
// parseSettingsFile(): checked before logging in
// ---------------------------------------------------------------------------

test("parseSettingsFile returns the object of a settings file", () => {
  assert.deepEqual(parseSettingsFile(JSON.stringify(BARE_SETTINGS), "a.json"), BARE_SETTINGS);
});

test("parseSettingsFile names a file that is not JSON", () => {
  assert.throws(() => parseSettingsFile("{not json", "a.json"), (err) => {
    assert.ok(err instanceof ApiError);
    assert.match(err.message, /^a\.json is not valid JSON: .*[^.]\.$/);
    return true;
  });
});

for (const [what, text] of [["a list", "[1, 2]"], ["a number", "42"], ["null", "null"], ["a string", '"x"']]) {
  test(`parseSettingsFile refuses ${what}`, () => {
    assert.throws(() => parseSettingsFile(text, "a.json"), /^ApiError: a\.json does not hold a JSON object\.$/);
  });
}

test("buildApplyBody omits a field absent from the input", () => {
  // A partial settings file must not send a field back as null.
  const body = buildApplyBody({ values: { sensitivity: 50 } });

  assert.deepEqual(body, { values: { sensitivity: 50 } });
  assert.ok(!("analyzedStream" in body));
  assert.ok(!("disableStreamSelection" in body));
  assert.ok(!("model" in body));
  assert.ok(!("_error" in body));
});

// ---------------------------------------------------------------------------
// applySettings(): PUT .../settings
// ---------------------------------------------------------------------------

test("apply refuses without confirmation, and sends no request", async () => {
  // Applying overwrites the target device's existing Device Agent settings.
  // The guard lives here, not in the page, so it is testable: DOM is out of
  // scope for a browser sample's tests.
  const { client, calls } = makeClient([LOGIN_OK]);
  await client.login("admin", "secret");
  const before = calls.length;

  await assert.rejects(
    () => client.applySettings("engine-1", "device-1", { values: {} }),
    /confirm/i,
  );
  assert.equal(calls.length, before, "no request may be sent without confirmation");
});

test("apply sends PUT with the body to the engine and device path", async () => {
  const { client, calls } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { status: 200, json: BARE_SETTINGS }]]);
  await client.login("admin", "secret");
  const body = { values: { sensitivity: 50 } };

  await client.applySettings("engine-1", "device-1", body, { confirmed: true });

  const last = calls[calls.length - 1];
  assert.equal(last.method, "PUT");
  assert.equal(last.url, `/server/rest/v4${SETTINGS_URL}`);
  assert.equal(last.headers.Authorization, "Bearer tok-1");
  assert.deepEqual(JSON.parse(last.body), body);
});

test("apply without login throws ApiError, even when confirmed", async () => {
  const { client } = makeClient([]);
  await assert.rejects(
    () => client.applySettings("engine-1", "device-1", {}, { confirmed: true }),
    ApiError,
  );
});

test("apply throws AuthError on 401/403, naming Power User", async () => {
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { status: 401 }]]);
  await client.login("admin", "secret");

  await assert.rejects(
    () => client.applySettings("engine-1", "device-1", {}, { confirmed: true }),
    (err) => {
      assert.ok(err instanceof AuthError);
      assert.match(err.message, /Power User/);
      return true;
    },
  );
});

for (const [what, reply, expected] of [
  ["an empty body", { status: 200, text: "" }, null],
  ["a 204", { status: 204 }, null],
  ["a non-JSON body", { status: 200, text: "OK" }, null],
  ["an empty _error map", { status: 200, json: BARE_SETTINGS }, BARE_SETTINGS],
]) {
  test(`apply counts a 2xx with ${what} as applied`, async () => {
    const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", reply]]);
    await client.login("admin", "secret");

    assert.deepEqual(await client.applySettings("engine-1", "device-1", {}, { confirmed: true }), expected);
  });
}

test("apply reports the Engine's _error map from a 2xx as a failure", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 200, json: { ...BARE_SETTINGS, _error: { sensitivity: "out of range", mode: "unknown" } } }],
  ]);
  await client.login("admin", "secret");

  await assert.rejects(
    () => client.applySettings("engine-1", "device-1", {}, { confirmed: true }),
    (err) => {
      assert.ok(err instanceof EngineReportedError);
      assert.equal(
        err.message,
        "The server took the settings but the Engine reported errors:\nsensitivity: out of range\nmode: unknown",
      );
      return true;
    },
  );
});

test("apply shows a non-string Engine error message as JSON", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 200, json: { _error: { a: { x: 1 }, b: 7, c: "plain" } } }],
  ]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.applySettings("engine-1", "device-1", {}, { confirmed: true }), {
    message: 'The server took the settings but the Engine reported errors:\na: {"x":1}\nb: 7\nc: plain',
  });
});

test("apply treats a redirect as a failure", async () => {
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { status: 302 }]]);
  await client.login("admin", "secret");

  await assert.rejects(
    () => client.applySettings("engine-1", "device-1", {}, { confirmed: true }),
    /HTTP 302 \(redirect not followed\)/,
  );
});

test("apply treats a redirect the browser held back as a failure, not applied", async () => {
  // fetch(..., {redirect: "manual"}) in a browser: status 0, type opaqueredirect.
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { status: 0, type: "opaqueredirect" }]]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.applySettings("engine-1", "device-1", {}, { confirmed: true }), {
    message: "Applying settings failed: HTTP 3xx (redirect not followed). The settings were not applied.",
  });
});

for (const [status, message] of [
  [302, "Applying settings failed: HTTP 302 (redirect not followed). The settings were not applied."],
  [
    404,
    "Applying settings failed: HTTP 404. The settings were not applied. " +
      "The target device may not be running this Engine.",
  ],
  [
    500,
    "Applying settings failed: HTTP 500. The server may have applied some of them; " +
      "download the device's settings to check.",
  ],
  // The VMS server's own 504 (no proxy header) is a 5xx, not "not applied".
  [
    504,
    "Applying settings failed: HTTP 504. The server may have applied some of them; " +
      "download the device's settings to check.",
  ],
]) {
  test(`apply words a server's HTTP ${status} exactly`, async () => {
    const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { status }]]);
    await client.login("admin", "secret");

    await assert.rejects(() => client.applySettings("engine-1", "device-1", {}, { confirmed: true }), {
      message,
    });
  });
}

test("apply: a proxy TLS failure prints the certificate message, not applied", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 502, headers: { "x-nx-upstream-error": "SELF_SIGNED_CERT_IN_CHAIN" } }],
  ]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.applySettings("engine-1", "device-1", {}, { confirmed: true }), {
    message: `${CERT_MESSAGE} The settings were not applied.`,
  });
});

for (const code of ["ECONNREFUSED", "ENOTFOUND", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"]) {
  test(`apply: a proxy ${code} means the settings were not applied`, async () => {
    const { client } = makeClient([
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { status: 502, text: "Proxy could not reach", headers: { "x-nx-upstream-error": code } }],
    ]);
    await client.login("admin", "secret");

    await assert.rejects(
      () => client.applySettings("engine-1", "device-1", {}, { confirmed: true }),
      (err) => {
        assert.ok(!(err instanceof UnknownOutcomeError));
        assert.match(err.message, /^Could not reach the server \(\w+\)\. The settings were not applied\.$/);
        return true;
      },
    );
  });
}

test("login: a proxy UPSTREAM_TIMEOUT names the seconds the proxy waited", async () => {
  const { client } = makeClient([
    [
      "/login/sessions",
      "POST",
      {
        status: 504,
        text: "x",
        headers: { "x-nx-upstream-error": "UPSTREAM_TIMEOUT", "x-nx-upstream-timeout-seconds": "60" },
      },
    ],
  ]);
  await assert.rejects(() => client.login("admin", "secret"), {
    message: "Could not reach the server: no answer within 60 s.",
  });
});

for (const [thrown, message] of [
  ["Failed to fetch", "Could not reach the server: Failed to fetch."],
  ["socket hang up.", "Could not reach the server: socket hang up."],
  ["went away..", "Could not reach the server: went away."],
  ["", "Could not reach the server."],
]) {
  test(`a fetch that throws ${JSON.stringify(thrown)} gives a reason with exactly one final period`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", { throws: new TypeError(thrown) }]]);
    await assert.rejects(() => client.login("admin", "secret"), { message });
  });
}

for (const [code, status] of [
  ["ECONNRESET", 502],
  ["UND_ERR_SOCKET", 502],
  ["UPSTREAM_TIMEOUT", 504],
  // Mid-stream TLS trouble, after the PUT may have gone out.
  ["ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC", 502],
  ["PROXY_ERROR", 500],
]) {
  test(`apply: a proxy ${code} after sending is an unknown outcome, not "not applied"`, async () => {
    const { client } = makeClient([
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { status, text: "x", headers: { "x-nx-upstream-error": code } }],
    ]);
    await client.login("admin", "secret");

    await assert.rejects(
      () => client.applySettings("engine-1", "device-1", {}, { confirmed: true }),
      (err) => {
        assert.ok(err instanceof UnknownOutcomeError);
        assert.match(
          err.message,
          /^Outcome unknown: the connection was lost after the settings were sent\. Download the device's settings to check\.$/,
        );
        assert.doesNotMatch(err.message, /not applied|may not be running/);
        // The cause is kept for debugging, not appended to the message.
        assert.equal(err.detail, code);
        return true;
      },
    );
  });
}

for (const [code, status, message] of [
  ["NO_SERVER_HOST", 502, "No VMS server configured. Restart server.mjs with --server-host https://<ip>:7001. The settings were not applied."],
  ["BAD_REQUEST", 400, "The dev server could not read the request from the page. The settings were not applied."],
]) {
  test(`apply: a proxy ${code} (${status}) means not applied, not the VMS ${status} wording`, async () => {
    const { client } = makeClient([
      LOGIN_OK,
      [SETTINGS_URL, "PUT", { status, text: "x", headers: { "x-nx-upstream-error": code } }],
    ]);
    await client.login("admin", "secret");

    await assert.rejects(() => client.applySettings("engine-1", "device-1", {}, { confirmed: true }), {
      message,
    });
  });
}

test("apply: the dev server going away mid-request is an unknown outcome", async () => {
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { throws: new TypeError("Failed to fetch") }]]);
  await client.login("admin", "secret");

  await assert.rejects(
    () => client.applySettings("engine-1", "device-1", {}, { confirmed: true }),
    (err) => {
      assert.ok(err instanceof UnknownOutcomeError);
      assert.equal(
        err.message,
        "Outcome unknown: the connection was lost after the settings were sent. Download the device's settings to check.",
      );
      return true;
    },
  );
});

test("apply's failure names that the target device may not run the Engine", async () => {
  const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { status: 400 }]]);
  await client.login("admin", "secret");

  await assert.rejects(
    () => client.applySettings("engine-1", "device-1", {}, { confirmed: true }),
    (err) => {
      assert.ok(err instanceof ApiError);
      assert.match(err.message, /may not be running this Engine/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// defaultOutputName(): the download's suggested filename
// ---------------------------------------------------------------------------

test("the default output name names the device and the UTC time", () => {
  const moment = new Date(Date.UTC(2026, 8, 16, 3, 12, 0));

  assert.equal(
    defaultOutputName("device-1", moment),
    "nx-device-agent-settings-device-1-20260916T031200Z.json",
  );
});

// ---------------------------------------------------------------------------
// formatSettingsFile(): what the download saves
// ---------------------------------------------------------------------------

test("formatSettingsFile sorts keys and pretty-prints with a trailing newline", () => {
  const text = formatSettingsFile({ b: 1, a: { d: 2, c: 3 } });

  assert.equal(text, '{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
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

test("logout reports a refused DELETE, and forgets the token anyway", async () => {
  const { client } = makeClient([LOGIN_OK, ["/login/sessions/tok-1", "DELETE", { status: 500 }]]);
  await client.login("admin", "secret");

  await assert.rejects(() => client.logout(), { message: "Could not log out: HTTP 500.", reason: "HTTP 500" });
  assert.equal(client.token, null);
});

// ---------------------------------------------------------------------------
// runSession(): what the page runs for each button
// ---------------------------------------------------------------------------

const CREDS = { user: "admin", password: "secret" };

test("runSession logs out after a success, then reports it", async () => {
  const { client, calls } = makeClient([LOGIN_OK]);

  const result = await runSession(client, CREDS, async () => "Applied.");

  assert.deepEqual(result, { ok: true, message: "Applied." });
  assert.equal(calls.at(-1).method, "DELETE");
});

test("runSession logs out after a failure too", async () => {
  const { client, calls } = makeClient([LOGIN_OK, [SETTINGS_URL, "PUT", { status: 400 }]]);

  const result = await runSession(client, CREDS, (c) =>
    c.applySettings("engine-1", "device-1", {}, { confirmed: true }),
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Applying settings failed/);
  assert.equal(calls.at(-1).method, "DELETE");
  assert.equal(calls.at(-1).url, "/server/rest/v4/login/sessions/tok-1");
});

test("runSession logs out after an Engine-reported error", async () => {
  const { client, calls } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 200, json: { _error: { a: "bad" } } }],
  ]);

  const result = await runSession(client, CREDS, (c) =>
    c.applySettings("engine-1", "device-1", {}, { confirmed: true }),
  );

  assert.equal(result.ok, false);
  assert.match(result.message, /Engine reported errors:\na: bad/);
  assert.equal(calls.at(-1).method, "DELETE");
});

test("a logout failure after a success is only a warning", async () => {
  const { client } = makeClient([LOGIN_OK, ["/login/sessions/tok-1", "DELETE", { status: 500 }]]);

  const result = await runSession(client, CREDS, async () => "Applied.");

  assert.equal(result.ok, true);
  assert.equal(result.message, "Applied.\nWarning: could not log out: HTTP 500.");
});

test("a logout that cannot reach the server after a success is only a warning", async () => {
  const { client } = makeClient([LOGIN_OK, ["/login/sessions/tok-1", "DELETE", { throws: new TypeError("Failed to fetch") }]]);

  const result = await runSession(client, CREDS, async () => "Saved x.json.");

  assert.equal(result.ok, true);
  assert.equal(result.message, "Saved x.json.\nWarning: could not log out: Failed to fetch.");
});

test("a logout that times out after a success warns with the seconds waited", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    [
      "/login/sessions/tok-1",
      "DELETE",
      {
        status: 504,
        text: "x",
        headers: { "x-nx-upstream-error": "UPSTREAM_TIMEOUT", "x-nx-upstream-timeout-seconds": "60" },
      },
    ],
  ]);

  const result = await runSession(client, CREDS, async () => "Saved x.json.");

  assert.equal(result.ok, true);
  assert.equal(result.message, "Saved x.json.\nWarning: could not log out: no answer within 60 s.");
});

test("a logout that never connects after a success warns with the code, not 'Could not reach the server'", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    ["/login/sessions/tok-1", "DELETE", { status: 502, text: "x", headers: { "x-nx-upstream-error": "ECONNREFUSED" } }],
  ]);

  const result = await runSession(client, CREDS, async () => "Saved x.json.");

  assert.equal(result.ok, true);
  assert.equal(result.message, "Saved x.json.\nWarning: could not log out: no connection (ECONNREFUSED).");
});

test("a logout whose connection is lost after a success warns with the code", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    ["/login/sessions/tok-1", "DELETE", { status: 502, text: "x", headers: { "x-nx-upstream-error": "ECONNRESET" } }],
  ]);

  const result = await runSession(client, CREDS, async () => "Saved x.json.");

  assert.equal(result.message, "Saved x.json.\nWarning: could not log out: connection lost (ECONNRESET).");
});

test("a logout failure after Engine errors shows the errors, then the warning, and stays a failure", async () => {
  const { client } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 200, json: { _error: { a: "bad" } } }],
    ["/login/sessions/tok-1", "DELETE", { status: 500 }],
  ]);

  const result = await runSession(client, CREDS, (c) =>
    c.applySettings("engine-1", "device-1", {}, { confirmed: true }),
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.message,
    "The server took the settings but the Engine reported errors:\na: bad\nWarning: could not log out: HTTP 500.",
  );
});

test("a logout failure after a failed GET is silent: only the GET error is shown", async () => {
  const { client, calls } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "GET", { status: 500 }],
    ["/login/sessions/tok-1", "DELETE", { status: 500 }],
  ]);

  const result = await runSession(client, CREDS, (c) => c.downloadSettings("engine-1", "device-1"));

  assert.deepEqual(result, { ok: false, message: "Reading settings failed: HTTP 500." });
  assert.equal(calls.at(-1).method, "DELETE");
});

test("a logout failure after an unknown outcome is silent, and the cause goes to console.debug", async (t) => {
  const debug = t.mock.method(console, "debug", () => {});
  const { client } = makeClient([
    LOGIN_OK,
    [SETTINGS_URL, "PUT", { status: 502, text: "x", headers: { "x-nx-upstream-error": "ECONNRESET" } }],
    ["/login/sessions/tok-1", "DELETE", { status: 500 }],
  ]);

  const result = await runSession(client, CREDS, (c) =>
    c.applySettings("engine-1", "device-1", {}, { confirmed: true }),
  );

  assert.deepEqual(result, {
    ok: false,
    message:
      "Outcome unknown: the connection was lost after the settings were sent. Download the device's settings to check.",
  });
  assert.equal(debug.mock.callCount(), 1);
  assert.ok(debug.mock.calls[0].arguments.includes("ECONNRESET"));
});

for (const [what, reply, message] of [
  [
    "ECONNREFUSED",
    { status: 502, text: "x", headers: { "x-nx-upstream-error": "ECONNREFUSED" } },
    "Could not reach the server (ECONNREFUSED). The settings were not applied.",
  ],
  [
    "certificate",
    { status: 502, text: "x", headers: { "x-nx-upstream-error": "DEPTH_ZERO_SELF_SIGNED_CERT" } },
    "Certificate verification failed. Local servers use a self-signed certificate, restart server.mjs with --insecure. The settings were not applied.",
  ],
  [
    "NO_SERVER_HOST",
    { status: 502, text: "x", headers: { "x-nx-upstream-error": "NO_SERVER_HOST" } },
    "No VMS server configured. Restart server.mjs with --server-host https://<ip>:7001. The settings were not applied.",
  ],
  [
    "dev server gone",
    { throws: new TypeError("Failed to fetch") },
    "Could not reach the server: Failed to fetch. The settings were not applied.",
  ],
]) {
  test(`runSession: a login ${what} during apply says the settings were not applied`, async () => {
    const { client, calls } = makeClient([["/login/sessions", "POST", reply]]);

    const result = await runSession(client, CREDS, async () => "never", { applying: true });

    assert.deepEqual(result, { ok: false, message });
    assert.equal(calls.length, 1);
  });

  test(`runSession: a login ${what} during download says nothing about applying`, async () => {
    const { client } = makeClient([["/login/sessions", "POST", reply]]);

    const result = await runSession(client, CREDS, async () => "never");

    assert.equal(result.ok, false);
    assert.doesNotMatch(result.message, /not applied/);
  });
}

test("runSession: a refused login during apply is not a connection failure", async () => {
  const { client } = makeClient([["/login/sessions", "POST", { status: 401 }]]);

  const result = await runSession(client, CREDS, async () => "never", { applying: true });

  assert.doesNotMatch(result.message, /not applied/);
});

test("runSession gives a refused login no Power User hint, and sends no logout without a token", async () => {
  const { client, calls } = makeClient([["/login/sessions", "POST", { status: 401 }]]);

  const result = await runSession(client, CREDS, async () => "never");

  assert.equal(result.ok, false);
  assert.match(result.message, /^Login unauthorized \(HTTP 401\)/);
  assert.doesNotMatch(result.message, /Power User/);
  assert.equal(calls.length, 1);
});

for (const [what, method, run] of [
  ["download", "GET", (c) => c.downloadSettings("engine-1", "device-1")],
  ["apply", "PUT", (c) => c.applySettings("engine-1", "device-1", {}, { confirmed: true })],
]) {
  test(`runSession names Power User once for a refused ${what}`, async () => {
    const { client } = makeClient([LOGIN_OK, [SETTINGS_URL, method, { status: 403 }]]);

    const result = await runSession(client, CREDS, run);

    assert.equal(result.ok, false);
    assert.match(result.message, / This endpoint needs Power User or better\.$/);
    assert.equal(result.message.match(/Power User/g).length, 1);
  });
}
