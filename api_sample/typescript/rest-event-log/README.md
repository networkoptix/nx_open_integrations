# REST API — Read the event log via relay (TypeScript)

TypeScript port of [`../../node_js/rest-event-log`](../../node_js/rest-event-log)
(see also the [Python version](../../python/rest-event-log)). Reads ONE site's
event history with a **cloud account**, through the Cloud relay, using the **v4**
event endpoint. No third-party runtime dependencies — built-in `fetch` and
`node:test`. The only dependencies are dev-only (`typescript` + `@types/node`)
for type-checking.

## Running TypeScript

These samples run **directly on Node 22.6+** via native type stripping — there
is no build step. Node simply strips the type annotations and runs the file:

```bash
node rest_event_log.ts --dotenv ../../.env
node --test test_rest_event_log.ts        # offline tests
npm run typecheck                          # tsc --noEmit (from ../, the typescript/ root)
```

The code follows the type-stripping house style: `erasableSyntaxOnly` (no
enums/namespaces/parameter-properties), `verbatimModuleSyntax` (shared types are
imported with `import type`), and the test imports the sample with an explicit
`.ts` extension.

## The flow

```
1. POST {cloud}/cdb/oauth2/token  (..., scope:"cloudSystemId=<id>")   -> scoped token
   (or pass an existing scoped token with --token)
2. GET  https://<id>.relay.vmsproxy.com/rest/v4/events/log
        ?startTimeMs=<ms>&durationMs=<ms>[&eventType=...]
        Authorization: Bearer <token>
```

### Two things worth knowing

- **Manual 307 handling.** The relay 307-redirects to the serving node. Auto-
  follow can drop the `Authorization` header across hosts, so this sample uses
  `redirect:"manual"` and re-attaches the bearer on each hop
  (`getFollowingRedirects()`).
- **v4 time contract.** The window is `startTimeMs` + `durationMs` (milliseconds),
  not from/to. `eventType` / `actionType` are repeatable array params. Each
  record is `{ timestampMs, eventData{}, actionData{}, ruleId, flags }` — the
  details live inside the `eventData` / `actionData` maps.

## Run

```bash
# Last 24h (default) using the shared .env:
node rest_event_log.ts --dotenv ../../.env

# Last 7 days, only motion events, newest first, max 100:
node rest_event_log.ts --dotenv ../../.env --since 7d --event-type cameraMotionEvent --limit 100

# Discover which event types THIS site exposes, then exit:
node rest_event_log.ts --dotenv ../../.env --list-event-types

# An absolute window with an existing scoped token:
node rest_event_log.ts \
  --cloud-host https://nxvms.com --site-id <id> --token <scoped-token> \
  --start 2026-06-10T00:00:00Z --end 2026-06-11T00:00:00Z
```

`--dotenv` is used instead of `--env-file` (a Node built-in); see the
`cdb-get-token` README for why.

## Run the tests

```bash
node --test test_rest_event_log.ts   # or, from the typescript/ root: npm test
```

## CLI flags

| Flag | Purpose |
|------|---------|
| `--cloud-host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` / `--password` | Cloud credentials (or use `--token`) |
| `--site-id` | Cloud Site ID of the target site (UUID) |
| `--token` | Use this site-scoped bearer token (skip login) |
| `--mfa-code` | One-time 2FA code |
| `--since` | How far back: `30m`, `24h` (default), `7d`, `2w` |
| `--start` / `--end` | Absolute window (ISO 8601 or epoch); `--start` overrides `--since` |
| `--event-type` / `--action-type` | Filters (repeatable) |
| `--list-event-types` | Fetch this site's event-type manifest, print it, and exit (no log read) |
| `--order` | `asc` or `desc` (default `desc`) |
| `--limit` | Max records (default 50) |
| `--dotenv` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--debug` | Print the raw events JSON response |

## Event types you can filter on

The manifest at `GET /rest/v4/events/manifest/events` is the live, per-site
source of truth for which event types exist. The built-in types below are common
to most sites, but a given site may expose extra analytics, software-trigger, or
custom types — run `--list-event-types` to see exactly what THIS site supports,
then pass an id to `--event-type`.

**Camera events**

| ID | What it is |
|----|------------|
| `cameraMotionEvent` | Motion detected on a camera |
| `cameraInputEvent` | A camera input port was triggered |
| `cameraDisconnectEvent` | A camera went offline |
| `cameraIpConflictEvent` | Two cameras claimed the same IP |
| `analyticsSdkEvent` | An analytics plugin raised an event |
| `pluginDiagnosticEvent` | A plugin reported a diagnostic |
| `softwareTriggerEvent` | A manual/API software trigger fired |
| `userDefinedEvent` | A generic user/integration-defined event |

**Server & site-health events**

| ID | What it is |
|----|------------|
| `serverStartEvent` | A server started |
| `serverFailureEvent` | A server stopped responding or failed |
| `serverConflictEvent` | Conflicting servers were detected |
| `storageFailureEvent` | A storage location failed |
| `backupFinishedEvent` | A backup completed |
| `networkIssueEvent` | A network problem was detected |
| `fanErrorEvent` | A hardware fan error was reported |
| `poeOverBudgetEvent` | PoE power draw exceeded budget |
| `licenseIssueEvent` | A licensing problem was detected |
| `saasIssueEvent` | A SaaS/services issue was detected |
| `ldapSyncIssueEvent` | An LDAP sync problem occurred |
| `siteHealthEvent` | A site-health condition was reported |
| `maxSiteHealthEvent` | A site-health threshold was reached |

**Generic & meta**

| ID | What it is |
|----|------------|
| `anyCameraEvent` | Matches any camera event |
| `anyServerEvent` | Matches any server event |
| `anyEvent` | Matches any event |
| `undefinedEvent` | An unspecified/placeholder event |

## Action types

Actions are what a rule does in response to an event. Filter with
`--action-type`.

| ID | ID | ID |
|----|----|----|
| `acknowledgeAction` | `bookmarkAction` | `buzzerAction` |
| `cameraOutputAction` | `cameraRecordingAction` | `diagnosticsAction` |
| `execHttpRequestAction` | `executePtzPresetAction` | `exitFullscreenAction` |
| `fullscreenCameraAction` | `openLayoutAction` | `panicRecordingAction` |
| `playSoundAction` | `playSoundOnceAction` | `pushNotificationAction` |
| `sayTextAction` | `sendMailAction` | `showOnAlarmLayoutAction` |
| `showPopupAction` | `showTextOverlayAction` | `undefinedAction` |

## Files

| File | Purpose |
|------|---------|
| `rest_event_log.ts` | The sample (`NxCloudEventLogClient` + parsing helpers + CLI). |
| `test_rest_event_log.ts` | Offline tests (`node:test`, mocked `fetch`). |
| `../nx-types.ts` | Shared, type-only API models (imported with `import type`). |
| `../package.json` | `type: module`, `npm test` / `npm run typecheck`. Dev-only deps. |

## Related

- Node.js version: [`../../node_js/rest-event-log`](../../node_js/rest-event-log)
- Python version: [`../../python/rest-event-log`](../../python/rest-event-log)
