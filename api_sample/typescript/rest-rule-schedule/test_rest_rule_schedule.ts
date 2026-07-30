// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/
/**
 * Offline tests for rest_rule_schedule.ts. No network, no account, no real site.
 *
 * Run from this folder:  node --test test_rest_rule_schedule.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  NxRuleClient,
  buildSchedule,
  summarizeSchedule,
  formatRulesTable,
  normalizePreset,
  parseArgs,
  resolveConfig,
  missingFields,
  PRESETS,
  WEEKDAYS,
  WEEKEND,
  SECONDS_PER_DAY,
  MODE_DIRECT,
  MODE_CLOUD,
  AuthError,
  ApiError,
  type Rule,
  type ClientOptions,
} from "./rest_rule_schedule.ts";

// ---------------------------------------------------------------------------
// Fake HTTP plumbing
// ---------------------------------------------------------------------------

interface FakeResponseSpec {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

function makeResponse({ status = 200, json = null, text = "", headers = {} }: FakeResponseSpec = {}): Response {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    async json() {
      if (json === null) throw new Error("no json");
      return json;
    },
    async text() {
      return text;
    },
  } as unknown as Response;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect: RequestInit["redirect"];
  body: Record<string, unknown> | null;
}

type Handler = (call: RecordedCall, index: number) => Response;
type FakeFetch = typeof globalThis.fetch & { calls: RecordedCall[] };

function fakeFetch(handler: Handler): FakeFetch {
  const calls: RecordedCall[] = [];
  const impl = (async (url: string | URL | Request, options: RequestInit = {}) => {
    const hdrs: Record<string, string> = {};
    const h = options.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) hdrs[k] = v;
    const call: RecordedCall = {
      url: String(url),
      method: (options.method || "GET").toUpperCase(),
      headers: hdrs,
      redirect: options.redirect,
      body: options.body ? (JSON.parse(options.body as string) as Record<string, unknown>) : null,
    };
    const idx = calls.length;
    calls.push(call);
    return handler(call, idx);
  }) as FakeFetch;
  impl.calls = calls;
  return impl;
}

const SITE = "11111111-2222-3333-4444-555555555555";
const SERVER = "https://192.168.1.10:7001";

function directClient(handler: Handler, opts: ClientOptions = {}) {
  const f = fakeFetch(handler);
  const client = new NxRuleClient(MODE_DIRECT, "admin", "pw", { serverHost: SERVER, fetchImpl: f, ...opts });
  return { client, f };
}

function cloudClient(handler: Handler, opts: ClientOptions = {}) {
  const f = fakeFetch(handler);
  const client = new NxRuleClient(MODE_CLOUD, "me@x.com", "pw", {
    cloudHost: "https://nxvms.com",
    siteId: SITE,
    fetchImpl: f,
    ...opts,
  });
  return { client, f };
}

// ---------------------------------------------------------------------------
// Schedule helpers (the core logic)
// ---------------------------------------------------------------------------

test("buildSchedule: always -> empty array", () => {
  assert.deepEqual(buildSchedule("always"), []);
});

test("buildSchedule: 24x7 -> all 7 full days", () => {
  const s = buildSchedule("24x7");
  assert.equal(s.length, 7);
  assert.deepEqual(s.map((t) => t.dayOfWeek), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(s.every((t) => t.startTime === 0 && t.endTime === SECONDS_PER_DAY));
});

test("buildSchedule: weekdays Mon-Fri with hour window", () => {
  const s = buildSchedule("weekdays", 9, 18);
  assert.deepEqual(s.map((t) => t.dayOfWeek), WEEKDAYS);
  assert.equal(s[0]!.startTime, 9 * 3600);
  assert.equal(s[0]!.endTime, 18 * 3600);
});

test("buildSchedule: weekend Sat-Sun", () => {
  const s = buildSchedule("weekend", 0, 12);
  assert.deepEqual(s.map((t) => t.dayOfWeek), WEEKEND);
  assert.equal(s[0]!.endTime, 12 * 3600);
});

test("buildSchedule: rejects a bad hour window", () => {
  assert.throws(() => buildSchedule("weekdays", 18, 9), ApiError);
  assert.throws(() => buildSchedule("weekdays", -1, 9), ApiError);
  assert.throws(() => buildSchedule("weekdays", 0, 25), ApiError);
});

test("normalizePreset accepts the enum and rejects others", () => {
  for (const p of PRESETS) assert.equal(normalizePreset(p), p);
  assert.equal(normalizePreset("WEEKDAYS"), "weekdays");
  assert.throws(() => normalizePreset("sometimes"), ApiError);
});

test("summarizeSchedule: empty is 'always', tasks render readably", () => {
  assert.equal(summarizeSchedule([]), "always");
  assert.equal(summarizeSchedule(undefined), "always");
  assert.equal(
    summarizeSchedule([{ dayOfWeek: 1, startTime: 9 * 3600, endTime: 18 * 3600 }]),
    "Mon 09:00-18:00",
  );
});

test("formatRulesTable renders rows and the empty case", () => {
  assert.ok(formatRulesTable([{ id: "r1", enabled: true, comment: "Weekdays", schedule: [] }]).includes("Weekdays"));
  assert.ok(formatRulesTable([]).includes("No event rules"));
});

// ---------------------------------------------------------------------------
// CLI parsing + config
// ---------------------------------------------------------------------------

test("parseArgs reads actions, flags, and booleans", () => {
  const a = parseArgs(["--mode", "cloud", "--rule-id=r9", "--preset", "weekdays", "--start=8", "--end", "20", "--insecure"]);
  assert.equal(a.mode, "cloud");
  assert.equal(a.ruleId, "r9");
  assert.equal(a.preset, "weekdays");
  assert.equal(a.start, "8");
  assert.equal(a.end, "20");
  assert.equal(a.insecure, true);
  assert.equal(parseArgs(["--list"]).list, true);
});

test("parseArgs uses --dotenv and rejects unknown flags", () => {
  assert.equal(parseArgs(["--dotenv", "x.env"]).envFile, "x.env");
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/);
});

test("resolveConfig picks SERVER vars (direct) and CLOUD vars (cloud)", () => {
  const direct = resolveConfig({ mode: "direct" }, {}, {
    NX_SERVER_HOST: SERVER,
    NX_SERVER_USER: "admin",
    NX_SERVER_PASSWORD: "pw",
  } as NodeJS.ProcessEnv);
  assert.equal(direct.serverHost, SERVER);
  assert.deepEqual(missingFields(direct), []);

  const cloud = resolveConfig({ mode: "cloud", siteId: SITE }, {}, {
    NX_CLOUD_USER: "me@x.com",
    NX_CLOUD_PASSWORD: "pw",
  } as NodeJS.ProcessEnv);
  assert.equal(cloud.cloudHost, "https://nxvms.com");
  assert.deepEqual(missingFields(cloud), []);
});

test("missingFields reports per-mode requirements", () => {
  assert.deepEqual(missingFields(resolveConfig({ mode: "direct" }, {}, {} as NodeJS.ProcessEnv)).sort(), [
    "password",
    "serverHost",
    "user",
  ]);
  // cloudHost defaults to https://nxvms.com, so it is never "missing".
  assert.deepEqual(missingFields(resolveConfig({ mode: "cloud" }, {}, {} as NodeJS.ProcessEnv)).sort(), [
    "password",
    "siteId",
    "user",
  ]);
});

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

test("direct login stores the server token", async () => {
  const { client, f } = directClient(() => makeResponse({ json: { token: "srv" } }));
  assert.equal(await client.login(), "srv");
  assert.equal(f.calls[0]!.url, `${SERVER}/rest/v4/login/sessions`);
});

test("cloud login sends the cloudSystemId scope + mfa", async () => {
  const { client, f } = cloudClient(() => makeResponse({ json: { access_token: "nxcdb-t" } }), { mfaCode: "111222" });
  assert.equal(await client.login(), "nxcdb-t");
  assert.equal(f.calls[0]!.body!.scope, `cloudSystemId=${SITE}`);
  assert.equal(f.calls[0]!.body!.mfaCode, "111222");
});

test("login 401 raises AuthError", async () => {
  const { client } = directClient(() => makeResponse({ status: 401 }));
  await assert.rejects(() => client.login(), AuthError);
});

// ---------------------------------------------------------------------------
// listRules
// ---------------------------------------------------------------------------

const RULES: Rule[] = [
  { id: "r1", enabled: true, comment: "Weekdays", schedule: [{ dayOfWeek: 6, startTime: 0, endTime: 3600 }] },
  { id: "r2", enabled: true, comment: "Weekend", schedule: [{ dayOfWeek: 1, startTime: 0, endTime: 3600 }] },
  { id: "r3", enabled: false, comment: "Other", schedule: [] },
];

test("listRules GETs the v4 rules path with the bearer", async () => {
  const { client, f } = directClient(() => makeResponse({ json: RULES }));
  client.token = "srv";
  const rules = await client.listRules();
  assert.equal(rules.length, 3);
  assert.equal(f.calls[0]!.url, `${SERVER}/rest/v4/events/rules`);
  assert.equal(f.calls[0]!.headers.Authorization, "Bearer srv");
  assert.equal(f.calls[0]!.redirect, "manual");
});

test("listRules unwraps a reply envelope", async () => {
  const { client } = directClient(() => makeResponse({ json: { reply: RULES } }));
  client.token = "t";
  assert.equal((await client.listRules()).length, 3);
});

test("listRules 403 raises AuthError", async () => {
  const { client } = directClient(() => makeResponse({ status: 403 }));
  client.token = "t";
  await assert.rejects(() => client.listRules(), AuthError);
});

// ---------------------------------------------------------------------------
// patchSchedule
// ---------------------------------------------------------------------------

test("patchSchedule PATCHes the rule id with a {schedule} body", async () => {
  const { client, f } = directClient((call) => makeResponse({ json: { id: "r1", schedule: call.body!.schedule } }));
  client.token = "srv";
  const sched = buildSchedule("weekdays", 9, 18);
  const updated = await client.patchSchedule("r1", sched);
  assert.equal(f.calls[0]!.method, "PATCH");
  assert.equal(f.calls[0]!.url, `${SERVER}/rest/v4/events/rules/r1`);
  assert.deepEqual(f.calls[0]!.body!.schedule, sched);
  assert.equal((f.calls[0]!.headers as Record<string, string>)["Content-Type"], "application/json");
  assert.equal(updated.id, "r1");
});

test("patchSchedule treats an empty 200 body as success", async () => {
  const { client } = directClient(() => makeResponse({ status: 200 })); // no json
  client.token = "t";
  const updated = await client.patchSchedule("r5", []);
  assert.equal(updated.id, "r5");
  assert.deepEqual(updated.schedule, []);
});

test("patchSchedule without a rule id raises", async () => {
  const { client } = directClient(() => makeResponse());
  client.token = "t";
  await assert.rejects(() => client.patchSchedule("", []), ApiError);
});

test("patchSchedule follows the relay 307, re-attaching bearer + keeping PATCH and body", async () => {
  const base = `https://${SITE}.relay.vmsproxy.com/rest/v4/events/rules/r1`;
  const redirected = "https://node-7.relay.vmsproxy.com/rest/v4/events/rules/r1";
  const { client, f } = cloudClient((call, idx) => {
    if (idx === 0) return makeResponse({ status: 307, headers: { Location: redirected } });
    return makeResponse({ json: { id: "r1" } });
  });
  client.token = "nxcdb-t";
  await client.patchSchedule("r1", buildSchedule("always"));
  assert.ok(f.calls[0]!.url.startsWith(base));
  assert.equal(f.calls[1]!.url.split("?")[0], redirected);
  // Method + body + bearer preserved across the hop.
  assert.equal(f.calls[1]!.method, "PATCH");
  assert.deepEqual(f.calls[1]!.body!.schedule, []);
  assert.equal(f.calls[1]!.headers.Authorization, "Bearer nxcdb-t");
});

test("too many redirects raises ApiError", async () => {
  const { client } = cloudClient((call) => makeResponse({ status: 307, headers: { Location: call.url + "/x" } }));
  client.token = "t";
  await assert.rejects(() => client.patchSchedule("r1", []), /Too many redirects/);
});

// ---------------------------------------------------------------------------
// logout
// ---------------------------------------------------------------------------

test("direct logout DELETEs the server session", async () => {
  const { client, f } = directClient(() => makeResponse({ status: 204 }));
  client.token = "srv";
  await client.logout();
  assert.equal(f.calls[0]!.method, "DELETE");
  assert.equal(f.calls[0]!.url, `${SERVER}/rest/v4/login/sessions/srv`);
  assert.equal(client.token, null);
});

test("cloud logout DELETEs the cloud token", async () => {
  const { client, f } = cloudClient(() => makeResponse({ status: 204 }));
  client.token = "nxcdb-t";
  await client.logout();
  assert.equal(f.calls[0]!.url, "https://nxvms.com/cdb/oauth2/token/nxcdb-t");
});
