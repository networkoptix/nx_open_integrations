# REST Server API — Get a token from the mediaserver (browser)

The smallest possible **"how do I authenticate?"** demo, in the browser. It gets a
bearer token from **one mediaserver**, uses it, hands it back, and then proves the
token is dead — rendered as a four-step timeline so each call is visible.

On the latest `/rest/v4` API. Zero dependencies: plain HTML + ES modules,
and a tiny dev proxy from Node's standard library.

```
1  Get a token      POST /rest/v4/login/sessions          ✓ Got a token, valid for 600 seconds.
2  Use the token    GET /rest/v4/login/sessions/current   ✓ 200 OK — the server recognised the token.
3  Revoke the token DELETE /rest/v4/login/sessions/current ✓ Session deleted.
4  Prove it is dead the same GET again                     ✓ HTTP 401 — rejected, as expected.
```

## Run it

```bash
node server.mjs --server-host https://192.168.1.10:7001 --insecure
# then open http://localhost:8080/
```

`--server-host` is the mediaserver this sample talks to (include `https://` and
the port). `--insecure` makes the **proxy** accept that server's self-signed TLS
certificate, which lab servers almost always use. `--port` changes the local
port (default `8080`).

The page then asks for just a **username and password** — the server address is
configured on the proxy at start time, so there is nothing else to fill in.

## What the code does (Nx 5.0+ bearer-token auth)

1. **Get a token** — `POST /rest/v4/login/sessions` with `{username, password}` →
   `{id, username, token, ageS, expiresInS}`. The table shows all of it.
2. **Use the token** — `GET /rest/v4/login/sessions/current` with
   `Authorization: Bearer <token>`. The literal `current` (the v4 API also accepts
   `-`) means *"the token in my Authorization header"*, so this one call both
   proves the token works and shows what a session contains.
3. **Revoke the token** — `DELETE /rest/v4/login/sessions/current` releases the
   session and the token with it. `current` again means "the token in my
   Authorization header".
4. **Confirm** — repeat step 2 with the same token. It now fails, which is the
   point: logout is something you can *see*, not take on faith.

If a step fails, its timeline entry turns red where it stopped, rather than the
page just going quiet.

## Why the browser needs the proxy

A page cannot call a local mediaserver directly, for two separate reasons:

1. **CORS** — the mediaserver is a different origin and does not send CORS headers
   for your page, so the browser blocks the call before it is even sent.
2. **Self-signed TLS** — lab servers present a certificate the browser refuses
   outright, and page JavaScript has no way to say "I trust this one."

`proxy.mjs` solves both from outside the browser, where neither rule applies.
`server.mjs` serves this page *and* mounts that proxy on the same port, so the
page and its API calls share an origin:

```
browser  ──▶  http://localhost:8080/server/rest/v4/...   (same origin, no CORS)
                        │  proxy.mjs
                        ▼
              https://192.168.1.10:7001/rest/v4/...      (self-signed cert OK)
```

**Be clear about what that means for the token.** The page composes the
`Authorization: Bearer <token>` header, but it is the *proxy* that puts that
header on the wire to the mediaserver. The header still does the authorizing —
one of the tests, and a `curl` against a running proxy, both confirm the same
request without it returns 401 — it just takes one extra same-origin hop first.
A production integration would talk to the server from its own backend and need
none of this.

This proxy is a **dev convenience, not a production gateway**: it forwards
whatever it is given to one configured host.

### Where the token goes

The token goes in the `Authorization: Bearer <token>` header.

All three calls that need it address the session with the `current`
sentinel, so the request path is the same every time and the header is what
identifies the session. The `{token}`-in-path form is equally valid and is
what the other samples in this repo use.

### The `--insecure` TLS warning

`--insecure` is handled by the **proxy**, not the page. It prefers an Undici
`Agent`, which accepts a self-signed cert quietly. If Undici cannot be imported
it falls back to setting `NODE_TLS_REJECT_UNAUTHORIZED=0`, which makes Node print
a warning on every run — so `suppressTlsWarning()` in `proxy.mjs` filters that
one message, and only it. **Do not copy this into
production code:** there the warning is the point.

### Tokens expire

`expiresInS` is how many seconds you have. The page shows it, because it's the
thing that bites people later. The `POST` body also accepts an optional
`durationS` to request a specific lifetime (capped by the site-wide limit); this
sample takes the site default.

## Prerequisites

- **Node.js 18+** to run the dev server. No `npm install` needed.
- An Nx mediaserver reachable from this machine, and a **local** server account.
  Cloud users need a different flow — see the note below.
- The tests need neither a server nor a browser.

## Run the tests

```bash
node --test test_nx_login_client.mjs test_proxy.mjs     # 27 tests, fully offline
```

Bare `node --test` finds nothing here — these filenames are `test_*.mjs`, which is
not one of Node's default test globs. Name them explicitly (or `npm test`).

The tests cover the client module and the proxy's routing decisions. They do not
drive the DOM: `app.mjs` is deliberately thin, holding only DOM wiring, so that
everything worth testing lives in `nx-login-client.mjs`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Proxy could not reach https://...` (HTTP 502) | Server address wrong or unreachable, or a self-signed cert. | Check `--server-host`; add `--insecure` for a self-signed cert. |
| `No VMS server configured` (HTTP 502) | Started without `--server-host`. | Restart with `--server-host https://<ip>:7001`. |
| `Login rejected (HTTP 401/403)` | Wrong password, or a **cloud** user. | Use a local server account (see the note below). |
| Step 4 says the token is *still accepted* | The `DELETE` did not take effect. | Check the account may delete its own session; the token still expires on its own after `expiresInS`. |
| Nothing happens when you submit | A JS error. | Open the browser console; check `app.mjs` loaded (it's an ES module, so the page must be served over http, not opened as a file). |

### Local vs. Cloud users

This sample logs in as a **local** server user. If you only have a **cloud**
account, the server delegates authentication to the cloud: you get a token from
`POST /cdb/oauth2/token` with `scope=cloudSystemId=<id>` and use that against the
server. See [`../cdb-get-token-browser`](../cdb-get-token-browser) for the cloud
login in the browser, and
[`../rest-list-cameras-browser`](../rest-list-cameras-browser) for reaching a site
with a cloud token through the relay.

### Next steps

- [`../rest-list-cameras-local-browser`](../rest-list-cameras-local-browser) — the
  same login, then `GET /rest/v4/devices` to list the site's cameras.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: form + four-step timeline + session table. |
| `app.mjs` | DOM wiring only. Imports the client below. |
| `nx-login-client.mjs` | All the API logic. Framework-free and unit-tested. |
| `proxy.mjs` | The CORS/TLS forwarder: `/server/*` → the configured mediaserver. |
| `server.mjs` | Dev server: serves this folder and mounts the proxy on one port. |
| `test_nx_login_client.mjs` | Offline tests for the client (mocked fetch). |
| `test_proxy.mjs` | Offline tests for the proxy's routing decisions. |
