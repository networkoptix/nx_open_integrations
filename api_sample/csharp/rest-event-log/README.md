# REST API — Read the event log via relay (C#)

Reads **one site's** event history with a **cloud account**, through the Cloud
relay, using the **v4** event endpoint. C# port of
[`../../python/rest-event-log`](../../python/rest-event-log)
and [`../../node_js/rest-event-log`](../../node_js/rest-event-log). Uses the built-in
HttpClient + System.Text.Json — no third-party packages.

```
Events for 1111....-5555
window: 2026-06-12 14:00:00 -> 2026-06-13 14:00:00 UTC   (37 events)

TIME (UTC)           EVENT                    ACTION            RESOURCE
2026-06-13 13:58:01  cameraDisconnectEvent    showPopupAction   Lobby Cam
2026-06-13 13:41:22  cameraMotionEvent        cameraRecordingAction Dock Cam
```

## The key idea: token scope

A cloud token comes in two flavours. A **cloud-wide** token (`POST
/cdb/oauth2/token` with no scope) is good for account calls like listing your
Sites, but a **site rejects it**. To read a site's event log you must request
the token with `scope=cloudSystemId=<id>` — a **site-scoped** token. (The wire
literal stays `cloudSystemId` even though we call it a "site" everywhere else.)

## Flow walkthrough

The whole flow lives in **`src/NxCloudEventLogClient.cs`** (`Program.cs` is just
CLI wiring). The methods, in order:

**1 — `LoginAsync()`: trade cloud credentials for a site-scoped token.**
```csharp
["scope"] = $"cloudSystemId={_siteId}",   // <- what makes the token work on the site
// POST {cloud}/cdb/oauth2/token  ->  { "access_token": "nxcdb-…" }
Token = ExtractAccessToken(json);
```
Or skip login and supply an existing scoped token with `--token`.

**2 — `GetEventLogAsync()`: read the log through the relay.**
```csharp
string url = $"{RelayUrl}{EventsPath}?{query}";  // https://<siteId>.relay.vmsproxy.com/rest/v4/events/log?...
using var response = await GetFollowingRedirectsAsync(url, ct);
return NormalizeEvents(json);                     // flattens each { timestampMs, eventData{}, actionData{} }
```
`GetFollowingRedirectsAsync` is the interesting part: the relay answers with a
**307** to the serving node, and .NET (like browsers) drops the `Authorization`
header across a cross-host redirect. So the client sets
`AllowAutoRedirect = false` and follows the 307 itself, **re-attaching the
bearer on each hop**.

**3 — `GetEventManifestAsync()`: label/filter events.**
```csharp
// GET /rest/v4/events/manifest/events  ->  OBJECT MAP keyed by event-type id
//   { "cameraMotionEvent": { "id": "cameraMotionEvent", "displayName": "Motion Detected" }, ... }
var manifest = await client.GetEventManifestAsync();   // id -> { Id, DisplayName }
```
Each manifest value carries its own `id` (pass back as `--event-type`) and a
human `displayName`. Run `--list-event-types` to print this manifest as a table
and discover exactly what a given site supports (see below).

### The v4 time contract

The window is `startTimeMs` + `durationMs` (**milliseconds**), not from/to.
`eventType` / `actionType` are **repeatable** filters (`?eventType=a&eventType=b`).
Each record is `{ timestampMs, eventData{}, actionData{}, ruleId, flags }` —
details live inside the `eventData` / `actionData` maps. You express the window
in human terms (`--since 7d`, or `--start`/`--end`), and `TimeWindow.Resolve`
converts it to the `startTimeMs` + `durationMs` pair.

## Event types you can filter on

The **manifest is the live, per-site source of truth**: the event types below are
the common built-ins, but any given site may expose extra ones — analytics
events from camera plugins, `softwareTriggerEvent` triggers configured on the
site, or custom/user-defined types. Run **`--list-event-types`** to see exactly
what THIS site supports, then pass any `id` to `--event-type`.

```bash
dotnet run -- --env-file ../../../.env --insecure --list-event-types
```

```
Event types for 1111....-5555   (12 types)

ID                       DISPLAY NAME
analyticsSdkEvent        Analytics Event
cameraDisconnectEvent    Camera Disconnected
cameraMotionEvent        Motion on Camera
...
```

### Built-in event type ids

**Camera**

| ID | Description |
|----|-------------|
| `cameraDisconnectEvent` | A camera lost its connection to the server. |
| `cameraInputEvent` | A camera's hardware input port was triggered. |
| `cameraIpConflictEvent` | Two cameras claim the same IP address. |
| `cameraMotionEvent` | Motion was detected on a camera. |
| `analyticsSdkEvent` | An analytics plugin (Analytics SDK) raised an event. |
| `pluginDiagnosticEvent` | A camera/server plugin reported a diagnostic. |

**Server & site health**

| ID | Description |
|----|-------------|
| `backupFinishedEvent` | A scheduled backup completed. |
| `fanErrorEvent` | A server's cooling fan failed. |
| `ldapSyncIssueEvent` | LDAP user/group synchronization hit a problem. |
| `licenseIssueEvent` | A licensing problem was detected. |
| `maxSiteHealthEvent` | A site-health metric reached its maximum/threshold. |
| `networkIssueEvent` | A network problem affected a server or camera. |
| `poeOverBudgetEvent` | PoE power draw exceeded the available budget. |
| `saasIssueEvent` | A cloud/SaaS service issue was reported. |
| `serverConflictEvent` | Two servers conflict (e.g. same identity on the site). |
| `serverFailureEvent` | A server failed or went offline unexpectedly. |
| `serverStartEvent` | A server started up. |
| `siteHealthEvent` | A general site-health condition was reported. |
| `storageFailureEvent` | A storage device or archive failed. |

