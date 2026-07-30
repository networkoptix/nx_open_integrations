// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for rest_event_log.mjs. No network, no server needed.
 *
 * Covers: site-scoped token request, manual 307 redirect handling (bearer
 * preserved), v4 query params (startTimeMs/durationMs, array filters), and
 * normalizing the v4 record shape ({timestampMs, eventData{}, actionData{}}).
 *
 * Run from this folder:  node --test test_rest_event_log.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxCloudEventLogClient,
  normalizeEvent,
  normalizeManifest,
  formatManifestTable,
  buildEventParams,
  formatEventsTable,
  parseDuration,
  parseTime,
  resolveWindow,
  resolveConfig,
  parseArgs,
  AuthError,
  ApiError,
} from "./rest_event_log.mjs";

const SYS = "11111111-2222-3333-4444-555555555555";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeResponse({ status = 200, json = null, text = "", headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status < 400,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    async json() {
      if (json === null) throw new Error("no json");
      return json;
    },
    async text() {
      return text;
    },
  };
}

/** Serves queued GET responses in order; records each GET. */
function fakeFetch({ post = null, gets = [] } = {}) {
  const getQ = [...gets];
  const calls = { post: null, gets: [] };
  const impl = async (url, options = {}) => {
    if ((options.method || "GET").toUpperCase() === "POST") {
      calls.post = { url, body: options.body ? JSON.parse(options.body) : null };
      return post;
    }
    calls.gets.push({ url, headers: options.headers, redirect: options.redirect });
    return getQ.shift();
  };
  impl.calls = calls;
  return impl;
}

// A v4 record: details live inside eventData / actionData; timestamp in ms.
const RAW_RECORD = {
  timestampMs: 1781247975053,
  eventData: { eventType: "cameraDisconnectEvent", caption: "Lobby Cam" },
  actionData: { actionType: "sendMailAction" },
  ruleId: "rule-1",
  flags: "noFlags",
};

// The v4 manifest is an OBJECT MAP keyed by event-type id. The
// "userDefinedEvent" entry deliberately omits its `id` so we can exercise the
// fall-back-to-the-map-key path.
const RAW_MANIFEST = {
  cameraMotionEvent: { id: "cameraMotionEvent", displayName: "Motion on Camera" },
  serverFailureEvent: { id: "serverFailureEvent", displayName: "Server Failure" },
  userDefinedEvent: { displayName: "Generic Event" },
};

