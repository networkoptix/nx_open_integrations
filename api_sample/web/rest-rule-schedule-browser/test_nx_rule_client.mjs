// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-rule-client.mjs. No network, no account, no browser, no
 * real server.
 *
 * What we cover: the pure schedule helpers (buildSchedule per preset + bad
 * hours, summarizeSchedule), the config
 * helpers (resolveConfig/missingFields/normalizePreset), the login flows for
 * both modes (with a fake fetch), listRules (bare array + { reply } envelope),
 * patchSchedule (PATCH body + empty-200 success), the auth-error mapping, and
 * the global-fetch receiver regression guard.
 *
 * Run from this folder:  node --test test_nx_rule_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxRuleClient,
  resolveConfig,
  missingFields,
  buildSchedule,
  buildScheduleFromDays,
  summarizeSchedule,
  normalizePreset,
  RULES_PATH,
  SECONDS_PER_HOUR,
  SECONDS_PER_DAY,
  MODE_DIRECT,
  MODE_CLOUD,
  AuthError,
  ApiError,
} from "./nx-rule-client.mjs";

function makeResponse({ status = 200, json = null, text = "" } = {}) {
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
  };
}

// A fake fetch that records every call and replies per HTTP method.
function fakeFetch({ post = null, get = null, patch = null, del = null } = {}) {
  const calls = { post: null, get: null, patch: null, deleteUrl: null, deleteCalls: 0 };
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST") {
      calls.post = { url, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
      return post;
    }
    if (method === "PATCH") {
      calls.patch = { url, headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null };
      return patch;
    }
    if (method === "DELETE") {
      calls.deleteUrl = url;
      calls.deleteCalls += 1;
      return del;
    }
    calls.get = { url, headers: options.headers || {} };
    return get;
  };
  impl.calls = calls;
  return impl;
}

const SITE = "11111111-2222-3333-4444-555555555555";
const SERVER = "https://192.168.1.10:7001";
const SERVER_SEG = encodeURIComponent(SERVER); // first /server/ path segment

// ---------------------------------------------------------------------------
// buildSchedule: presets + hour validation
// ---------------------------------------------------------------------------

test("buildSchedule 'always' is an empty array (always enabled)", () => {
  assert.deepEqual(buildSchedule("always"), []);
});

test("buildSchedule '24x7' is all 7 days, full day, ignoring hours", () => {
  const s = buildSchedule("24x7", 3, 4);
  assert.equal(s.length, 7);
  assert.deepEqual(s.map((t) => t.dayOfWeek), [1, 2, 3, 4, 5, 6, 7]);
  for (const t of s) {
    assert.equal(t.startTime, 0);
    assert.equal(t.endTime, SECONDS_PER_DAY);
  }
});

test("buildSchedule 'weekdays' covers Mon–Fri with the given hours", () => {
  const s = buildSchedule("weekdays", 9, 18);
  assert.deepEqual(s.map((t) => t.dayOfWeek), [1, 2, 3, 4, 5]);
  assert.equal(s[0].startTime, 9 * SECONDS_PER_HOUR);
  assert.equal(s[0].endTime, 18 * SECONDS_PER_HOUR);
});

test("buildSchedule 'weekend' covers Sat–Sun with the given hours", () => {
  const s = buildSchedule("weekend", 8, 20);
  assert.deepEqual(s.map((t) => t.dayOfWeek), [6, 7]);
  assert.equal(s[1].startTime, 8 * SECONDS_PER_HOUR);
  assert.equal(s[1].endTime, 20 * SECONDS_PER_HOUR);
});

test("buildSchedule accepts numeric-string hours (from the form)", () => {
  const s = buildSchedule("weekdays", "9", "17");
  assert.equal(s[0].startTime, 9 * SECONDS_PER_HOUR);
  assert.equal(s[0].endTime, 17 * SECONDS_PER_HOUR);
});

test("buildSchedule rejects bad hours (start >= end, out of range, non-integer)", () => {
  assert.throws(() => buildSchedule("weekdays", 18, 9), ApiError);
  assert.throws(() => buildSchedule("weekdays", -1, 9), ApiError);
  assert.throws(() => buildSchedule("weekdays", 9, 25), ApiError);
  assert.throws(() => buildSchedule("weekdays", 9.5, 18), ApiError);
});

// ---------------------------------------------------------------------------
// buildScheduleFromDays: the custom day+time picker the page uses
// ---------------------------------------------------------------------------

