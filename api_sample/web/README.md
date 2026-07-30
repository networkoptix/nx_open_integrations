# Nx API Samples — Browser (front-end JavaScript)

Front-end ports of the Nx API samples: plain HTML + ES modules that run in the
browser, no framework and no build step. All REST samples target the latest
**`/rest/v4`** API.

**Zero dependencies.** Each sample uses the browser's built-in `fetch`. The API
logic is split into an importable `.mjs` module so it also runs offline under
the built-in `node:test` runner (Node 18+) — nothing to `npm install`.

## Samples

Browser versions now cover the full shared sample set, plus the web-only live-video demo.

| Folder | What it shows | API | Tests |
|---|---|---|---|
| [`cdb-get-token-browser`](cdb-get-token-browser) | Smallest auth demo: cloud login → show the bearer token, via the CORS dev proxy | Cloud CDB | 18 |
| [`cdb-oauth2-list-systems-browser`](cdb-oauth2-list-systems-browser) | Cloud login → `GET /cdb/systems` → render your Sites (table + picker) | Cloud CDB | 23 |
| [`cdb-refresh-token-browser`](cdb-refresh-token-browser) | Login + `sessionStorage` persistence + refresh without re-sending the password (see its security note) | Cloud CDB | 33 |
| [`rest-list-cameras-local-browser`](rest-list-cameras-local-browser) | Direct login to one VMS server + list its cameras (proxy forwards `/server/*`) | REST v4 | 21 |
| [`rest-list-cameras-browser`](rest-list-cameras-browser) | Cloud-user login + list a site's cameras via the relay | REST v4 | 21 |
| [`rest-event-log-browser`](rest-event-log-browser) | Cloud login + read a site's event log over `/rest/v4/events/log` (event types from the manifest) | REST v4 | 23 |
| [`webrtc-live-view`](webrtc-live-view) | Cloud login + list cameras + **live video** via `@networkoptix/webrtc-stream-manager` | REST v4 + WebRTC | 31 |
| [`media-http-stream`](media-http-stream) | Direct **or** cloud login → play live/archive **video** in an HTML5 `<video>` over `media.webm` (proxy converts the `?auth` token to a bearer header and streams the body) | REST v4 | 35 |
| [`rest-rule-schedule-browser`](rest-rule-schedule-browser) | Direct **or** cloud login → list event rules, multi-select with checkboxes, pick any **days + time window**, and `PATCH` the v4 schedule onto every selected rule; proxy forwards the PATCH method/body/bearer across the relay 307 | REST v4 | 52 |
| [`virtual-camera-upload-browser`](virtual-camera-upload-browser) | Direct **or** cloud login → create a virtual camera and upload footage to it from the browser | REST v4 | 25 |

## Other browser demos (outside the shared catalog)

- [`2-way_audio_api`](2-way_audio_api) — a standalone HTML demo of 2-way audio
  (mic → camera, camera → browser) over a raw WebSocket/HTTP media endpoint. It
  predates the `proxy.mjs`/`server.mjs`/`nx-*-client.mjs` pattern above and talks
  directly to a VMS server rather than through the shared sample catalog; see
  its own README for the request formats.

## The browser reality: CORS

Unlike Node or Python, browser JavaScript cannot freely call the Nx Cloud or a
site relay — the browser **blocks cross-origin responses** that don't carry CORS
headers, and the public cloud/relay don't send them for arbitrary web origins.
Each browser sample therefore ships a tiny **zero-dependency dev server** in two
files: `proxy.mjs` (the CORS forwarder, which relays API calls **same-origin**
and does the relay's 307 + bearer re-attach hop a browser can't) and
`server.mjs` (serves the static demo and mounts the proxy on one port). See the
sample's README for the one-command run and the production alternatives
(same-origin backend / reverse proxy, or `@networkoptix/webrtc-stream-manager`
for live video).

## Run a sample

```bash
cd rest-list-cameras-browser
node server.mjs                         # serves demo + proxies the API (no config)
# open the printed http://localhost:8080/ and enter Site ID + email + password

node --test test_nx_cloud_client.mjs test_proxy.mjs   # offline; or: npm test
```

## Conventions (shared across all browser samples)

- **Plain ES modules** (`.mjs`), loaded with `<script type="module">`. No bundler.
- **DOM wiring is separate from API logic.** `app.mjs` only touches the DOM;
  `nx-cloud-client.mjs` holds the API logic and is unit-tested offline.
- **The proxy is separate from the demo server.** `proxy.mjs` is a reusable CORS
  forwarder (a module); `server.mjs` serves the static files and mounts it.
- Core functions take an injectable `fetchImpl` (defaults to global `fetch`) so
  tests run with a fake fetch — same pattern as the Node samples.
- Credentials come from the on-page form and are never stored — the one
  exception is `cdb-refresh-token-browser`, which deliberately keeps tokens in
  `sessionStorage` to demonstrate the refresh flow (it carries a security note).
- Cloud-only samples (the `cdb-*` ones) ship a trimmed proxy with just the
  `/cloud/*` route — no relay or 307 hop, since there's no site call.