function makeClient({ post = null, gets = [] } = {}) {
  const f = fakeFetch({ post, gets });
  const client = new NxCloudEventLogClient("https://nxvms.com", SYS, { fetchImpl: f });
  return { client, f };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

test("normalize a v4 record", () => {
  const out = normalizeEvent(RAW_RECORD);
  assert.equal(out.event_type, "cameraDisconnectEvent");
  assert.equal(out.action_type, "sendMailAction");
  assert.equal(out.resource, "Lobby Cam");
  assert.ok(out.time.startsWith("2026-06-")); // ms -> readable UTC
});

test("normalize handles missing data", () => {
  const out = normalizeEvent({ timestampMs: null });
  assert.equal(out.event_type, "");
  assert.equal(out.action_type, "");
});

test("buildEventParams uses startTimeMs + durationMs", () => {
  const params = buildEventParams(1000, 2000);
  assert.equal(params.startTimeMs, "1000");
  assert.equal(params.durationMs, "2000");
  assert.equal(params.order, "desc");
  assert.ok(!("eventType" in params));
});

test("buildEventParams wraps array filters", () => {
  const params = buildEventParams(0, 1, { eventType: "motionEvent", actionType: ["a", "b"] });
  assert.deepEqual(params.eventType, ["motionEvent"]);
  assert.deepEqual(params.actionType, ["a", "b"]);
});

test("formatEventsTable renders rows and the empty case", () => {
  assert.ok(formatEventsTable([]).includes("No events"));
  const out = formatEventsTable([normalizeEvent(RAW_RECORD)]);
  assert.ok(out.includes("EVENT") && out.includes("cameraDisconnectEvent"));
});

// ---------------------------------------------------------------------------
// event-type manifest (the object map)
// ---------------------------------------------------------------------------

test("normalizeManifest maps the object to sorted id/displayName pairs", () => {
  const rows = normalizeManifest(RAW_MANIFEST);
  // sorted by id: cameraMotionEvent, serverFailureEvent, userDefinedEvent
  assert.deepEqual(rows[0], ["cameraMotionEvent", "Motion on Camera"]);
  assert.deepEqual(rows[1], ["serverFailureEvent", "Server Failure"]);
});

test("normalizeManifest falls back to the map key when a value lacks id", () => {
  const rows = normalizeManifest(RAW_MANIFEST);
  assert.deepEqual(rows[2], ["userDefinedEvent", "Generic Event"]);
});

test("normalizeManifest handles an empty or non-object payload", () => {
  assert.deepEqual(normalizeManifest({}), []);
  assert.deepEqual(normalizeManifest(null), []);
});

test("formatManifestTable renders rows and the empty case", () => {
  assert.ok(formatManifestTable([]).includes("No event types"));
  const out = formatManifestTable(normalizeManifest(RAW_MANIFEST));
  assert.ok(out.includes("ID") && out.includes("DISPLAY NAME"));
  assert.ok(out.includes("cameraMotionEvent") && out.includes("Motion on Camera"));
});

// ---------------------------------------------------------------------------
// login(): scoped token
// ---------------------------------------------------------------------------

test("login requests a site-scoped token", async () => {
  const { client, f } = makeClient({ post: makeResponse({ json: { access_token: "nxcdb-t" } }) });
  await client.login("me@x.com", "pw");
  assert.equal(f.calls.post.url, "https://nxvms.com/cdb/oauth2/token");
  assert.equal(f.calls.post.body.scope, `cloudSystemId=${SYS}`);
  assert.equal(client.token, "nxcdb-t");
});

test("login rejected raises", async () => {
  const { client } = makeClient({ post: makeResponse({ status: 403, text: "no" }) });
  await assert.rejects(() => client.login("me@x.com", "pw"), AuthError);
});

// ---------------------------------------------------------------------------
// relay URL + the event log call (v4)
// ---------------------------------------------------------------------------

test("relayUrl is built from the site id", () => {
  const { client } = makeClient();
  assert.equal(client.relayUrl, `https://${SYS}.relay.vmsproxy.com`);
});

test("getEventLog hits the relay v4 path with the bearer and manual redirect", async () => {
  const { client, f } = makeClient({ gets: [makeResponse({ json: [RAW_RECORD] })] });
  client.useToken("nxcdb-t");

  const events = await client.getEventLog(1000, 2000);

  const call = f.calls.gets[0];
  const parsed = new URL(call.url);
  assert.equal(parsed.origin + parsed.pathname, `https://${SYS}.relay.vmsproxy.com/rest/v4/events/log`);
  assert.equal(parsed.searchParams.get("startTimeMs"), "1000");
  assert.equal(call.headers.Authorization, "Bearer nxcdb-t");
  assert.equal(call.redirect, "manual"); // we follow redirects ourselves
  assert.equal(events[0].event_type, "cameraDisconnectEvent");
});

test("a 307 redirect is followed with the bearer preserved", async () => {
  const node = "https://node7.relay.vmsproxy.com/rest/v4/events/log?startTimeMs=1000&durationMs=2000";
  const { client, f } = makeClient({
    gets: [makeResponse({ status: 307, headers: { Location: node } }), makeResponse({ json: [RAW_RECORD] })],
  });
  client.useToken("nxcdb-t");

  const events = await client.getEventLog(1000, 2000);

  assert.equal(f.calls.gets.length, 2);
  assert.equal(f.calls.gets[1].url, node);
  assert.equal(f.calls.gets[1].headers.Authorization, "Bearer nxcdb-t");
  assert.equal(events[0].resource, "Lobby Cam");
});

test("a redirect without a Location header raises", async () => {
  const { client } = makeClient({ gets: [makeResponse({ status: 307, headers: {} })] });
  client.useToken("t");
  await assert.rejects(() => client.getEventLog(1, 2), ApiError);
});

test("a rejected token on the event log raises", async () => {
  const { client } = makeClient({ gets: [makeResponse({ status: 403, text: "no" })] });
  client.useToken("t");
  await assert.rejects(() => client.getEventLog(1, 2), AuthError);
});

test("getEventLog without a token raises", async () => {
  const { client } = makeClient({ gets: [makeResponse({ json: [] })] });
  await assert.rejects(() => client.getEventLog(1, 2), ApiError);
});

// ---------------------------------------------------------------------------
// getEventManifest() (same relay/307/bearer plumbing)
// ---------------------------------------------------------------------------

test("getEventManifest hits the relay manifest path with the bearer", async () => {
  const { client, f } = makeClient({ gets: [makeResponse({ json: RAW_MANIFEST })] });
  client.useToken("nxcdb-t");

  const rows = await client.getEventManifest();

  const call = f.calls.gets[0];
  assert.equal(call.url, `https://${SYS}.relay.vmsproxy.com/rest/v4/events/manifest/events`);
  assert.equal(call.headers.Authorization, "Bearer nxcdb-t");
  assert.equal(call.redirect, "manual"); // we follow redirects ourselves
  assert.deepEqual(rows[0], ["cameraMotionEvent", "Motion on Camera"]);
});

test("getEventManifest follows a 307 with the bearer preserved", async () => {
  const node = "https://node7.relay.vmsproxy.com/rest/v4/events/manifest/events";
  const { client, f } = makeClient({
    gets: [makeResponse({ status: 307, headers: { Location: node } }), makeResponse({ json: RAW_MANIFEST })],
  });
  client.useToken("nxcdb-t");

  const rows = await client.getEventManifest();

  assert.equal(f.calls.gets.length, 2);
  assert.equal(f.calls.gets[1].url, node);
  assert.equal(f.calls.gets[1].headers.Authorization, "Bearer nxcdb-t");
  assert.equal(rows.length, 3);
});

test("a rejected token on the manifest raises", async () => {
  const { client } = makeClient({ gets: [makeResponse({ status: 403, text: "no" })] });
  client.useToken("t");
  await assert.rejects(() => client.getEventManifest(), AuthError);
});

// ---------------------------------------------------------------------------
// Time window (--since / --start / --end)
// ---------------------------------------------------------------------------

test("parseDuration units", () => {
  assert.equal(parseDuration("30m"), 30 * 60000);
  assert.equal(parseDuration("24h"), 24 * 3600000);
  assert.equal(parseDuration("7d"), 7 * 86400000);
  assert.equal(parseDuration("2w"), 2 * 604800000);
  assert.equal(parseDuration("1.5h"), Math.trunc(1.5 * 3600000));
});

test("parseDuration requires a unit", () => {
  assert.throws(() => parseDuration("24"), RangeError);
  assert.throws(() => parseDuration("soon"), RangeError);
});

test("parseTime epoch and ISO", () => {
  assert.equal(parseTime("1781247975053"), 1781247975053); // ms
  assert.equal(parseTime("1781247975"), 1781247975 * 1000); // seconds
  assert.equal(parseTime("2026-06-12T00:00:00Z"), 1781222400000); // ISO -> UTC
});

test("parseTime invalid raises", () => {
  assert.throws(() => parseTime("not-a-date"), RangeError);
});

test("resolveWindow with --since", () => {
  const now = 1_000_000_000_000;
  const [startMs, durationMs] = resolveWindow(now, { since: "24h" });
  assert.equal(durationMs, 24 * 3600000);
  assert.equal(startMs, now - durationMs);
});

test("resolveWindow with absolute start/end", () => {
  const [startMs, durationMs] = resolveWindow(5000, { start: "1000", end: "4000" });
  assert.equal(startMs, 1_000_000); // epoch seconds -> ms
  assert.equal(durationMs, 3_000_000);
});

test("resolveWindow start defaults end to now", () => {
  const now = 9_000_000;
  const [startMs, durationMs] = resolveWindow(now, { start: "1000" });
  assert.equal(startMs, 1_000_000);
  assert.equal(durationMs, now - 1_000_000);
});

test("resolveWindow with end before start raises", () => {
  assert.throws(() => resolveWindow(0, { start: "2000", end: "1000" }), RangeError);
});

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

test("config reads the cloud site id (env beats file)", () => {
  const args = { cloudHost: null, user: null, password: null, siteId: null, mfaCode: null, token: null };
  const config = resolveConfig(args, { NX_CLOUD_SITE_ID: "file-sys" }, { NX_CLOUD_SITE_ID: "env-sys" });
  assert.equal(config.siteId, "env-sys");
});

test("parseArgs reads --list-event-types as a boolean", () => {
  assert.equal(parseArgs([]).listEventTypes, false);
  assert.equal(parseArgs(["--list-event-types"]).listEventTypes, true);
});
