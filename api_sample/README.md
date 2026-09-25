# Nx API Samples

A growing collection of **runnable sample code** for the Network Optix APIs.
Each sample lives in its own self-contained folder and follows the same shape,
so you can compare one language (or one API) against another at a glance.

Samples exist in **Python**, **Node.js**, and **TypeScript** with matching
behavior and matching offline tests, plus **browser** (front-end JavaScript) and
**C#** (.NET 10) samples. All REST samples target the **latest `/rest/v4`** API.

> **Auth policy:** every sample uses **bearer-token authentication only**.
> HTTP Basic auth is intentionally not used anywhere.

---

## 1. Find your sample

Pick the row that matches what you're trying to do, then open the folder for
your language. Most samples have Python, Node.js, **and** TypeScript versions;
many also have a **browser** or **C#** version. A dash (—) in a column means
that language has no version of that sample.

| I want to… | Sample | Python | Node.js | TypeScript | Browser | C# | Auth |
|---|---|---|---|---|---|---|---|
| Get a bearer token from a **mediaserver** (smallest server-auth example) | **rest-get-token** | [py](python/rest-get-token) | [node](node_js/rest-get-token) | [ts](typescript/rest-get-token) | [web](web/rest-get-token-browser) | [c#](csharp/rest-get-token) | Server bearer (v4) |
| Just get a bearer token (smallest auth example) | **cdb-get-token** | [py](python/cdb-get-token) | [node](node_js/cdb-get-token) | [ts](typescript/cdb-get-token) | [web](web/cdb-get-token-browser) | [c#](csharp/cdb-get-token) | OAuth2 bearer |
| Reuse a login without re-sending the password | **cdb-refresh-token** | [py](python/cdb-refresh-token) | [node](node_js/cdb-refresh-token) | [ts](typescript/cdb-refresh-token) | [web](web/cdb-refresh-token-browser) | [c#](csharp/cdb-refresh-token) | OAuth2 refresh |
| Confirm my cloud login + see my Sites | **cdb-oauth2-list-systems** | [py](python/cdb-oauth2-list-systems) | [node](node_js/cdb-oauth2-list-systems) | [ts](typescript/cdb-oauth2-list-systems) | [web](web/cdb-oauth2-list-systems-browser) | [c#](csharp/cdb-oauth2-list-systems) | OAuth2 bearer |
| List cameras on a site I have a **local** account on | **rest-list-cameras** | [py](python/rest-list-cameras) | [node](node_js/rest-list-cameras) | [ts](typescript/rest-list-cameras) | [web](web/rest-list-cameras-local-browser) | [c#](csharp/rest-list-cameras) | Server bearer (v4) |
| List cameras on a site using my **cloud** account | **rest-list-cameras-cloud-user** | [py](python/rest-list-cameras-cloud-user) | [node](node_js/rest-list-cameras-cloud-user) | [ts](typescript/rest-list-cameras-cloud-user) | [web](web/rest-list-cameras-browser) | [c#](csharp/rest-list-cameras-cloud-user) | Cloud token scoped by `cloudSystemId` (v4, via relay) |
| Read a site's **event log** | **rest-event-log** | [py](python/rest-event-log) | [node](node_js/rest-event-log) | [ts](typescript/rest-event-log) | [web](web/rest-event-log-browser) | [c#](csharp/rest-event-log) | Cloud scoped token (v4, via relay) |
| Play a camera's **live video** in the browser | **webrtc-live-view** | — | — | — | [web](web/webrtc-live-view) | — | Cloud scoped token + WebRTC (via relay) |
| Pull a camera's **HTTP media stream** (live or archive) — CLIs save a clip to a file, the browser plays it in `<video>` | **media-http-stream** | [py](python/media-http-stream) | [node](node_js/media-http-stream) | [ts](typescript/media-http-stream) | [web](web/media-http-stream) | [c#](csharp/media-http-stream) | Server **or** cloud bearer (v4, `media.{format}`) |
| Set an event rule's **schedule** (`GET` rules + `PATCH` one) | **rest-rule-schedule** | [py](python/rest-rule-schedule) | [node](node_js/rest-rule-schedule) | [ts](typescript/rest-rule-schedule) | [web](web/rest-rule-schedule-browser) | [c#](csharp/rest-rule-schedule) | Server **or** cloud bearer (v4, `events/rules`) |
| Upload footage to a **virtual camera** | **virtual-camera-upload** | [py](python/virtual-camera-upload) | [node](node_js/virtual-camera-upload) | [ts](typescript/virtual-camera-upload) | [web](web/virtual-camera-upload-browser) | [c#](csharp/virtual-camera-upload) | Server **or** cloud bearer (v4, `devices/*/footage`) |
| Get **live-pushed** events instead of polling | **jsonrpc-subscribe-events** | — | [node](node_js/jsonrpc-subscribe-events) | — | — | — | Server bearer (v4, JSON-RPC WebSocket) |
| Log a **web app** into Nx Cloud the way a production app should — redirect-based OAuth2 | **cdb-oauth2-authorization-code-login-browser** | — | — | — | [web](web/cdb-oauth2-authorization-code-login-browser) | — | OAuth2 `authorization_code` |
| Set up a **brand-new site**: name it, set the admin password, connect it to the Cloud | **rest-configure-system-via-api** | [py](python/rest-configure-system-via-api) | — | — | — | — | Server bearer (v4) + Cloud CDB |
| Drive a **PTZ camera** — move, stop, presets, tours | **rest-operate-ptz-via-api** | [py](python/rest-operate-ptz-via-api) | — | — | — | — | Server **or** cloud bearer (v4, via relay) |
| Get **live-pushed** events instead of polling, using my **cloud** account | **jsonrpc-subscribe-events-cloud-user** | — | [node](node_js/jsonrpc-subscribe-events-cloud-user) | — | — | — | Cloud token scoped by `cloudSystemId` (v4, JSON-RPC WebSocket via relay) |

## 2. Suggested learning path

Each sample builds on the one before it. New here? Go top to bottom:

1. **cdb-get-token** — authenticate and nothing else. Understand the bearer token.
2. **cdb-oauth2-list-systems** — use that token for a real call; see your Sites.
3. **cdb-refresh-token** — keep a session alive without re-sending the password.
4. **rest-get-token** — leave the cloud: get a token from a mediaserver, use it,
   revoke it. The server-side counterpart of #1.
5. **rest-list-cameras** — the same login, now put to work: talk to one VMS
   server directly (v4).
6. **rest-list-cameras-cloud-user** — reach a site through the cloud relay with a
   **scoped** token.
7. **rest-event-log** — the most complete sample: scoped token, relay **307**
   handling, and v4 query/response parsing.
8. **jsonrpc-subscribe-events-cloud-user** — combine steps 6 and 7 with the
   live push feed from `jsonrpc-subscribe-events`: a scoped cloud token, the
   relay hand-off resolved *before* the WebSocket handshake, then the same
   subscribe/unsubscribe flow.

## 3. Catalog at a glance

| Sample | API | What it shows | Difficulty |
|---|---|---|---|
| `rest-get-token` | REST `/rest/v4` | The mediaserver login session end to end: `POST login/sessions` → use the token on `GET login/sessions/current` → `DELETE` to revoke it → show it is rejected. All five languages | ● Starter |
| `rest-get-token-browser` | REST `/rest/v4` | The same four steps in the browser, as a timeline — plus why a page needs the dev proxy at all | ●● Easy |
| `cdb-get-token` | Cloud CDB | One login call → a bearer token | ● Starter |
| `cdb-oauth2-list-systems` | Cloud CDB | Login + `GET /cdb/systems`, 2FA, token scope | ●● Easy |
| `cdb-refresh-token` | Cloud CDB | Proactive + reactive refresh, rotation, disk persistence | ●●● Intermediate |
| `rest-list-cameras` | REST `/rest/v4` | Local-user login + `GET /rest/v4/devices` + logout | ●● Easy |
| `rest-list-cameras-cloud-user` | REST `/rest/v4` | Scoped cloud token + site access via the relay | ●●● Intermediate |
| `rest-list-cameras-cloud-user` (browser) | REST `/rest/v4` | The same in the browser: CORS, a dev proxy, no manual-307 | ●●● Intermediate |
| `webrtc-live-view` (browser) | REST v4 + WebRTC | Login + list + live video via the Nx WebRTC stream manager | ●●●● Advanced |
| `rest-event-log` | REST `/rest/v4` | Scoped token, manual 307, v4 time window + record parsing | ●●●● Advanced |
| `rest-event-log-browser` | REST `/rest/v4` | The event log in the browser: same-origin proxy, v4 window + parsing | ●●● Intermediate |
| `media-http-stream` | REST `/rest/v4` | Pull `media.{format}`, both auth modes — CLIs (py/node/ts/c#) save a clip to a file, browser plays it in `<video>` | ●●●● Advanced |
| `rest-rule-schedule` | REST `/rest/v4` | `GET events/rules` + `PATCH events/rules/{id}` to set a rule's v4 structured schedule (Weekdays/Weekend/24x7 presets), both auth modes | ●●●● Advanced |
| `virtual-camera-upload` | REST `/rest/v4` | Create a virtual camera and upload footage to it, both auth modes | ●●●● Advanced |
| `jsonrpc-subscribe-events` | JSON-RPC (WebSocket) | Authenticate a WebSocket with `setSession`, subscribe to the live event log, receive pushed `update` notifications | ●●● Intermediate |
| `cdb-oauth2-authorization-code-login-browser` | Cloud CDB | The real redirect-based OAuth2 `authorization_code` grant — the flow a production web app should use — then list Sites and drill into one Site's servers and cameras. Talks to the cloud directly, so unlike the other browser samples it needs **no dev proxy** | ●●●● Advanced |
| `rest-configure-system-via-api` | REST `/rest/v4` + Cloud CDB | First-time site setup end to end: `site/setup`, admin password, cloud bind (personal **or** organization), and the default toggles. Python only, and the only multi-module sample | ●●●● Advanced |
| `rest-operate-ptz-via-api` | REST `/rest/v4` | Read a camera's PTZ capabilities, then move / stop / abs-move it and drive presets and tours. Both auth modes, manual relay 307. Python only | ●●●● Advanced |
| `jsonrpc-subscribe-events-cloud-user` | JSON-RPC (WebSocket) | Same as above but using scoped cloud token, and cloud relay. | ●●●● Advanced |

---

## 4. Two decision guides

**Cloud account or local account?**
The **Cloud CDB** knows about your account and the **Sites** registered to it —
it does *not* list individual cameras. To list cameras you talk to a **Site**
(a VMS site) through the **REST API**. Use a `cdb-*` sample to authenticate and
discover Sites; use a `rest-*` sample to act on one Site.

**Which token scope?** When you log in with OAuth2 (`POST /cdb/oauth2/token`),
the `scope` you request decides the token's reach:

- **No scope** → a cloud-wide (cdb) token. Good for account-level calls like
  listing Sites. It is **not** accepted by an individual site.
- **`scope=cloudSystemId=<id>`** → a token scoped to one site, required to call
  that site's API (its cameras, its event log, …).

`cdb-oauth2-list-systems` uses the no-scope token; `rest-list-cameras-cloud-user`,
`rest-event-log`, and `jsonrpc-subscribe-events-cloud-user` use the scoped token.

## 5. The Nx APIs

| API | What it is | Reference |
|-----|------------|-----------|
| **Cloud CDB API** | The cloud database: accounts and the **Sites** registered to them. | https://nxvms.com/cdb/docs/api/v1/swagger/index.html |
| **REST Server API (v4)** | A single VMS server/site: devices (cameras), media, events. | https://meta.nxvms.com/doc/developers/api-tool/main?type=1 |
| **WebRTC Stream Manager** | Browser-side live video streaming (npm package). | https://www.npmjs.com/package/@networkoptix/webrtc-stream-manager |
| **JSON-RPC (`/jsonrpc`)** | Every `rest.v4.*` REST method, callable as JSON-RPC 2.0 over HTTP (one-shot) or WebSocket (adds live `subscribe`/`unsubscribe` push notifications). | Same reference as REST Server API — see the "JSON-RPC" section |

## 6. Getting started

```bash
# 1. Copy the shared config template and fill it in.
cp .env.example .env

# 2a. Python: open a folder and follow its README.
cd python/cdb-get-token
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python cdb_get_token.py --env-file ../../.env
pytest -v                              # offline, no account needed

# 2b. Node.js (18+): no dependencies to install.
cd node_js/cdb-get-token
node cdb_get_token.mjs --dotenv ../../.env
node --test                            # offline, no account needed
```

> **Node flag note:** Node samples use `--dotenv` (not `--env-file`). Node 20.6+
> reserves `--env-file` as a built-in that aborts the process if the file is
> missing, before the sample's code runs. See any Node README for the details.

## 7. Conventions every sample follows

- **One obvious path** through the code, with plain-English comments on each step.
- **Offline tests** (HTTP is mocked) — `pytest` / `node --test` go green with no
  account and no network.
- Config is read **flexibly**: CLI flags override environment variables, which
  override a `.env` file.
- Credentials are **never** hard-coded.
- Clear error messages for the common failures (bad password, wrong host, TLS).

## 8. Layout

```
api_sample/
  README.md                          <- you are here
  .env.example                       <- shared config template (copy to .env)
  .gitignore
  python/<sample>/     *.py  test_*.py  requirements.txt  README.md
  node_js/<sample>/    *.mjs test_*.mjs package.json      README.md
  typescript/          nx-types.ts tsconfig.json package.json
  typescript/<sample>/ *.ts  test_*.ts  README.md
  web/<sample>/        index.html app.mjs nx-cloud-client.mjs proxy.mjs server.mjs test_*.mjs README.md
  csharp/<sample>/     src/*.cs *.csproj   tests/*.cs *.csproj   README.md
```

See [`python/`](python), [`node_js/`](node_js), [`typescript/`](typescript),
[`web/`](web), and [`csharp/`](csharp) for the per-language indexes.

> **Browser note:** front-end samples can't freely call the cloud/relay — the
> browser enforces **CORS**. Each `web/` sample ships a tiny zero-dependency dev
> **proxy** so the demo runs same-origin; see its README.

## 9. Other demos in this repo

Two folders sit outside the `<api>-<verb>-<object>` sample catalog above
because they cover different surfaces entirely:

- [`javascript/js_api_examples/`](javascript/js_api_examples) — demos for the
  **Nx Desktop Client's embedded-browser JavaScript API** (client-side
  scripting inside the Witness Desktop Client's built-in browser). This is a
  different API from the REST/Cloud CDB APIs covered everywhere else in this
  repo. See its README for details.
- [`web/2-way_audio_api/`](web/2-way_audio_api) — a standalone browser demo of
  2-way audio playback/capture against a camera.
