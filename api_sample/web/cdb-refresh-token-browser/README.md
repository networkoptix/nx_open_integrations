# Cloud CDB — Refresh-token session, in the browser

Front-end (browser) counterpart of
[`../../python/cdb-refresh-token`](../../python/cdb-refresh-token) and
[`../../node_js/cdb-refresh-token`](../../node_js/cdb-refresh-token). A plain HTML
page logs in to Nx Cloud **once**, stores the access + refresh tokens in the
browser, and keeps the session alive over `/cdb/oauth2/token` **without
re-sending the password** — no framework, no build step, no dependencies.

## The idea (same as the Node/Python samples)

With token-based auth you don't send your password on every request. You log in
once and get an **access token** (short-lived, sent as `Authorization: Bearer`)
plus a **refresh token** (long-lived, used only to mint new access tokens). The
sample shows the three things you do to keep the session healthy:

1. **Proactive refresh** — refresh shortly *before* the access token expires
   (a 60-second safety margin).
2. **Reactive refresh** — if a call still returns `401`, refresh once and retry.
3. **Rotation + storage** — always adopt the newest refresh token the server
   returns, and persist the session so a page reload can resume it.

## The calls

```
Login:    POST {cloud}/cdb/oauth2/token
          { grant_type:"password", response_type:"token",
            client_id:"3rdParty", username, password }   (+ mfaCode if 2FA)

Refresh:  POST {cloud}/cdb/oauth2/token
          { grant_type:"refresh_token", response_type:"token",
            client_id:"3rdParty", refresh_token:"<latest refresh token>" }
```

## Flow walkthrough

The whole flow lives in **`nx-cloud-client.mjs`** (the `TokenSession` class).
The other files are not part of the flow: `app.mjs` only wires the form to the
DOM, and `proxy.mjs` / `server.mjs` are the local dev server that gets the
browser past CORS. Walk through these three methods in order.

**Step 1 — `login(user, password, mfaCode?)`: the only time the password is
sent.** A single `POST` with the `password` grant. The response carries an
`access_token` (`nxcdb-…`) and, typically, a `refresh_token` and `expires_in`.
`TokenSession` *absorbs* all three — storing the tokens and computing
`expiresAt = now + expires_in`.

**Step 2 — `refresh()`: renew the session with NO password.** A `POST` with the
`refresh_token` grant and the stored refresh token. The new access token (and a
**rotated** refresh token, if the server returns one) replaces the old state and
the expiry is recomputed. This is what lets the page stay logged in without ever
touching the password again.

**Step 3 — `ensureValid()`: refresh only when needed.** Call it before an API
request. It refreshes proactively only when the token is missing or within the
60-second safety margin of expiry, so it is cheap to call often. (`401` handling
via `AuthError` covers the reactive case.)

State persists to `sessionStorage`, so a reload reconstructs the session in the
constructor — the page then offers **Refresh now** without asking for the
password again.

## Security: tokens in the browser

This sample stores `{access_token, refresh_token, expiresAt}` in
**`sessionStorage`** purely to demonstrate resuming and refreshing a session
across a page reload. Understand the trade-offs:

- **XSS exposure.** Anything in `sessionStorage`/`localStorage` is readable by
  any JavaScript on the page. A single XSS bug leaks the tokens. (This sample
  uses `sessionStorage`, **not** `localStorage`: it is **per-tab** and **cleared
  when the tab closes**, which narrows the window but does not remove the risk.)
- **No httpOnly protection.** Unlike an httpOnly cookie, script-readable storage
  can't be hidden from the page's own JavaScript.

**What a real app should do instead:** keep the access token **in memory only**
(a JS variable, never persisted), and keep the refresh token in an
**httpOnly, Secure, SameSite cookie** issued by your own backend — the browser
sends it automatically and script can't read it. Your backend performs the
refresh and re-issues the cookie. This sample skips that backend on purpose to
keep the refresh mechanics visible; do **not** copy the `sessionStorage`
approach into production.

