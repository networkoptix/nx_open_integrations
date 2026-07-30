# Cloud CDB — Get an OAuth2 token, in the browser

Front-end (browser) counterpart of
[`../../python/cdb-get-token`](../../python/cdb-get-token) and
[`../../node_js/cdb-get-token`](../../node_js/cdb-get-token). The smallest possible
authentication example: a plain HTML page logs in to Nx Cloud and shows the
**bearer token** — no framework, no build step, no dependencies. Everything
else in the Nx Cloud / site APIs is just "send this token in an
`Authorization: Bearer` header."

## The one call (same as the Node/Python samples)

```
POST {cloud}/cdb/oauth2/token
Content-Type: application/json

{
  "grant_type":    "password",
  "response_type": "token",
  "client_id":     "3rdParty",
  "username":      "you@example.com",
  "password":      "your-password"
}
```

Optional fields:

- `"mfaCode": "123456"` — only if your account has **2FA** enabled.
- `"scope": "cloudSystemId=<id>"` — scope the token to **one** site. Omit it
  for a **cloud-wide** token (the usual case).

The response includes `access_token` (it starts with `nxcdb-`) and usually
`expires_in` (lifetime in seconds).

## Flow walkthrough

The whole API flow lives in **`nx-cloud-client.mjs`** (the `NxCloudTokenClient`
class). The other files are not part of the flow: `app.mjs` only wires the form
to the DOM, and `proxy.mjs` / `server.mjs` are the local dev server that gets
the browser past CORS.

**`getToken()`: trade your cloud credentials for a bearer token.** A single
`POST` to the cloud's OAuth2 endpoint:

```js
const body = {
  grant_type: "password",
  response_type: "token",
  client_id: CLIENT_ID,            // "3rdParty"
  username: this.user,
  password: this.password,
};
if (this.mfaCode) body.mfaCode = this.mfaCode;                  // only with 2FA
if (this.cloudSiteId) body.scope = `cloudSystemId=${this.cloudSiteId}`; // optional
// POST {cloud}/cdb/oauth2/token  ->  { access_token: "nxcdb-…", expires_in: 3600 }
return data;   // the page shows data.access_token (+ expires_in)
```

Leave the **Cloud Site ID** blank for a cloud-wide token (the usual case), or
supply one to scope the token to a single site. That's the entire flow — the
same single call appears in the Node and Python versions of this sample.

## Read this first: CORS (why a plain page won't reach the cloud)

A browser will **block** `fetch()` to the Nx Cloud. It is a different origin
from your page, and it does **not** return the CORS headers
(`Access-Control-Allow-Origin`, …) that a browser requires before it will hand
a cross-origin response back to JavaScript. You'll see a console error like
`... has been blocked by CORS policy`.

This is a browser security rule, not a bug in the sample. You **cannot** disable
CORS from JavaScript — it is enforced by the browser.

### The solution: run the included dev server (one command)

This folder ships a tiny zero-dependency dev server that fixes this. It is split
into two files, by concern:

- **`proxy.mjs`** — the CORS forwarder only. Relays `/cloud/*` to the real cloud
  from outside the browser (where CORS does not apply). No static serving.
  Reusable by other web samples. (This sample is cloud-only, so there is no site
  relay and no 307 hop here — just the one `/cloud` route.)
- **`server.mjs`** — the static file server for the demo. It mounts the proxy
  handler so both run on **one port** (same-origin = no CORS).

```bash
cd web/cdb-get-token-browser

# Start the dev server. No configuration needed.
node server.mjs
#   add --cloud-host https://nxvms.com   (default shown)
#   add --insecure                       (local cloud / self-signed certs)

# Then open the printed URL in your browser:
#   http://localhost:8080/
```

On the page, enter your login and click **Get token**:

- **Cloud email**
- **Password** (plus an **MFA code** if your account uses 2FA)
- **Cloud Site ID** (optional) — leave blank for a cloud-wide token, or provide
  one to scope the token to a single site.

The token is shown on the page; copy it and use it as
`Authorization: Bearer <token>` on any later CDB or site request. The page talks
only to the proxy, which forwards the call to the cloud — there are no hosts or
"base URLs" to fill in.

### Other ways teams solve CORS in production

The proxy mirrors what a real deployment does: front the Nx API with your own
**same-origin backend / reverse proxy** (nginx, a serverless function, an API
gateway) that adds auth and CORS. Disabling browser security (e.g. a
`--disable-web-security` Chrome flag) is **not** a real solution — never do it
outside a throwaway debugging session.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: a login form + the token result. |
| `app.mjs` | DOM wiring only — reads the form, calls the client, shows the token. |
| `nx-cloud-client.mjs` | The API logic (`NxCloudTokenClient`). Imported by the page **and** the tests. |
| `proxy.mjs` | The CORS forwarder (a module): `/cloud/*` only. No static serving. |
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
