# Set an event rule's schedule in the browser

This sample lists a site's **event rules** and sets a rule's **schedule** from a
plain web page — no app, no framework, no build step. It is the browser form of
the Node/TypeScript [`rest-rule-schedule`](../../typescript/rest-rule-schedule)
sample, on the latest **`/rest/v4`** API. It supports **both** auth modes:
**Direct to Media Server** (connect to one server by IP:port with a LOCAL server
account, all entered on the page) or **Pull via Cloud Relay** (a cloud account
reaching the site over the relay).

## What it shows

- The two rule endpoints:
  - `GET /rest/v4/events/rules` — list every rule.
  - `PATCH /rest/v4/events/rules/{id}` — modify ONE rule with a partial body
    (`{ "schedule": [...] }`).
- The v4 **structured schedule** (no more legacy hex bitstream): an array of
  `{ dayOfWeek, startTime, endTime }` tasks. An **empty array means "always
  enabled"**.
- Both auth flows in one client: a direct local-server login (the server address
  and local credentials are entered on the page) and cloud OAuth2 with a
  site-scoped token.

## The schedule shape

```
schedule: [ { dayOfWeek, startTime, endTime }, ... ]
  dayOfWeek : 1=Mon .. 7=Sun
  startTime : seconds since 00:00 (0..endTime)
  endTime   : seconds since 00:00 (startTime..86400)
```

The page lets you **pick any combination of days** (Mon–Sun checkboxes) and a
**time window**, then builds the schedule client-side with
`buildScheduleFromDays(days, startHour, endHour)` — one task per chosen day.

- **Days** — tick any of Mon…Sun. Quick-fill buttons (**Weekdays**, **Weekend**,
  **Every day**, **Clear**) just set the checkboxes for you.
- **Time** — `startHour`/`endHour` are whole hours in `0..24` (`start < end`), or
  tick **All day** to use `00:00–24:00` (`0..86400`).

(An empty schedule array means "always enabled" at the API level; the picker
always produces at least one day, so use the API directly for that case.)

## Read this first: CORS (and self-signed TLS)

A browser will **block** `fetch()` to the Nx Cloud, the relay, or a local server
— they're different origins and don't return the CORS headers a browser
requires. A local server also presents a **self-signed** TLS certificate the
browser refuses outright. The browser also **cannot** follow the relay's
cross-host **307** redirect while keeping the `Authorization` header. You
**cannot** disable any of this from JavaScript; it's how browsers work. (See
[`../rest-list-cameras-browser`](../rest-list-cameras-browser) for a deeper CORS
walkthrough.)

### The solution: run the included dev server (one command)

This folder ships a tiny zero-dependency dev server, split by concern:

- **`proxy.mjs`** — the CORS forwarder only. Relays `/cloud/*`,
  `/relay/<siteId>/*`, and `/server/<encoded-base>/*` from outside the browser.
  It forwards the **method, the JSON body, and every header** (including the
  `Authorization: Bearer` the page sends) verbatim, and across the relay's **307**
  it **re-sends the same request** — so the bearer and the PATCH body survive the
  cross-host hop. For Direct mode it decodes the user-provided server base from
  the first path segment and forwards there, always tolerating the server's
  self-signed cert. No static serving — reusable by other web samples.
- **`server.mjs`** — the static file server for the demo. It mounts the proxy so
  both run on **one port** (same-origin = no CORS). **This is what you run.**

```bash
cd web/rest-rule-schedule-browser

# Both modes work with NO required flags — just run it:
node server.mjs
#   --cloud-host https://nxvms.com   (default)
#   --port 8080                      (default)

# Optional: prefill the Direct-mode "Server address" field on the page:
node server.mjs --server-host https://192.168.1.10:7001

# Then open the printed URL:
#   http://localhost:8080/
```

