# REST API — List cameras, cloud user, in the browser

Front-end (browser) counterpart of
[`../../node_js/rest-list-cameras-cloud-user`](../../node_js/rest-list-cameras-cloud-user)
and [`../../python/rest-list-cameras-cloud-user`](../../python/rest-list-cameras-cloud-user),
on the latest **`/rest/v4`** API. A plain HTML page logs in to Nx Cloud, scopes
a token to one site, and lists that site's cameras — no framework, no build
step, no dependencies.

## The flow (same as the Node/Python samples)

```
1. POST   {cloud}/cdb/oauth2/token   (..., scope:"cloudSystemId=<id>")  -> scoped token
2. GET    https://<id>.relay.vmsproxy.com/rest/v4/devices   (Authorization: Bearer <token>)
3. DELETE {cloud}/cdb/oauth2/token/<token>
```

## Flow walkthrough

The whole API flow lives in **`nx-cloud-client.mjs`** (the `NxCloudSiteClient`
class). The other files are not part of the flow: `app.mjs` only wires the form
to the DOM, and `proxy.mjs` / `server.mjs` are the local dev server that gets
the browser past CORS. To explain the flow, walk through these three methods in
order.

**Step 1 — `login()`: trade your cloud credentials for a site-scoped token.**
A single `POST` to the cloud's OAuth2 endpoint. The one field that matters is
`scope` — it's what makes the returned token usable against *your* site:

```js
const body = {
  grant_type: "password",
  response_type: "token",
  client_id: CLIENT_ID,            // "3rdParty"
  username: this.user,
  password: this.password,
  scope: `cloudSystemId=${this.siteId}`,   // <- scopes the token to one site
};
// POST {cloud}/cdb/oauth2/token  ->  { access_token: "nxcdb-…" }
this.token = data.access_token;
```

Without the `scope`, you'd get a cloud-wide token that a site will reject. With
it, you get a token the site accepts.

**Step 2 — `listCameras()`: call the site through the relay with that token.**
The cloud has no cameras; the *site* does. You reach the site over the Cloud
relay, sending the token as a bearer header:

```js
const url = `${this.relayUrl}${API}/devices`;   // .../rest/v4/devices
const response = await this.fetchImpl(url, { headers: this._authHeader() });
// _authHeader() -> { Authorization: `Bearer ${this.token}` }
return normalizeCameras(data);   // unwrap { reply: [...] } or a bare array
```

`relayUrl` resolves to your site's relay (`/relay/<siteId>` here, which the
local server forwards to `https://<siteId>.relay.vmsproxy.com`).

**Step 3 — `logout()`: revoke the token when you're done.**
Best-effort cleanup so the token doesn't linger on the cloud:

```js
// DELETE {cloud}/cdb/oauth2/token/<token>
await this.fetchImpl(url, { method: "DELETE", headers: this._authHeader() });
this.token = null;
```

That's the entire flow: **scoped token → call the site via the relay → revoke.**
The same three steps appear in the Node and Python versions of this sample.

## Read this first: CORS (why a plain page won't reach the cloud)

A browser will **block** `fetch()` to the Nx Cloud and the site relay. Those
are different origins from your page, and they do **not** return the CORS
headers (`Access-Control-Allow-Origin`, …) that a browser requires before it
will hand a cross-origin response back to JavaScript. You'll see a console
error like `... has been blocked by CORS policy` and the sample reports
`Could not reach … — usually CORS`.

This is a browser security rule, not a bug in the sample. Two more browser-only
facts make a "pure page" approach impossible against the public cloud:

- **The relay 307 can't be followed by hand.** The Node sample uses
  `redirect:"manual"` and re-attaches the bearer across the relay hop. In a
  browser that produces an unreadable `opaqueredirect` response, and browsers
  **strip the `Authorization` header on cross-origin redirects** anyway.
- You **cannot** disable CORS from JavaScript. It is enforced by the browser.

### The solution: run the included dev server (one command)

This folder ships a tiny zero-dependency dev server that fixes all of the above.
It is split into two files, by concern:

- **`proxy.mjs`** — the CORS forwarder only. Relays `/cloud/*` and
  `/relay/<siteId>/*` to the real cloud/relay from outside the browser (where
  CORS does not apply), and performs the manual 307 + bearer re-attach hop that
  a browser can't. No static serving. Reusable by other web samples.
- **`server.mjs`** — the static file server for the demo. It mounts the proxy
  handler so both run on **one port** (same-origin = no CORS).

```bash
cd web/rest-list-cameras-browser

# Start the dev server. No configuration needed.
node server.mjs
#   add --cloud-host https://nxvms.com   (default shown)
#   add --insecure                       (local relay / self-signed certs)

# Then open the printed URL in your browser:
#   http://localhost:8080/
```

On the page, enter just three things and click **List cameras**:

- **Cloud Site ID** (the UUID of the site you want — find it in the Nx client)
- **Cloud email**
- **Password** (plus an **MFA code** if your account uses 2FA)

That's it — the page talks only to the proxy, which figures out the cloud and
the right relay (`https://<siteId>.relay.vmsproxy.com`) from your Site ID.
There are no hosts or "base URLs" to fill in.

### Other ways teams solve CORS in production

The proxy mirrors what a real deployment does: front the Nx API with your own
**same-origin backend / reverse proxy** (nginx, a serverless function, an API
gateway) that adds auth and CORS. For live *video* specifically, use the
official **[`@networkoptix/webrtc-stream-manager`](https://www.npmjs.com/package/@networkoptix/webrtc-stream-manager)**,
which handles signaling and relay for the browser. Disabling browser security
(e.g. a `--disable-web-security` Chrome flag) is **not** a real solution — never
do it outside a throwaway debugging session.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: a login form + a camera table. |
| `app.mjs` | DOM wiring only — reads the form, calls the client, renders rows. |
| `nx-cloud-client.mjs` | The API logic (`NxCloudSiteClient`). Imported by the page **and** the tests. |
| `proxy.mjs` | The CORS forwarder (a module): `/cloud/*` and `/relay/<id>/*`. No static serving. |
| `server.mjs` | Dev server: serves the static demo + mounts the proxy. **This is what you run.** |
| `test_nx_cloud_client.mjs` | Offline tests for the client (`node:test`, fake `fetch`). |
| `test_proxy.mjs` | Offline tests for the proxy's route dispatch (no network). |
| `package.json` | `type: module`; `npm test`, `npm run serve`. No dependencies. |

## Run the tests

The API logic is split out of the DOM so it tests offline, exactly like the
Node samples — no browser, no account, no network:

```bash
node --test test_nx_cloud_client.mjs test_proxy.mjs   # or: npm test
```
