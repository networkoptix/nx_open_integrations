# rest-rule-schedule (Python)

Set the **schedule** of an Nx event rule — the **v4 modernization** of Network
Optix's [`setup_rule_schedule.py`](https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/setup_rule_schedule.py).

Latest **`/rest/v4`** API. Uses `requests`; HTTP-mocked offline tests.

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
python3 rest_rule_schedule.py --mode direct --server-host https://192.168.1.10:7001 \
  --user admin --password 'secret' --list --insecure

# 2. Set ONE rule's schedule to a preset (PATCH)
python3 rest_rule_schedule.py --mode cloud --site-id {site-id} \
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

This is the heart of the sample: turning a human-readable preset like
"weekdays 9–18" into the exact array the v4 API expects.

A v4 rule `schedule` is an array of task objects:

```json
{ "dayOfWeek": 1, "startTime": 32400, "endTime": 64800 }
```

- `dayOfWeek` — `1`=Mon … `7`=Sun.
- `startTime` / `endTime` — **seconds since midnight**, in `0..86400`
  (`86400` = 24 × 3600 = end of day).
- An **empty array `[]`** means **"always enabled"** — no tasks, no windows.

The legacy [`setup_rule_schedule.py`](https://github.com/networkoptix/nx_open_integrations/blob/master/python/examples/setup_rule_schedule.py)
packed this same information as a **hex bitstream** at 1-hour resolution — you
flipped bits per hour-per-day and serialized the string by hand. v4 replaces
that with this structured array: no bit-twiddling, just objects.

### The conversion

Hours become seconds with a single multiply — `hour * 3600`:

| Hour | Seconds (`hour * 3600`) |
|---|---|
| `0` | `0` |
| `9` | `32400` |
| `18` | `64800` |
| `24` | `86400` |

Each preset maps to **one task per day**:

| Preset | Days (`dayOfWeek`) | Window |
|---|---|---|
| `weekdays` | `1..5` (Mon–Fri) | `start*3600` .. `end*3600` |
| `weekend` | `6..7` (Sat–Sun) | `start*3600` .. `end*3600` |
| `24x7` | `1..7` (all days) | `0` .. `86400` |
| `always` | — | `[]` (empty array) |

### Concrete example: `--preset weekdays --start 9 --end 18`

Five tasks (one per weekday), each `09:00`→`18:00` as seconds
(`9 * 3600 = 32400`, `18 * 3600 = 64800`):

```json
"schedule": [
  { "dayOfWeek": 1, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 2, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 3, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 4, "startTime": 32400, "endTime": 64800 },
  { "dayOfWeek": 5, "startTime": 32400, "endTime": 64800 }
]
```

This is exactly what `build_schedule("weekdays", 9, 18)` returns, and exactly
what gets PATCHed to the rule's `schedule` field.

## Auth modes

| `--mode` | How you connect | Env vars |
|---|---|---|
| `direct` (default) | Local login to one VMS server | `NX_SERVER_HOST`, `NX_SERVER_USER`, `NX_SERVER_PASSWORD` |
| `cloud` | Cloud account over the relay (token scoped with `cloudSystemId`, relay 307 followed manually with the bearer re-attached — and PATCH keeps its method + body across the 307) | `NX_CLOUD_HOST` (default `https://nxvms.com`), `NX_CLOUD_USER`, `NX_CLOUD_PASSWORD`, `NX_CLOUD_SITE_ID` |

Config precedence is **CLI flag > env var > `.env`**; credentials are never
hard-coded. Point at a different dotenv file with `--env-file`.

## Install & run

```bash
pip install -r requirements.txt
python3 rest_rule_schedule.py --help
```

## Test

```bash
pytest -q
```

Offline tests (HTTP mocked — no account/network): schedule building for every
preset (+ bad-hours rejection), `normalize_preset`, `summarize_schedule`, the
rules table, arg parsing, mode-aware
config, both login flows, `list_rules` (envelope + auth), `patch_schedule`
(PATCH body, empty-200 success, **relay 307 preserving method + body + bearer**,
too-many-redirects), and logout in both modes.

## Notes

- `PATCH` sends only `{ "schedule": [...] }`; the rest of the rule is untouched
  (that's the point of PATCH vs the legacy whole-rule save).
- No `If-Match`/etag is required by the v4 PATCH, so the sample doesn't send one.
- The 307 is followed manually with `allow_redirects=False` because `requests`
  drops the `Authorization` header across hosts — and a 307 (unlike a 302)
  preserves the method and body, which is exactly what the PATCH needs.
