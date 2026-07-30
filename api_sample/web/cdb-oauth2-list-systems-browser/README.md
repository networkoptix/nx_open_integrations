# Cloud CDB — OAuth2 login + list Sites, in the browser

Front-end (browser) counterpart of
[`../../node_js/cdb-oauth2-list-systems`](../../node_js/cdb-oauth2-list-systems)
and [`../../python/cdb-oauth2-list-systems`](../../python/cdb-oauth2-list-systems).
A plain HTML page logs in to Nx Cloud and lists the Sites registered to your
account — no framework, no build step, no dependencies.

## The flow (same as the Node/Python samples)

```
1. POST {cloud}/cdb/oauth2/token   -> cloud-wide bearer token  (NO scope)
2. GET  {cloud}/cdb/systems        (Authorization: Bearer <token>)
```

The cloud lists **Sites**, not cameras. Listing Sites is an account-level call,
so it needs a **cloud-wide** token — there is no `scope` on the token request.
(To operate against ONE site, e.g. that site's cameras over the relay, you need
a **site-scoped** token instead — see
[`../rest-list-cameras-browser`](../rest-list-cameras-browser).)

> The wire endpoint is literally `/cdb/systems` — that string is the endpoint
> name and is kept verbatim. Everywhere else this sample says "site"/"Sites".

## Flow walkthrough

The whole API flow lives in **`nx-cloud-client.mjs`** (the `NxCloudClient`
class). The other files are not part of the flow: `app.mjs` only wires the form
to the DOM, and `proxy.mjs` / `server.mjs` are the local dev server that gets
the browser past CORS. To explain the flow, walk through these two methods.

**Step 1 — `login()`: trade your cloud credentials for a cloud-wide token.**
A single `POST` to the cloud's OAuth2 endpoint with the documented password
grant. There is deliberately **no `scope`** — a cloud-wide token is what lets
you list the account's Sites:

```js
const body = {
  grant_type: "password",
  response_type: "token",
  client_id: CLIENT_ID,            // "3rdParty"
  username: this.user,
  password: this.password,
  // no scope -> cloud-wide token
};
// POST {cloud}/cdb/oauth2/token  ->  { access_token: "nxcdb-…" }
this.token = data.access_token;
```

**Step 2 — `listSites()`: list the account's Sites with that token.**
A single `GET` to `/cdb/systems`, sending the token as a bearer header. The
response is parsed defensively (it may be a bare array or an envelope):

```js
const url = `${this.cloudUrl}/cdb/systems`;
const response = await this.fetchImpl(url, { headers: this._authHeader() });
// _authHeader() -> { Authorization: `Bearer ${this.token}` }
return normalizeSites(data);   // unwrap { sites:[...] } / { reply:[...] } / bare array
```

`logout()` then best-effort revokes the token on the cloud. The same steps
appear in the Node and Python versions of this sample.

## Read this first: CORS (why a plain page won't reach the cloud)

A browser will **block** `fetch()` to the Nx Cloud. It is a different origin
from your page and does **not** return the CORS headers
(`Access-Control-Allow-Origin`, …) that a browser requires before it will hand a
cross-origin response back to JavaScript. You'll see a console error like
`... has been blocked by CORS policy` and the sample reports
`Could not reach … — usually CORS`.

This is a browser security rule, not a bug in the sample. You **cannot** disable
CORS from JavaScript — it is enforced by the browser.

### The solution: run the included dev server (one command)

This folder ships a tiny zero-dependency dev server that fixes that. It is split
into two files, by concern:

- **`proxy.mjs`** — the CORS forwarder only. Relays `/cloud/*` to the real
  cloud from outside the browser (where CORS does not apply). No static serving.
  Reusable by other web samples. This is a cloud-only sample, so it has just the
  one `/cloud` route — no site relay.
- **`server.mjs`** — the static file server for the demo. It mounts the proxy
  handler so both run on **one port** (same-origin = no CORS).

```bash
cd web/cdb-oauth2-list-systems-browser

# Start the dev server. No configuration needed.
node server.mjs
#   add --cloud-host https://nxvms.com   (default shown)
#   add --insecure                       (local cloud / self-signed certs)

# Then open the printed URL in your browser:
#   http://localhost:8080/
```

On the page, enter just two things (plus MFA if your account uses it) and click
**List Sites**:

- **Cloud email**
- **Password** (plus an **MFA code** if your account uses 2FA)

That's it — the page talks only to the proxy, which forwards to the cloud. There
are no hosts or "base URLs" to fill in.

### Other ways teams solve CORS in production

The proxy mirrors what a real deployment does: front the Nx API with your own
**same-origin backend / reverse proxy** (nginx, a serverless function, an API
gateway) that adds auth and CORS. Disabling browser security (e.g. a
`--disable-web-security` Chrome flag) is **not** a real solution — never do it
outside a throwaway debugging session.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: a login form + a Sites table and picker. |
| `app.mjs` | DOM wiring only — reads the form, calls the client, renders rows. |
| `nx-cloud-client.mjs` | The API logic (`NxCloudClient`). Imported by the page **and** the tests. |
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

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials. | Re-check email/password; add the MFA code for 2FA. |
| `Could not reach … — usually CORS` | Dev server not running. | Start it: `node server.mjs`, then open the printed URL. |
| Empty Site list | Account has no Sites, or lacks permission. | Confirm in the Nx cloud portal. |
