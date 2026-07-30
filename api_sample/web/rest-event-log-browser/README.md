# Read a site's event log in the browser

This sample logs in to Nx Cloud and shows a table of a site's recent **events**
(motion detected, camera disconnected, analytics matches, rule actions, …) read
from the v4 event-log API — all in a plain web page. If you just want to run it,
jump to [Quick start](#quick-start).

It's the browser sibling of [`../../node_js/rest-event-log`](../../node_js/rest-event-log)
and [`../../python/rest-event-log`](../../python/rest-event-log), and it reuses
the same login + dev-proxy approach as
[`../rest-list-cameras-browser`](../rest-list-cameras-browser).

---

## What you'll see

A login box with a time-window picker. After you submit, you get a table of
events — **Time, Event, Action, Resource** — for the window you chose (last
hour, day, week, …), newest first.

---

## The flow

```
1. POST {cloud}/cdb/oauth2/token   (scope=cloudSystemId=<siteId>)   -> site-scoped token
2. GET  <relay>/rest/v4/events/log?startTimeMs=<ms>&durationMs=<ms>[&eventType=...&limit=...]
        (Authorization: Bearer <token>)
```

A few things worth knowing about the v4 event-log API:

- The time window is **`startTimeMs` + `durationMs`** in **milliseconds** — a
  start time plus a length, not a from/to pair. This sample turns "last 24
  hours" into `startTimeMs = now − 24h` and `durationMs = 24h`.
- `eventType` and `actionType` are **lists** — you can pass them more than once
  to filter to several types. The form exposes a single optional event-type box.
- Each record looks like
  `{ timestampMs, eventData{…}, actionData{…}, aggregatedInfo{…}, ruleId, flags }`.
  The interesting fields live inside the free-form `eventData` / `actionData`
  maps (keyed by manifest field names), so the code flattens each record into
  the four columns the table shows.

## Why a proxy? (CORS)

A browser blocks a web page from calling Nx Cloud and the relay directly — a
security rule called **CORS**. So this sample ships a tiny local dev server
(`server.mjs`, which mounts `proxy.mjs`) that serves the page and forwards the
two HTTP calls from outside the browser, where CORS doesn't apply. The proxy
also follows the relay's 307 redirect and re-attaches the bearer token — the
fiddly hop a browser can't do — so the page just makes ordinary same-origin
calls. See the [`rest-list-cameras-browser`](../rest-list-cameras-browser)
README for the full CORS walkthrough.

---

## Quick start

You need **Node.js 18+**. Nothing to install.

```bash
cd web/rest-event-log-browser

# 1. Start the local server (serves the page AND proxies the HTTP calls).
node server.mjs
#    --cloud-host https://nxvms.com   (default)
#    --insecure                       (local / self-signed site)

# 2. Open the printed URL, e.g. http://localhost:8080/
```

In the page:

1. Enter your **Cloud Site ID** (UUID), **cloud email**, and **password** (and
   an **MFA code** only if your account uses 2FA).
2. Pick a **time window** and a **max events** count.
3. Click **Load events**.

**Filtering by event type:** you don't have to know the type strings. After you
submit once (which logs you in), the sample fetches your site's **event-type
manifest** from `GET /rest/v4/events/manifest/events` and fills the **Event type
filter** drop-down with every type your site supports — each shown by its
friendly `displayName`, with the real `id` (e.g. `cameraDisconnectedEvent`) as
the value sent to the API. Click the field to pick one, or start typing to
match. Leaving it blank means "all event types."

The manifest is the authoritative source; the type strings seen in actual
results are merged in too, so the list only grows.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: login + filters + the events table. |
| `app.mjs` | DOM wiring only — reads the form, calls the client, renders rows. |
| `nx-eventlog-client.mjs` | The API logic (`NxEventLogClient`) + pure helpers (time/parsing). Imported by the page **and** the tests. |
| `proxy.mjs` | The CORS forwarder (`/cloud/*`, `/relay/<siteId>/*`). No static serving. |
| `server.mjs` | Dev server: serves the page + mounts the proxy. **Run this.** |
| `test_nx_eventlog_client.mjs` | Offline tests for the client + helpers (fake `fetch`). |
| `test_proxy.mjs` | Offline tests for the proxy's route dispatch. |
| `package.json` | `type: module`; `npm test`, `npm run serve`. No dependencies. |

## Run the tests

```bash
node --test test_nx_eventlog_client.mjs test_proxy.mjs   # or: npm test
```

The tests run with no account and no network: the time/parsing helpers are pure
functions, and the client is exercised with a fake `fetch`. They confirm the
right URL, query params, bearer header, and record-flattening — what they
**don't** cover is real events from a live site, which needs your own system.

## Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| *"blocked by CORS policy"*, or nothing happens | Server isn't running, or you opened `index.html` directly. Run `node server.mjs` and open the printed URL. |
| **Login fails (HTTP 401)** | Wrong email/password. Confirm you can log in at nxvms.com; 2FA accounts need the MFA code. |
| **"No events in this time range"** | The site genuinely had no events in that window. Widen the window, raise *Max events*, or clear the event-type filter. |
| **Site rejected the token** | Wrong Site ID, or your account has no access to that site. |
| Local / self-signed site | Start the server with `--insecure`. |

## Going further

- Filter by **action type** as well (`actionData.actionType`) — the client's
  `buildEventParams` already accepts an `actionType` list.
- Show more columns by reading other keys out of `eventData` (the raw response
  is kept on `client.lastRaw` for inspection).
- Use an exact window instead of "last N" by passing your own `startTimeMs` /
  `durationMs` to `getEventLog()`.