**Generic & meta**

| ID | Description |
|----|-------------|
| `softwareTriggerEvent` | A software/manual trigger configured on the site fired. |
| `userDefinedEvent` | A custom, user-defined event. |
| `anyCameraEvent` | Matches any camera-related event (meta filter). |
| `anyServerEvent` | Matches any server-related event (meta filter). |
| `anyEvent` | Matches any event of any kind (meta filter). |
| `undefinedEvent` | No specific event type (unset/placeholder). |

### Action type ids

The action is what a rule *did* in response to an event. Pass any `id` to
`--action-type`.

| ID | Description |
|----|-------------|
| `acknowledgeAction` | Require an operator to acknowledge the event. |
| `bookmarkAction` | Create a bookmark on the relevant footage. |
| `buzzerAction` | Sound the server's buzzer. |
| `cameraOutputAction` | Trigger a camera's hardware output port. |
| `cameraRecordingAction` | Start recording on a camera. |
| `diagnosticsAction` | Run/emit diagnostics. |
| `execHttpRequestAction` | Send an outgoing HTTP request. |
| `executePtzPresetAction` | Move a PTZ camera to a preset. |
| `exitFullscreenAction` | Exit fullscreen on a client layout. |
| `fullscreenCameraAction` | Show a camera fullscreen on a client. |
| `openLayoutAction` | Open a layout on a client. |
| `panicRecordingAction` | Start panic (forced) recording. |
| `playSoundAction` | Play a sound (looping). |
| `playSoundOnceAction` | Play a sound once. |
| `pushNotificationAction` | Send a mobile push notification. |
| `sayTextAction` | Speak text via text-to-speech. |
| `sendMailAction` | Send an email. |
| `showOnAlarmLayoutAction` | Show the camera on the alarm layout. |
| `showPopupAction` | Show a popup notification on clients. |
| `showTextOverlayAction` | Overlay text on the camera view. |
| `undefinedAction` | No specific action (unset/placeholder). |

## Project layout

```
rest-event-log/
  src/    NxCloudEventLogClient.cs  Config.cs  Program.cs  NxEventLog.csproj
  tests/  NxCloudEventLogClientTests.cs  NxEventLog.Tests.csproj
```

## Prerequisites

- **.NET SDK 10.0+**
- A cloud account with access to the target site, and that site's **Cloud Site
  ID** (a UUID). Find it in the Nx desktop client. The tests need neither an
  account nor a network.

## Run

```bash
cd src

# Last 24h (default) using the shared .env:
dotnet run -- --env-file ../../../.env --insecure

# Discover the event types THIS site supports (no log read):
dotnet run -- --env-file ../../../.env --insecure --list-event-types

# Last 7 days, only motion events, newest first, max 100:
dotnet run -- --env-file ../../../.env --since 7d --event-type cameraMotionEvent --limit 100

# An absolute window with an existing scoped token:
dotnet run -- \
  --cloud-host https://nxvms.com --site-id 1111....-5555 --token <scoped-token> \
  --start 2026-06-10T00:00:00Z --end 2026-06-11T00:00:00Z
```

Add `--mfa-code 123456` if your cloud account has 2FA.

Config precedence: **CLI > env var > `.env`** (`NX_CLOUD_HOST` / `NX_CLOUD_USER`
/ `NX_CLOUD_PASSWORD` / `NX_CLOUD_SITE_ID`).

## Run the tests

```bash
cd tests
dotnet test
```

> Note: these tests were written but **not executed in the authoring
> environment** (no .NET SDK there). They use standard xUnit + a fake
> `HttpMessageHandler`; run `dotnet test` locally to confirm green. The 307
> test proves the bearer is re-attached across the relay hop.

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
| `--order` | `asc` or `desc` (default `desc`) |
| `--limit` | Max records (default 50) |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--debug` | Print the built event query string |
| `--list-event-types` | List the event types this site reports, then exit (skips reading the log) |

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials, wrong site id, or no access. | Re-check all three; add `--mfa-code` for 2FA. |
| `The site rejected the token` | Token not scoped to this site. | Confirm `--site-id`; scope must be `cloudSystemId=<that id>`. |
| `No events in this time range` | Nothing happened in the window. | Widen `--since`, raise `--limit`, or drop `--event-type`. |
| `Could not reach https://<id>.relay.vmsproxy.com` | Site offline / not cloud-connected. | Confirm the site is online and cloud-connected. |
| TLS / certificate error | Relay/site TLS trust. | Lab only: add `--insecure`. |

## Files

| File | Purpose |
|------|---------|
| `src/NxCloudEventLogClient.cs` | The API logic (login, event log, manifest, 307 follow, parsing). |
| `src/Config.cs` | `.env` reader, arg parser, CLI>env>.env precedence, time-window helpers. |
| `src/Program.cs` | CLI wiring (`Main`); builds the no-auto-redirect HttpClient. |
| `tests/NxCloudEventLogClientTests.cs` | Offline xUnit tests (fake `HttpMessageHandler`). |
