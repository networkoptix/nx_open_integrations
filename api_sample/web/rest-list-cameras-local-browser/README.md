# REST API — List cameras, local server, in the browser

Front-end (browser) counterpart of
[`../../node_js/rest-list-cameras`](../../node_js/rest-list-cameras)
and [`../../python/rest-list-cameras`](../../python/rest-list-cameras),
on the latest **`/rest/v4`** API. A plain HTML page logs in to **one Nx VMS
server** and lists that site's cameras — no framework, no build step, no
dependencies.

This is the **DIRECT** variant: the page talks to a single configured server,
not the cloud. (For the cloud-account flow, see
[`../rest-list-cameras-browser`](../rest-list-cameras-browser).)

## The flow (same as the Node/Python samples)

```
1. POST   {server}/rest/v4/login/sessions  {username, password, setCookie:false}  -> { token }
2. GET    {server}/rest/v4/devices         (Authorization: Bearer <token>)
3. DELETE {server}/rest/v4/login/sessions/<token>
```

## Flow walkthrough

The whole API flow lives in **`nx-server-client.mjs`** (the `NxServerClient`
class). The other files are not part of the flow: `app.mjs` only wires the form
to the DOM, and `proxy.mjs` / `server.mjs` are the local dev server that gets
the browser past CORS and the server's self-signed cert. To explain the flow,
walk through these three methods in order.

**Step 1 — `login()`: trade your local credentials for a session token.**
A single `POST` of `{ username, password, setCookie:false }` to the server's
login endpoint. `setCookie:false` keeps this a Bearer-token flow:

```js
// POST {server}/rest/v4/login/sessions  ->  { token: "…" }
this.token = data.token;
```

**Step 2 — `listCameras()`: call the server with that token.**
The cameras live on the server (its "devices"). Send the token as a bearer
header:

```js
const url = `${this.serverUrl}${API}/devices`;   // .../rest/v4/devices
const response = await this.fetchImpl(url, { headers: this._authHeader() });
return normalizeCameras(data);   // unwrap { reply: [...] } or a bare array
```

`serverUrl` resolves to `/server` here, which the local dev server forwards to
the one VMS server you configured at start time.

**Step 3 — `logout()`: revoke the session when you're done.**
Best-effort cleanup so the token can't be reused:

```js
// DELETE {server}/rest/v4/login/sessions/<token>
await this.fetchImpl(url, { method: "DELETE", headers: this._authHeader() });
this.token = null;
```

That's the entire flow: **log in → list devices → log out.** The same three
steps appear in the Node and Python versions of this sample.

## Read this first: CORS + self-signed TLS (why a plain page won't reach the server)

A browser will **block** `fetch()` to a local Nx server for two reasons:

- **CORS.** The server is a different origin from your page and does **not**
  return the headers (`Access-Control-Allow-Origin`, …) a browser requires
  before handing a cross-origin response back to JavaScript. You **cannot**
  disable CORS from JavaScript — it is enforced by the browser.
- **Self-signed TLS.** Local servers almost always present a **self-signed
  certificate**. A browser refuses `fetch()` to such an origin outright, and
  page JavaScript has no way to accept the cert.

This is browser security, not a bug in the sample.

### The solution: run the included dev server (one command)

This folder ships a tiny zero-dependency dev server that fixes both. It is
split into two files, by concern:

- **`proxy.mjs`** — the forwarder only. Relays `/server/*` to the one VMS server
  you configure, from outside the browser (where CORS does not apply), and can
  accept the server's self-signed cert. No static serving. Reusable by other
  web samples. There is no cloud route and no relay/307 hop here — just a single
  same-origin hop to your server.
- **`server.mjs`** — the static file server for the demo. It mounts the proxy
  handler so both run on **one port** (same-origin = no CORS).

```bash
cd web/rest-list-cameras-local-browser

# Point the dev server at YOUR Nx server. Local servers use a self-signed cert,
# so --insecure is normal here:
node server.mjs --server-host https://192.168.1.10:7001 --insecure
#   add --port 8080   (default shown)

# Then open the printed URL in your browser:
#   http://localhost:8080/
```

On the page, enter just two things and click **List cameras**:

- **Server username** (a **local** server account)
- **Password**

The server's address is set once via `--server-host`, so it's hidden from the
page. The page talks only to the proxy, which forwards to that server.

### The two flags

| Flag | What it does |
|------|--------------|
| `--server-host https://<ip>:7001` | The single VMS server this sample talks to (include `https://` and the port). If omitted, `/server/*` calls return a clear 502 telling you to set it. |
| `--insecure` | Lets the proxy accept the server's **self-signed** TLS certificate. Implemented with an Undici `Agent({ connect: { rejectUnauthorized: false } })` so only the proxy's upstream fetch is affected. Expected for local/lab servers. |

### Other ways teams solve this in production

The proxy mirrors what a real deployment does: front the Nx API with your own
**same-origin backend / reverse proxy** (nginx, a serverless function, an API
gateway) that adds auth, CORS, and a real certificate. For live *video*
specifically, use the official
**[`@networkoptix/webrtc-stream-manager`](https://www.npmjs.com/package/@networkoptix/webrtc-stream-manager)**.
Disabling browser security (e.g. a `--disable-web-security` Chrome flag) is
**not** a real solution — never do it outside a throwaway debugging session.

## Local vs. Cloud users

This sample logs in as a **local** server user. If you only have a **cloud**
account, use the cloud OAuth2 flow instead — see
[`../rest-list-cameras-browser`](../rest-list-cameras-browser) (browser),
[`../../node_js/rest-list-cameras-cloud-user`](../../node_js/rest-list-cameras-cloud-user),
or [`../../python/rest-list-cameras-cloud-user`](../../python/rest-list-cameras-cloud-user).

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: a login form + a camera table. |
| `app.mjs` | DOM wiring only — reads the form, calls the client, renders rows. |
| `nx-server-client.mjs` | The API logic (`NxServerClient`). Imported by the page **and** the tests. |
| `proxy.mjs` | The forwarder (a module): `/server/*` to the configured VMS server. No static serving. |
| `server.mjs` | Dev server: serves the static demo + mounts the proxy. **This is what you run.** |
| `test_nx_server_client.mjs` | Offline tests for the client (`node:test`, fake `fetch`). |
| `test_proxy.mjs` | Offline tests for the proxy's route dispatch (no network). |
| `package.json` | `type: module`; `npm test`, `npm run serve`. No dependencies. |

## Run the tests

The API logic is split out of the DOM so it tests offline, exactly like the
Node samples — no browser, no account, no network:

```bash
node --test test_nx_server_client.mjs test_proxy.mjs   # or: npm test
```
