# REST API — Set an event rule's schedule (C#)

Set the **schedule** of an Nx event rule — the **v4 modernization** of Network
Optix's [`setup_rule_schedule.py`](https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/setup_rule_schedule.py).
A C# port of [`../../typescript/rest-rule-schedule`](../../typescript/rest-rule-schedule),
on the latest **`/rest/v4`** API. Built-in `HttpClient` + `System.Text.Json` —
no third-party packages.

## What changed from the original example

The legacy example used the transactional `/ec2/getEventRules` +
`/ec2/saveEventRule` API, where a rule's schedule was a packed **hex bitstream**
(1-hour resolution) you had to serialize/deserialize by hand. The v4 API replaces
all of that:

| | Legacy (`/ec2`) | v4 (`/rest/v4`) |
|---|---|---|
| List rules | `GET /ec2/getEventRules` | `GET /rest/v4/events/rules` |
| Modify a rule | `POST /ec2/saveEventRule` (whole rule) | `PATCH /rest/v4/events/rules/{id}` (partial) |
| Schedule shape | hex bitstream string | **structured array** |

In v4 the schedule is a plain array — no bit-twiddling:

```json
"schedule": [
  { "dayOfWeek": 1, "startTime": 32400, "endTime": 64800 }
]
```

`dayOfWeek` is `1`=Mon … `7`=Sun; `startTime`/`endTime` are **seconds since
00:00**. An **empty array means "always enabled"**.

## What it does (pick one action)

```bash
cd src

# 1. List every rule: id, enabled, comment, schedule summary
dotnet run -- --mode direct --server-host https://192.168.1.10:7001 \
  --user admin --password 'secret' --list --insecure

# 2. Set ONE rule's schedule to a preset (PATCH)
dotnet run -- --mode cloud --site-id {site-id} \
  --user me@example.com --password 'secret' \
  --rule-id {rule-id} --preset weekdays --start 9 --end 18
```

### Presets (`--preset`)

| Preset | Schedule |
|---|---|
| `always` | empty array — rule is always enabled |
| `24x7` | all 7 days, full day |
| `weekdays` | Mon-Fri, `--start`..`--end` hours (default 9-18) |
| `weekend` | Sat-Sun, `--start`..`--end` hours (default 9-18) |

`--start`/`--end` are whole hours in `0..24` with `start < end` (ignored for
`always`/`24x7`).

## How a preset becomes the v4 schedule

A `--preset` is just a friendly name; `Config.BuildSchedule()` turns it into the
exact v4 `schedule` array that gets PATCHed. The v4 `schedule` is an array of
`ScheduleTask` records — `{ dayOfWeek, startTime, endTime }`:

- `dayOfWeek`: `1`=Mon … `7`=Sun.
- `startTime` / `endTime`: **seconds since midnight**, `0..86400`.
- An **empty array `[]`** means "always enabled".

The legacy `setup_rule_schedule.py` encoded this same intent as a packed **hex
bitstream** at 1-hour resolution; v4 replaces that opaque string with this
structured array, so the only conversion the sample does is hours → seconds.

**The conversion (`BuildSchedule`):**

- hours → seconds: `hour * 3600` (so `9` → `32400`, `18` → `64800`).
- `weekdays(start, end)` → one task per day `1..5`, each `start*3600 .. end*3600`.
- `weekend(start, end)` → one task per day `6..7`, same window.
- `24x7` → one task per day `1..7`, `0 .. 86400` (whole day).
- `always` → `[]` (the empty array).

**Concrete example.** `--preset weekdays --start 9 --end 18` produces five tasks
(days `1..5`, `32400 .. 64800`) — exactly what `BuildSchedule()` returns and what
gets PATCHed as the `{ "schedule": [...] }` body:

```json
"schedule": [
  { "dayOfWeek": 1, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 2, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 3, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 4, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 5, "startTime": 32400, "endTime": 64800 }
]
```

## Two auth modes

Same two modes as the web/TypeScript sample:

| `--mode` | What it does | Vars |
|---|---|---|
| `direct` *(default)* | Local login to ONE server with a **local** server account. | `NX_SERVER_HOST` / `NX_SERVER_USER` / `NX_SERVER_PASSWORD` |
| `cloud` | Reach the site over the **Cloud relay** with a cloud account; the token is scoped with `cloudSystemId`, the relay 307 is followed manually with the bearer re-attached — and the PATCH keeps its method + body across the 307. | `NX_CLOUD_HOST` / `NX_CLOUD_USER` / `NX_CLOUD_PASSWORD` / `NX_CLOUD_SITE_ID` |

Config precedence is **CLI flag > env var > `.env`**; credentials are never
hard-coded.

## Flow walkthrough

The whole flow lives in **`src/NxRuleClient.cs`** (`Program.cs` is just CLI
wiring; the schedule helpers live in `src/Config.cs`). The interesting parts:

**1 — `LoginAsync()`: two flows, one method.** Direct posts to
`{server}/rest/v4/login/sessions` for a `token`; cloud posts to
`{cloud}/cdb/oauth2/token` with `scope=cloudSystemId=<id>` for an `access_token`.