## Read this too: CORS (why a plain page won't reach the cloud)

A browser will **block** `fetch()` to Nx Cloud — it's a different origin from
your page and does **not** return the CORS headers (`Access-Control-Allow-Origin`,
…) a browser requires before handing a cross-origin response back to JavaScript.
You'll see `... has been blocked by CORS policy` and the sample reports
`Could not reach … — is the dev server running?`.

This is a browser security rule, not a bug. You **cannot** disable CORS from
JavaScript; it is enforced by the browser.

### The solution: run the included dev server (one command)

This folder ships a tiny zero-dependency dev server, split by concern:

- **`proxy.mjs`** — the CORS forwarder only. Relays `/cloud/*` to the real cloud
  from outside the browser (where CORS does not apply). No static serving.
  Reusable by other web samples. This sample is **cloud-only** — the
  refresh-token flow never touches a site relay, so there is no `/relay` route.
- **`server.mjs`** — the static file server for the demo. It mounts the proxy
  handler so both run on **one port** (same-origin = no CORS).

```bash
cd web/cdb-refresh-token-browser

# Start the dev server. No configuration needed.
node server.mjs
#   add --cloud-host https://nxvms.com   (default shown)
#   add --insecure                       (local cloud / self-signed certs)

# Then open the printed URL in your browser:
#   http://localhost:8080/
```

On the page:

1. Enter your **cloud email** + **password** (plus an **MFA code** if your
   account uses 2FA) and click **Log in**. The password is sent exactly once.
2. The **Stored session** card shows whether a token is stored, the (truncated)
   access + refresh tokens, and how long until expiry.
3. Click **Refresh now** to renew the session — no password. If the server
   rotates the refresh token, the card updates to the new one.
4. **Reload the page** — the session resumes from `sessionStorage`; you can
   refresh again without logging in.
5. **Clear session** forgets the tokens for this tab.

### Other ways teams solve CORS in production

The proxy mirrors what a real deployment does: front the Nx API with your own
**same-origin backend / reverse proxy** (nginx, a serverless function, an API
gateway) that adds auth and CORS — the same backend that should be holding the
refresh token in an httpOnly cookie (see **Security** above). Disabling browser
security (e.g. a `--disable-web-security` Chrome flag) is **not** a real
solution — never do it outside a throwaway debugging session.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: a login form + a stored-session card with Refresh / Clear. |
| `app.mjs` | DOM wiring only — reads the form, drives one `TokenSession`, renders state. |
| `nx-cloud-client.mjs` | The session logic (`TokenSession`). Imported by the page **and** the tests. |
| `proxy.mjs` | The CORS forwarder (a module): `/cloud/*` only. No static serving. |
| `server.mjs` | Dev server: serves the static demo + mounts the proxy. **This is what you run.** |
| `test_nx_cloud_client.mjs` | Offline tests for the session (`node:test`, fake `fetch`, injected storage + clock). |
| `test_proxy.mjs` | Offline tests for the proxy's route dispatch (no network). |
| `package.json` | `type: module`; `npm test`, `npm run serve`. No dependencies. |

## Run the tests

The session logic is split out of the DOM so it tests offline, exactly like the
Node samples — no browser, no account, no network. `sessionStorage` doesn't
exist under `node:test`, so the tests inject a tiny in-memory storage object and
a deterministic clock; the client also feature-detects `sessionStorage` and
falls back to a no-op when it's absent.

```bash
node --test test_nx_cloud_client.mjs test_proxy.mjs   # or: npm test
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials. | Re-check email/password; add an MFA code for 2FA. |
| `Refresh rejected (HTTP 401/403)` | The refresh token expired or was rotated away. | Log in again to get a fresh pair. |
| `Could not reach … server.mjs` | The dev server isn't running. | `node server.mjs`, then open the printed URL. |
| `... blocked by CORS policy` | You opened `index.html` directly. | Open it via the dev server URL, not `file://`. |
