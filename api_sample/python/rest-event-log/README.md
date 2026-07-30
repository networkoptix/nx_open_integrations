# REST API — Read the event log via relay (Python)

Reads ONE site's event history with a **cloud account**, through the Cloud
relay, using the **v4** event endpoint.

```
Events for 1111....-5555
window: 2026-06-12 14:00:00 -> 2026-06-13 14:00:00 UTC   (37 events)

TIME (UTC)           EVENT                    ACTION            RESOURCE
2026-06-13 13:58:01  cameraDisconnectEvent    showPopupAction       Lobby Cam
2026-06-13 13:41:22  cameraMotionEvent        cameraRecordingAction Dock Cam
```

## The flow

```
1. POST {cloud}/cdb/oauth2/token  (..., scope="cloudSystemId=<id>")   -> scoped token
   (or pass an existing scoped token with --token)
2. GET  https://<id>.relay.vmsproxy.com/rest/v4/events/log
        ?startTimeMs=<ms>&durationMs=<ms>[&eventType=...]
        Authorization: Bearer <token>
```

### Two things worth knowing

- **Manual 307 handling.** The relay 307-redirects to the serving node. Auto-
  follow can drop the `Authorization` header across hosts, so this sample
  follows the redirect itself and re-attaches the bearer on each hop.
- **v4 time contract.** The window is `startTimeMs` + `durationMs`
  (milliseconds), not from/to. `eventType` / `actionType` are repeatable
  filters. Each record is `{ timestampMs, eventData{}, actionData{}, ruleId,
  flags }` — details live inside the `eventData` / `actionData` maps.

## Prerequisites

- Python 3.8+
- A cloud account with access to the target site, and that site's **Cloud Site
  ID** (a UUID). The tests need neither an account nor a network.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Uses the shared `NX_CLOUD_*` variables plus `NX_CLOUD_SITE_ID`
(`cp ../../.env.example ../../.env`, then set `NX_CLOUD_SITE_ID`).

## Run

```bash
# Last 24h (default) using the shared .env:
python rest_event_log.py --env-file ../../.env --insecure

# Last 7 days, only motion events, newest first, max 100:
python rest_event_log.py --env-file ../../.env --since 7d --event-type cameraMotionEvent --limit 100

# List the event types THIS site supports (then exit, without reading the log):
python rest_event_log.py --env-file ../../.env --list-event-types

# An absolute window with an existing scoped token:
python rest_event_log.py \
  --cloud-host https://nxvms.com --site-id <id> --token <scoped-token> \
  --start 2026-06-10T00:00:00Z --end 2026-06-11T00:00:00Z
```

## Run the tests

```bash
pytest -v
```

## Event types you can filter on

The **manifest is the live, per-site source of truth.** The built-in types
below are the common ones, but a site may expose extra analytics, software-
trigger, or otherwise custom types — run `--list-event-types` to see exactly
what THIS site supports, then pass any id to `--event-type`.

```
GET https://<id>.relay.vmsproxy.com/rest/v4/events/manifest/events
```

returns an object map keyed by event-type id (`{ "cameraMotionEvent": { "id":
"cameraMotionEvent", "displayName": "Motion Detected" }, ... }`).

### Built-in event types

**Camera events**

| Event type id | What it covers |
|---|---|
| `cameraMotionEvent` | Motion detected on a camera |
| `cameraInputEvent` | A camera input port signal |
| `cameraDisconnectEvent` | A camera went offline |
| `cameraIpConflictEvent` | Two cameras claim the same IP |
| `analyticsSdkEvent` | An analytics plugin (SDK) event |
| `pluginDiagnosticEvent` | A diagnostic raised by a plugin |
| `softwareTriggerEvent` | A manual / API soft trigger |
| `userDefinedEvent` | A generic event raised via the API |

**Server & site health**

| Event type id | What it covers |
|---|---|
| `anyServerEvent` | Any server-originated event |
| `serverStartEvent` | A server started |
| `serverFailureEvent` | A server failure |
| `serverConflictEvent` | A server conflict in the site |
| `storageFailureEvent` | A storage failure |
| `backupFinishedEvent` | A backup completed |
| `networkIssueEvent` | A network issue |
| `fanErrorEvent` | A hardware fan error |
| `poeOverBudgetEvent` | PoE power budget exceeded |
| `licenseIssueEvent` | A licensing issue |
| `saasIssueEvent` | A SaaS / cloud service issue |
| `ldapSyncIssueEvent` | An LDAP sync issue |
| `siteHealthEvent` | A site-health event |
| `maxSiteHealthEvent` | Highest-severity site-health event |

**Generic & meta**

| Event type id | What it covers |
|---|---|
| `anyEvent` | Matches any event type |
| `anyCameraEvent` | Matches any camera event |
| `undefinedEvent` | An event with no specific type |

### Action types

These are the action ids the rules engine can run in response to an event.
`actionData.actionType` reports them in the log, and `--action-type` filters on
them.

| | | |
|---|---|---|
| `acknowledgeAction` | `bookmarkAction` | `buzzerAction` |
| `cameraOutputAction` | `cameraRecordingAction` | `diagnosticsAction` |
| `execHttpRequestAction` | `executePtzPresetAction` | `exitFullscreenAction` |
| `fullscreenCameraAction` | `openLayoutAction` | `panicRecordingAction` |
| `playSoundAction` | `playSoundOnceAction` | `pushNotificationAction` |
| `sayTextAction` | `sendMailAction` | `showOnAlarmLayoutAction` |
| `showPopupAction` | `showTextOverlayAction` | `undefinedAction` |

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
| `--list-event-types` | List the event types this site supports, then exit (no log read) |
| `--event-type` / `--action-type` | Filters (repeatable) |
| `--order` | `asc` or `desc` (default `desc`) |
| `--limit` | Max records (default 50) |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--debug` | Print the raw events JSON response |

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials, wrong site id, or no access. | Re-check all three; add `--mfa-code` for 2FA. |
| `The site rejected the token` | Token not scoped to this site. | Confirm `--site-id`; the scope must be `cloudSystemId=<that id>`. |
| `No events in this time range` | Nothing happened in the window. | Widen `--since`, raise `--limit`, or drop `--event-type`. |
| `SSLError` | Relay/site TLS trust. | Lab only: add `--insecure`. |

## Files

| File | Purpose |
|------|---------|
| `rest_event_log.py` | The sample (`NxCloudEventLogClient` + parsing helpers + CLI). |
| `test_rest_event_log.py` | Offline tests (mocked HTTP). |
| `requirements.txt` | `requests` + `pytest`. |