**2 — `ListRulesAsync()` / `PatchScheduleAsync()`.** `GET /rest/v4/events/rules`
(unwrapping a `{ "reply": [...] }` envelope if present) and
`PATCH /rest/v4/events/rules/{id}` with only `{ "schedule": [...] }`. An empty
`200` body is treated as success.

**3 — The relay 307.** `SendFollowingRedirectsAsync` follows the relay's 307 by
hand: .NET (like browsers) drops the `Authorization` header across a cross-host
redirect, so the client sets `AllowAutoRedirect = false` and **re-attaches the
bearer on each hop** (max 5). A 307 also preserves the **method + body**, so the
helper rebuilds a fresh `HttpRequestMessage` per hop and re-wraps the JSON body in
a new `StringContent` (a `StringContent` cannot be reused across requests) —
critical for the PATCH.

**4 — `LogoutAsync()`: revoke the token (best-effort).** `DELETE` the server
session (direct) or the cloud token (cloud).

The token is always sent as an `Authorization: Bearer` header — **never** in the
URL.

## Project layout

```
rest-rule-schedule/
  src/    NxRuleClient.cs  Config.cs  Program.cs  NxRuleSchedule.csproj
  tests/  NxRuleClientTests.cs  NxRuleSchedule.Tests.csproj
```

## Prerequisites

- **.NET SDK 10.0+**
- Either a local server account (direct) or a cloud account with the target
  site's **Cloud Site ID** (a UUID).

## Run

```bash
cd src

# Direct to a server (local account):
dotnet run -- \
  --mode direct \
  --server-host https://192.168.1.10:7001 \
  --user admin --password 'your-password' \
  --list --insecure

# Through the Cloud relay (cloud account), set one rule:
dotnet run -- \
  --mode cloud \
  --cloud-host https://nxvms.com \
  --user you@example.com --password 'your-password' \
  --site-id 1111....-5555 \
  --rule-id {rule-id} --preset weekdays --start 9 --end 18
```

Add `--mfa-code 123456` if your cloud account has 2FA.

## Run the tests

```bash
cd tests
dotnet test
```

> Note: these tests were written but **not executed in the authoring
> environment** (no .NET SDK there). They use standard xUnit + a fake
> `HttpMessageHandler`; run `dotnet test` locally to confirm green. The 307 test
> proves the bearer is re-attached **and the PATCH method + body survive** the
> relay hop.

## CLI flags

| Flag | Purpose |
|------|---------|
| `--mode` | `direct` (default) or `cloud` |
| `--server-host` | Server, e.g. `https://192.168.1.10:7001` (direct mode) |
| `--cloud-host` | Cloud host, e.g. `https://nxvms.com` (cloud mode) |
| `--user` / `--password` | Credentials (server account for direct, cloud account for cloud) |
| `--site-id` | Cloud Site ID of the target site (UUID, cloud mode) |
| `--mfa-code` | One-time 2FA code (cloud mode) |
| `--list` | List every rule (id, enabled, comment, schedule) |
| `--rule-id` | The rule to PATCH (with `--preset`) |
| `--preset` | `always`, `24x7`, `weekdays`, or `weekend` |
| `--start` / `--end` | Whole-hour window for `weekdays`/`weekend` (default 9..18) |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |

Exactly **one** action is required: `--list`, or
`--rule-id <id> --preset <preset>`.

Config precedence: **CLI > env var > `.env`** (`NX_MODE`, `NX_SERVER_HOST` /
`NX_SERVER_USER` / `NX_SERVER_PASSWORD`, `NX_CLOUD_HOST` / `NX_CLOUD_USER` /
`NX_CLOUD_PASSWORD` / `NX_CLOUD_SITE_ID`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials or wrong account type. | Direct needs a LOCAL server account; cloud needs `--mode cloud` + `--mfa-code` for 2FA. |
| `... unauthorized (HTTP 401/403)` | Cloud token not scoped to this site. | Confirm `--site-id`; the scope must be `cloudSystemId=<that id>`. |
| `Unknown --preset` | Typo in `--preset`. | Use `always`, `24x7`, `weekdays`, or `weekend`. |
| `Invalid hours` | `--start`/`--end` out of range. | Use whole hours with `0 <= start < end <= 24`. |
| TLS / certificate error | Self-signed lab server. | Lab only: add `--insecure`. |

## Notes

- `PATCH` sends only `{ schedule }`; the rest of the rule is untouched (that's the
  point of PATCH vs the legacy whole-rule save).
- No `If-Match`/etag is required by the v4 PATCH, so the sample doesn't send one.

## Files

| File | Purpose |
|------|---------|
| `src/NxRuleClient.cs` | API logic (login both modes, list rules, PATCH schedule, 307 follow preserving method+body, logout). |
| `src/Config.cs` | `.env` reader, arg parser, schedule helpers (presets, summary), CLI>env>.env precedence. |
| `src/Program.cs` | CLI wiring (`Main`); enforces one action and builds the no-auto-redirect HttpClient. |
| `tests/NxRuleClientTests.cs` | Offline xUnit tests (fake `HttpMessageHandler`). |
