// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for nx-eventlog-client.mjs. No network, no account, no browser.
 *
 * Run from this folder:  node --test test_nx_eventlog_client.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxEventLogClient,
  resolveConfig,
  missingFields,
  msToIso,
  parseDuration,
  windowEndingNow,
  normalizeEvent,
  buildEventParams,
  toQueryString,
  parseEventTypes,
  AuthError,
  ApiError,
} from "./nx-eventlog-client.mjs";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("msToIso formats epoch ms as UTC, passes junk through", () => {
  assert.equal(msToIso(0), "1970-01-01 00:00:00");
  assert.equal(msToIso(1700000000000), "2023-11-14 22:13:20");
  assert.equal(msToIso(null), "null");
  assert.equal(msToIso("nope"), "nope");
});

test("parseDuration handles units and rejects bare numbers", () => {
  assert.equal(parseDuration("30m"), 30 * 60000);
  assert.equal(parseDuration("24h"), 24 * 3600000);
  assert.equal(parseDuration("7d"), 7 * 86400000);
  assert.equal(parseDuration("2w"), 2 * 604800000);
  assert.throws(() => parseDuration("100"), RangeError);
  assert.throws(() => parseDuration(""), RangeError);
});

test("windowEndingNow returns [start, duration] ending at now", () => {
  const now = 1_000_000_000_000;
  const [start, dur] = windowEndingNow(now, "1h");
  assert.equal(dur, 3600000);
  assert.equal(start, now - 3600000);
});

test("normalizeEvent flattens a v4 record", () => {
  const rec = {
    timestampMs: 1700000000000,
    eventData: { eventType: "cameraDisconnectedEvent", caption: "Lobby cam" },
    actionData: { actionType: "showPopupAction" },
  };
  const ev = normalizeEvent(rec);
  assert.equal(ev.time, "2023-11-14 22:13:20");
  assert.equal(ev.eventType, "cameraDisconnectedEvent");
  assert.equal(ev.actionType, "showPopupAction");
  assert.equal(ev.resource, "Lobby cam");
});

test("normalizeEvent tolerates missing maps", () => {
  const ev = normalizeEvent({ timestampMs: 0 });
  assert.equal(ev.eventType, "");
  assert.equal(ev.actionType, "");
  assert.equal(ev.resource, "");
});

test("buildEventParams uses startTimeMs+durationMs and arrays for types", () => {
  const p = buildEventParams(1000, 2000, { eventType: "x", actionType: ["a", "b"], limit: 10, order: "asc" });
  assert.equal(p.startTimeMs, "1000");
  assert.equal(p.durationMs, "2000");
  assert.equal(p.order, "asc");
  assert.equal(p.limit, "10");
  assert.deepEqual(p.eventType, ["x"]);
  assert.deepEqual(p.actionType, ["a", "b"]);
});

test("toQueryString repeats array params", () => {
  const qs = toQueryString({ startTimeMs: "1", eventType: ["x", "y"] });
  assert.equal(qs, "startTimeMs=1&eventType=x&eventType=y");
});

test("missingFields lists absent required fields", () => {
  assert.deepEqual(missingFields(resolveConfig({})), ["siteId", "user", "password"]);
  assert.deepEqual(missingFields(resolveConfig({ siteId: "s", user: "u", password: "p" })), []);
});

test("parseEventTypes handles the manifest map shape, keeps id+displayName, sorts by name", () => {
  const manifest = {
    cameraDisconnectedEvent: { id: "cameraDisconnectedEvent", displayName: "Camera Disconnected" },
    analyticsSdkEvent: { id: "analyticsSdkEvent", displayName: "Analytics Event" },
  };
  const types = parseEventTypes(manifest);
  assert.deepEqual(types, [
    { id: "analyticsSdkEvent", displayName: "Analytics Event" },     // sorted by displayName
    { id: "cameraDisconnectedEvent", displayName: "Camera Disconnected" },
  ]);
});

test("parseEventTypes tolerates array and reply shapes, and junk", () => {
  assert.equal(parseEventTypes([{ id: "x", displayName: "X" }])[0].id, "x");
  assert.equal(parseEventTypes({ reply: [{ id: "y" }] })[0].id, "y");
  assert.deepEqual(parseEventTypes(null), []);
  assert.deepEqual(parseEventTypes({ bad: { displayName: "no id" } }), []); // entries without id dropped
});

// ---------------------------------------------------------------------------
// Client (fake fetch)
// ---------------------------------------------------------------------------