test("buildScheduleFromDays makes one task per chosen day with the given hours", () => {
  const s = buildScheduleFromDays([1, 3, 5], 9, 18);
  assert.deepEqual(s, [
    { dayOfWeek: 1, startTime: 9 * SECONDS_PER_HOUR, endTime: 18 * SECONDS_PER_HOUR },
    { dayOfWeek: 3, startTime: 9 * SECONDS_PER_HOUR, endTime: 18 * SECONDS_PER_HOUR },
    { dayOfWeek: 5, startTime: 9 * SECONDS_PER_HOUR, endTime: 18 * SECONDS_PER_HOUR },
  ]);
});

test("buildScheduleFromDays de-duplicates and sorts days, accepts numeric-string days/hours", () => {
  const s = buildScheduleFromDays(["7", 1, 1, "3"], "8", "10");
  assert.deepEqual(s.map((t) => t.dayOfWeek), [1, 3, 7]);
  assert.equal(s[0].startTime, 8 * SECONDS_PER_HOUR);
  assert.equal(s[0].endTime, 10 * SECONDS_PER_HOUR);
});

test("buildScheduleFromDays supports an all-day window (0..24 -> 0..86400)", () => {
  const s = buildScheduleFromDays([6, 7], 0, 24);
  assert.deepEqual(s, [
    { dayOfWeek: 6, startTime: 0, endTime: SECONDS_PER_DAY },
    { dayOfWeek: 7, startTime: 0, endTime: SECONDS_PER_DAY },
  ]);
});

test("buildScheduleFromDays throws when no days are chosen", () => {
  assert.throws(() => buildScheduleFromDays([], 9, 18), ApiError);
  assert.throws(() => buildScheduleFromDays([0, 8, 9], 9, 18), ApiError); // all out of 1..7 range
});

test("buildScheduleFromDays rejects bad hours", () => {
  assert.throws(() => buildScheduleFromDays([1], 18, 9), ApiError);
  assert.throws(() => buildScheduleFromDays([1], -1, 9), ApiError);
  assert.throws(() => buildScheduleFromDays([1], 9, 25), ApiError);
  assert.throws(() => buildScheduleFromDays([1], 9.5, 18), ApiError);
});

// ---------------------------------------------------------------------------
// summarizeSchedule: human summary used in the table
// ---------------------------------------------------------------------------

test("summarizeSchedule shows 'always' for empty/undefined", () => {
  assert.equal(summarizeSchedule([]), "always");
  assert.equal(summarizeSchedule(undefined), "always");
});

test("summarizeSchedule formats day + HH:MM-HH:MM, sorted", () => {
  const s = [
    { dayOfWeek: 5, startTime: 9 * SECONDS_PER_HOUR, endTime: 18 * SECONDS_PER_HOUR },
    { dayOfWeek: 1, startTime: 9 * SECONDS_PER_HOUR, endTime: 18 * SECONDS_PER_HOUR },
  ];
  assert.equal(summarizeSchedule(s), "Mon 09:00-18:00, Fri 09:00-18:00");
});

// ---------------------------------------------------------------------------
// normalizePreset
// ---------------------------------------------------------------------------

test("normalizePreset accepts the known presets (case-insensitive)", () => {
  assert.equal(normalizePreset("Weekdays"), "weekdays");
  assert.equal(normalizePreset(" 24X7 "), "24x7");
});

test("normalizePreset rejects an unknown preset", () => {
  assert.throws(() => normalizePreset("monthly"), ApiError);
});

// ---------------------------------------------------------------------------
// config helpers
// ---------------------------------------------------------------------------

test("resolveConfig trims fields and defaults mode to direct", () => {
  const c = resolveConfig({ serverAddress: "  https://192.168.1.10:7001 ", user: " admin " });
  assert.equal(c.mode, "direct");
  assert.equal(c.serverAddress, "https://192.168.1.10:7001");
  assert.equal(c.user, "admin");
  assert.equal(c.mfaCode, null);
});

test("resolveConfig keeps cloud mode and trims the email", () => {
  const c = resolveConfig({ mode: "cloud", user: "  me@x.com ", siteId: SITE });
  assert.equal(c.mode, "cloud");
  assert.equal(c.user, "me@x.com");
});

test("missingFields: direct needs serverAddress/user/password", () => {
  assert.deepEqual(missingFields(resolveConfig({ mode: "direct" })), ["serverAddress", "user", "password"]);
  assert.deepEqual(
    missingFields(resolveConfig({ mode: "direct", serverAddress: SERVER, user: "u", password: "p" })),
    [],
  );
});

