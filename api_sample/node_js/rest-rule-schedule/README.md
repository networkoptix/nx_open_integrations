# rest-rule-schedule (Node.js)

Set the **schedule** of an Nx event rule — the **v4 modernization** of Network
Optix's [`setup_rule_schedule.py`](https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/setup_rule_schedule.py).

Latest **`/rest/v4`** API. Node.js, ESM (`.mjs`), built-in `fetch` (Node 18+) and
`node:test` — zero third-party dependencies.

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
# 1. List every rule: id, enabled, comment, schedule summary
node rest_rule_schedule.mjs --mode direct --server-host https://192.168.1.10:7001 \
  --user admin --password 'secret' --list --insecure

# 2. Set ONE rule's schedule to a preset (PATCH)
node rest_rule_schedule.mjs --mode cloud --site-id {site-id} \
  --user me@example.com --password 'secret' \
  --rule-id {rule-id} --preset weekdays --start 9 --end 18
```

### Presets (`--preset`)

| Preset | Schedule |
|---|---|
| `always` | empty array — rule is always enabled |
| `24x7` | all 7 days, full day |
| `weekdays` | Mon–Fri, `--start`..`--end` hours (default 9–18) |
| `weekend` | Sat–Sun, `--start`..`--end` hours (default 9–18) |

`--start`/`--end` are whole hours in `0..24` with `start < end` (ignored for
`always`/`24x7`).

## How a preset becomes the v4 schedule

A v4 `schedule` is an **array of task objects** — no bit-twiddling:

```js
{ dayOfWeek, startTime, endTime }
```

- `dayOfWeek` — `1`=Mon … `7`=Sun.
- `startTime` / `endTime` — **seconds since midnight**, `0..86400`.
- An **empty array `[]`** means **"always enabled"**.

The legacy `setup_rule_schedule.py` packed this into a **hex bitstream** at
1-hour resolution that you had to serialize/deserialize by hand. v4 replaces it
with the structured array, so a preset maps to it directly:

| Preset | Days (`dayOfWeek`) | Times |
|---|---|---|
| `always` | — | `[]` (always enabled) |
| `24x7` | `1..7` | `0 .. 86400` |
| `weekdays` | `1..5` | `start*3600 .. end*3600` |
| `weekend` | `6..7` | `start*3600 .. end*3600` |

**Hours → seconds** is just `hour * 3600`: `9 → 32400`, `18 → 64800`. So
`--preset weekdays --start 9 --end 18` produces five tasks, one per weekday:

```json
"schedule": [
  { "dayOfWeek": 1, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 2, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 3, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 4, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 5, "startTime": 32400, "endTime": 64800 }
]
```

This is exactly what `buildSchedule()` returns and what gets `PATCH`ed as the
`{ schedule }` body to `PATCH /rest/v4/events/rules/{id}`.

## Auth modes

| `--mode` | How you connect | Env vars |
|---|---|---|
| `direct` (default) | Local login to one VMS server | `NX_SERVER_HOST`, `NX_SERVER_USER`, `NX_SERVER_PASSWORD` |
| `cloud` | Cloud account over the relay (token scoped with `cloudSystemId`, relay 307 followed manually with the bearer re-attached — and PATCH keeps its method + body across the 307) | `NX_CLOUD_HOST` (default `https://nxvms.com`), `NX_CLOUD_USER`, `NX_CLOUD_PASSWORD`, `NX_CLOUD_SITE_ID` |

Config precedence is **CLI flag > env var > `.env`**; credentials are never
hard-coded. The dotenv flag is **`--dotenv`** (not `--env-file`, which Node
reserves).

## Test

```bash
node --test test_rest_rule_schedule.mjs
```

Offline tests (HTTP mocked — no account/network): schedule building for every
preset, the rules table, arg
parsing, mode-aware config, both login flows, `listRules` (envelope + auth),
`patchSchedule` (PATCH body, empty-200 success, **relay 307 preserving method +
body + bearer**), and logout.

## Notes

- `PATCH` sends only `{ schedule }`; the rest of the rule is untouched (that's the
  point of PATCH vs the legacy whole-rule save).
- No `If-Match`/etag is required by the v4 PATCH, so the sample doesn't send one.