const SITE = "11111111-2222-3333-4444-555555555555";

function makeResponse({ status = 200, json = null, text = "" } = {}) {
  return {
    status, ok: status < 400,
    async json() { if (json === null) throw new Error("no json"); return json; },
    async text() { return text; },
  };
}

function fakeFetch({ post = null, get = null, del = null } = {}) {
  const calls = { post: null, get: null, deleteUrl: null };
  const impl = async (url, options = {}) => {
    const method = (options.method || "GET").toUpperCase();
    if (method === "POST") { calls.post = { url, body: options.body ? JSON.parse(options.body) : null }; return post; }
    if (method === "DELETE") { calls.deleteUrl = url; return del; }
    calls.get = { url, headers: options.headers, redirect: options.redirect };
    return get;
  };
  impl.calls = calls;
  return impl;
}

function makeClient(fetchOpts = {}, overrides = {}) {
  const f = fakeFetch(fetchOpts);
  const client = new NxEventLogClient({ siteId: SITE, user: "me@x.com", password: "pw", fetchImpl: f, ...overrides });
  return { client, f };
}

test("login posts to same-origin /cloud route with the site scope", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "nxcdb-t" } }) });
  const token = await client.login();
  assert.equal(token, "nxcdb-t");
  assert.equal(f.calls.post.url, "/cloud/cdb/oauth2/token");
  assert.equal(f.calls.post.body.scope, `cloudSystemId=${SITE}`);
});

test("login rejected raises AuthError", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 401, text: "no" }) });
  await assert.rejects(() => client.login(), AuthError);
});

test("getEventLog hits same-origin relay events path, bearer, no manual redirect", async () => {
  const raw = [{ timestampMs: 1700000000000, eventData: { eventType: "motionEvent" }, actionData: {} }];
  const { client, f } = makeClient({ get: makeResponse({ json: raw }) });
  client.useToken("nxcdb-t");
  const events = await client.getEventLog(1000, 2000, { eventType: "motionEvent", limit: 5 });
  assert.equal(events[0].eventType, "motionEvent");
  assert.ok(f.calls.get.url.startsWith(`/relay/${SITE}/rest/v4/events/log?`));
  assert.ok(f.calls.get.url.includes("startTimeMs=1000"));
  assert.ok(f.calls.get.url.includes("durationMs=2000"));
  assert.ok(f.calls.get.url.includes("eventType=motionEvent"));
  assert.equal(f.calls.get.headers.Authorization, "Bearer nxcdb-t");
  assert.equal(f.calls.get.redirect, undefined);
});

test("getEventLog unwraps a reply envelope and tolerates junk", async () => {
  const { client } = makeClient({ get: makeResponse({ json: { reply: [{ timestampMs: 0, eventData: { type: "x" } }] } }) });
  client.useToken("t");
  const events = await client.getEventLog(0, 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "x");
});

test("getEventLog maps a site 403 to AuthError", async () => {
  const { client } = makeClient({ get: makeResponse({ status: 403, text: "denied" }) });
  client.useToken("t");
  await assert.rejects(() => client.getEventLog(0, 1000), AuthError);
});

test("getEventLog without a token raises ApiError", async () => {
  const { client } = makeClient();
  await assert.rejects(() => client.getEventLog(0, 1000), ApiError);
});

test("getEventTypes hits the same-origin manifest path with bearer and parses the map", async () => {
  const manifest = {
    motionEvent: { id: "motionEvent", displayName: "Motion" },
    softwareTriggerEvent: { id: "softwareTriggerEvent", displayName: "Soft Trigger" },
  };
  const { client, f } = makeClient({ get: makeResponse({ json: manifest }) });
  client.useToken("nxcdb-t");
  const types = await client.getEventTypes();
  assert.equal(f.calls.get.url, `/relay/${SITE}/rest/v4/events/manifest/events`);
  assert.equal(f.calls.get.headers.Authorization, "Bearer nxcdb-t");
  assert.deepEqual(types.map((t) => t.id), ["motionEvent", "softwareTriggerEvent"]);
});

test("logout deletes the token via the same-origin /cloud route", async () => {
  const { client, f } = makeClient({ del: makeResponse({ status: 204 }) });
  client.useToken("nxcdb-t");
  await client.logout();
  assert.equal(f.calls.deleteUrl, "/cloud/cdb/oauth2/token/nxcdb-t");
  assert.equal(client.token, null);
});