`GET` and `PATCH` are normal fetches that carry an `Authorization` header to the
same-origin proxy, which forwards it upstream. (The proxy still accepts an
`?auth=<token>` query param as a fallback, for parity with the other web samples,
but this client doesn't use it.)

## How your day/time choice becomes the v4 schedule

You tick the **days** and pick a **time window**;
`buildScheduleFromDays(days, startHour, endHour)` turns that into the v4
`schedule` array that gets `PATCH`ed onto each selected rule. Here's the full
conversion.

**The v4 schedule shape.** `schedule` is an array of
`{ dayOfWeek, startTime, endTime }` tasks:

- `dayOfWeek` — `1`=Mon .. `7`=Sun.
- `startTime` / `endTime` — **seconds since midnight**, `0..86400`.
- An **empty array `[]`** means **"always enabled"** (no time restriction).

**Why an array (not a hex bitstream).** The legacy `setup_rule_schedule.py`
example encoded the schedule as a **hex bitstream** at 1-hour resolution (one bit
per hour per day). v4 drops the bit-twiddling entirely and replaces it with this
structured array — easier to read, build, and diff.

**The conversion.** Your selection maps to tasks like this:

- **Hours → seconds:** `hour * 3600`. So `9` → `32400` and `18` → `64800`.
- **Each ticked day** becomes one task with that day's `dayOfWeek` and the chosen
  start/end seconds. Days are de-duplicated and sorted Mon→Sun.
- **All day** = `startHour 0`, `endHour 24` → `startTime 0`, `endTime 86400`.
- The quick-fill buttons are just shortcuts: **Weekdays** ticks days `1..5`,
  **Weekend** ticks `6..7`, **Every day** ticks `1..7`, **Clear** unticks all.

**Concrete example — days Mon–Fri ticked, start `9`, end `18`** produces five
tasks, each `09:00`–`18:00`:

```json
{
  "schedule": [
    { "dayOfWeek": 1, "startTime": 32400, "endTime": 64800 },
    { "dayOfWeek": 2, "startTime": 32400, "endTime": 64800 },
    { "dayOfWeek": 3, "startTime": 32400, "endTime": 64800 },
    { "dayOfWeek": 4, "startTime": 32400, "endTime": 64800 },
    { "dayOfWeek": 5, "startTime": 32400, "endTime": 64800 }
  ]
}
```

This is exactly what `buildScheduleFromDays([1,2,3,4,5], 9, 18)` returns, and the
`{ "schedule": [...] }` body is what gets `PATCH`ed to
`/rest/v4/events/rules/{id}` for each selected rule.

## Using the page

1. Pick an auth mode at the top; the form adapts.

   | Mode | Fields you enter |
   |------|------------------|
   | **Direct to Media Server** | **Server address** (`https://<ip>:<port>`), **local** server username, **local** server password |
   | **Pull via Cloud Relay** | **Cloud Site ID** (UUID), cloud email, cloud password (+ MFA) |

2. Click **Log in & list rules**. The page logs in and renders every rule
   (id, enabled, comment, schedule summary) with a **checkbox** per row (plus a
   header checkbox to select/clear all).
3. **Tick one or more rules.** Then pick the **days** (Mon–Sun checkboxes, or a
   quick-fill button) and the **time window** (start/end hours, or **All day**),
   and click **Set schedule on selected rules**. Each selected rule gets its own
   `PATCH /rest/v4/events/rules/{id}` call; the status line reports how many
   succeeded (and any failures).

In Direct mode the **Server address** and the username/password are the server's
own IP:port and a **local** server account — *not* a cloud account.

### The flags

| Flag | What it does |
|------|--------------|
| `--server-host https://<ip>:7001` | **Optional.** Prefills the Direct-mode **Server address** field on the page. Not required — you can type the address on the page instead. |
| `--cloud-host https://nxvms.com` | The cloud origin **cloud** mode uses (default shown). |
| `--insecure` | Lets the proxy accept a **self-signed** TLS cert for the **cloud/relay** upstreams too. The **Direct** upstream always accepts a self-signed cert without this flag, since local servers normally present one. |

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: mode toggle, adaptive login form, rules table + picker, preset/hours controls. |
| `app.mjs` | DOM wiring only — reads the form, calls the client, renders the table, PATCHes the schedule. |
| `nx-rule-client.mjs` | The API logic (`NxRuleClient`) + pure helpers (`buildSchedule`, `summarizeSchedule`, `resolveConfig`/`missingFields`, `normalizePreset`). Imported by the page **and** the tests. |
| `proxy.mjs` | The CORS forwarder (a module): `/cloud/*`, `/relay/<id>/*`, `/server/<encoded-base>/*`; method + body + bearer forwarding; the 307 re-attach hop. No static serving. |
| `server.mjs` | Dev server: serves the static demo + mounts the proxy. **This is what you run.** |
| `test_nx_rule_client.mjs` | Offline tests for the client (`node:test`, fake `fetch`). |
| `test_proxy.mjs` | Offline tests for the proxy: route dispatch, header passthrough, PATCH method+body forwarding, the 307 re-attach hop (fake upstream, no network). |
| `package.json` | `type: module`; `npm test`, `npm run serve`. No dependencies. |

## Run the tests

The API logic and the proxy's forwarding rules test offline — no browser, no
account, no network:

```bash
node --test test_nx_rule_client.mjs test_proxy.mjs   # or: npm test
```

What the tests **don't** cover: a real PATCH against a live server. The tests
verify everything *around* it — schedule building, the auth flows, listing, the
PATCH body shape, and that the proxy forwards the method + body + bearer and
re-attaches them across the relay 307 — but please verify end-to-end against your
own system.