test("missingFields: cloud needs siteId/user/password", () => {
  assert.deepEqual(missingFields(resolveConfig({ mode: "cloud" })), ["siteId", "user", "password"]);
  assert.deepEqual(
    missingFields(resolveConfig({ mode: "cloud", siteId: SITE, user: "u", password: "p" })),
    [],
  );
});

// ---------------------------------------------------------------------------
// login(): DIRECT mode
// ---------------------------------------------------------------------------

test("direct login posts to the /server/<encoded-base> login route with setCookie:false", async () => {
  const f = fakeFetch({ post: makeResponse({ json: { token: "tok-1" } }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "admin", password: "pw", fetchImpl: f });
  const token = await client.login();
  assert.equal(token, "tok-1");
  assert.equal(f.calls.post.url, `/server/${SERVER_SEG}/rest/v4/login/sessions`);
  assert.equal(f.calls.post.body.username, "admin");
  assert.equal(f.calls.post.body.setCookie, false);
});

test("direct login rejected raises AuthError", async () => {
  const f = fakeFetch({ post: makeResponse({ status: 401, text: "no" }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  await assert.rejects(() => client.login(), AuthError);
});

test("direct login with no token raises ApiError", async () => {
  const f = fakeFetch({ post: makeResponse({ json: {} }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  await assert.rejects(() => client.login(), ApiError);
});

test("login wraps a network failure as ApiError pointing at the dev server", async () => {
  const f = async () => {
    throw new Error("Failed to fetch");
  };
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  await assert.rejects(() => client.login(), (err) => err instanceof ApiError && /server\.mjs/.test(err.message));
});

// ---------------------------------------------------------------------------
// login(): CLOUD mode
// ---------------------------------------------------------------------------

test("cloud login posts to /cloud with the cloudSystemId scope", async () => {
  const f = fakeFetch({ post: makeResponse({ json: { access_token: "nxcdb-t" } }) });
  const client = new NxRuleClient({ mode: MODE_CLOUD, user: "me@x.com", password: "pw", siteId: SITE, fetchImpl: f });
  const token = await client.login();
  assert.equal(token, "nxcdb-t");
  assert.equal(f.calls.post.url, "/cloud/cdb/oauth2/token");
  assert.equal(f.calls.post.body.scope, `cloudSystemId=${SITE}`);
  assert.equal(f.calls.post.body.client_id, "3rdParty");
  assert.equal(f.calls.post.body.grant_type, "password");
});

test("cloud login adds the mfa code when provided", async () => {
  const f = fakeFetch({ post: makeResponse({ json: { access_token: "t" } }) });
  const client = new NxRuleClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, mfaCode: "999111", fetchImpl: f });
  await client.login();
  assert.equal(f.calls.post.body.mfaCode, "999111");
});

test("cloud login rejected raises AuthError", async () => {
  const f = fakeFetch({ post: makeResponse({ status: 403, text: "no" }) });
  const client = new NxRuleClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, fetchImpl: f });
  await assert.rejects(() => client.login(), AuthError);
});

// ---------------------------------------------------------------------------
// Regression guard: the default fetch must be called via the GLOBAL, not as a
// method of the client (else browsers throw "Can only call Window.fetch …").
// ---------------------------------------------------------------------------

test("default fetch is called via global (preserves receiver, no illegal invocation)", async () => {
  const original = globalThis.fetch;
  let calledThis = "unset";
  globalThis.fetch = function () {
    calledThis = this;
    return makeResponse({ json: { token: "t" } });
  };
  try {
    const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p" }); // no fetchImpl
    await client.login();
    assert.notEqual(calledThis, client, "global fetch must not be invoked as a client method");
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// listRules(): direct + cloud routes, bare array + { reply } envelope
// ---------------------------------------------------------------------------

test("listRules (direct) GETs the /server/<encoded-base> rules route with a bearer header", async () => {
  const rules = [{ id: "r1", enabled: true, comment: "Weekdays", schedule: [] }];
  const f = fakeFetch({ get: makeResponse({ json: rules }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  client.token = "tok-1";
  const out = await client.listRules();
  assert.deepEqual(out, rules);
  assert.equal(f.calls.get.url, `/server/${SERVER_SEG}${RULES_PATH}`);
  assert.equal(f.calls.get.headers.Authorization, "Bearer tok-1");
});

test("listRules (cloud) GETs the /relay/<siteId> rules route", async () => {
  const f = fakeFetch({ get: makeResponse({ json: [] }) });
  const client = new NxRuleClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, fetchImpl: f });
  client.token = "nxcdb-t";
  await client.listRules();
  assert.equal(f.calls.get.url, `/relay/${SITE}${RULES_PATH}`);
});

test("listRules unwraps a { reply: [...] } envelope", async () => {
  const rules = [{ id: "r1" }, { id: "r2" }];
  const f = fakeFetch({ get: makeResponse({ json: { reply: rules } }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  client.token = "tok-1";
  assert.deepEqual(await client.listRules(), rules);
});

test("listRules maps a 401/403 to AuthError", async () => {
  const f = fakeFetch({ get: makeResponse({ status: 401, text: "no" }) });
  const client = new NxRuleClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, fetchImpl: f });
  client.token = "t";
  await assert.rejects(() => client.listRules(), AuthError);
});

// ---------------------------------------------------------------------------
// patchSchedule(): PATCH body shape, route, and empty-200 success
// ---------------------------------------------------------------------------

test("patchSchedule PATCHes /events/rules/{id} with a { schedule } body + bearer", async () => {
  const schedule = buildSchedule("weekdays", 9, 18);
  const f = fakeFetch({ patch: makeResponse({ json: { id: "r1", schedule } }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  client.token = "tok-1";
  const updated = await client.patchSchedule("r1", schedule);
  assert.equal(f.calls.patch.url, `/server/${SERVER_SEG}${RULES_PATH}/r1`);
  assert.deepEqual(f.calls.patch.body, { schedule });
  assert.equal(f.calls.patch.headers.Authorization, "Bearer tok-1");
  assert.equal(f.calls.patch.headers["Content-Type"], "application/json");
  assert.deepEqual(updated.schedule, schedule);
});

test("patchSchedule URI-encodes the rule id", async () => {
  const f = fakeFetch({ patch: makeResponse({ json: {} }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  client.token = "t";
  await client.patchSchedule("{rule 1}", []);
  assert.equal(f.calls.patch.url, `/server/${SERVER_SEG}${RULES_PATH}/${encodeURIComponent("{rule 1}")}`);
});

test("patchSchedule treats an empty 200 body as success (echoes the sent schedule)", async () => {
  const schedule = buildSchedule("always");
  // json() throws (no body), but status is 200/ok -> success.
  const f = fakeFetch({ patch: makeResponse({ status: 200 }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  client.token = "t";
  const updated = await client.patchSchedule("r1", schedule);
  assert.deepEqual(updated, { id: "r1", schedule });
});

test("patchSchedule without a rule id raises ApiError", async () => {
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p" });
  client.token = "t";
  await assert.rejects(() => client.patchSchedule("", []), ApiError);
});

test("patchSchedule maps a 403 to AuthError", async () => {
  const f = fakeFetch({ patch: makeResponse({ status: 403, text: "no" }) });
  const client = new NxRuleClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, fetchImpl: f });
  client.token = "t";
  await assert.rejects(() => client.patchSchedule("r1", []), AuthError);
});

test("listRules/patchSchedule without login raise ApiError (no token)", async () => {
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p" });
  await assert.rejects(() => client.listRules(), ApiError);
  await assert.rejects(() => client.patchSchedule("r1", []), ApiError);
});

// ---------------------------------------------------------------------------
// logout() revokes against the right endpoint per mode
// ---------------------------------------------------------------------------

test("direct logout deletes the session token via /server/<encoded-base>", async () => {
  const f = fakeFetch({ del: makeResponse({ status: 204 }) });
  const client = new NxRuleClient({ mode: MODE_DIRECT, serverAddress: SERVER, user: "u", password: "p", fetchImpl: f });
  client.token = "tok-1";
  await client.logout();
  assert.equal(f.calls.deleteUrl, `/server/${SERVER_SEG}/rest/v4/login/sessions/tok-1`);
  assert.equal(client.token, null);
});

test("cloud logout deletes the scoped token via /cloud", async () => {
  const f = fakeFetch({ del: makeResponse({ status: 204 }) });
  const client = new NxRuleClient({ mode: MODE_CLOUD, user: "u", password: "p", siteId: SITE, fetchImpl: f });
  client.token = "nxcdb-t";
  await client.logout();
  assert.equal(f.calls.deleteUrl, "/cloud/cdb/oauth2/token/nxcdb-t");
  assert.equal(client.token, null);
});
