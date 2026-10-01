# REST API, back up and restore the Site database (browser)

Downloads the Site database as a file, and loads a dump back into a site, from
a web page. The database is shared by every server in the site, so one dump is
a snapshot of the whole site configuration: servers, cameras, users, groups,
layouts, rules, licences and storage settings.

Browser counterpart of `../../python/rest-backup-site-database` and its Node.js
and TypeScript ports.

```
$ node server.mjs --server-host https://192.168.1.10:7001 --insecure

Nx browser sample running:
  open    http://127.0.0.1:8080/   (this machine only)
  static  served from this folder (index.html, app.mjs, ...)
  server  /server/*   -> https://192.168.1.10:7001
  TLS     self-signed certs accepted (--insecure)
```

The page then offers two things: a button that downloads
`nx-site-database-192-168-1-10-7001-20260914T031200Z.db`, and a file picker
that loads one back after you type the server address to confirm.

## Read this before using it on anything you care about

**The browser holds the whole dump in memory.** Saving a file from a page means
building a `Blob`, and a `Blob` is memory. On a large site that is tens of
megabytes sitting in a tab. The Python, Node.js and TypeScript versions stream
the dump straight to disk and never hold it whole; they exist for exactly that
case, and on a big site they are the right tool.

This sample's proxy does stream its half, so the dump is not buffered twice.
That is a deliberate difference from every other web sample in this catalog,
whose proxies end with `Buffer.from(await upstream.arrayBuffer())`. Fine for a
JSON camera list, wrong for a database dump.

**A restore replaces the entire site and restarts the server.** There is no
undo. The page makes you type the server address before the button works.

## What the code does

**backup**

1. Log in: `POST /server/rest/v4/login/sessions` with `{username, password}`,
   which returns `{"token": ...}`. This happens right before step 2, because
   the endpoint wants a fresh session.
2. Dump: `GET /server/rest/v4/site/database` with `Authorization: Bearer
   <token>`. The body is the raw binary dump, taken as a `Blob`.
3. Log out: `DELETE /server/rest/v4/login/sessions/<token>`.

**restore**

1. Log in, as above.
2. Load: `POST /server/rest/v4/site/database` with `Content-Type:
   application/octet-stream` and the chosen `File` as the body, unchanged. No
   multipart, no base64, no `FormData`.
3. No log out. The server restarts as soon as it accepts the dump, so the
   session ends on its own.

Every path starts `/server/`, which is this page's own dev proxy. See below.

## Why the browser needs a proxy at all

A local Nx server is a different origin from this page and does not send CORS
headers for it, so the browser blocks direct calls. It also usually presents a
self-signed TLS certificate, which the browser refuses outright. Neither can be
worked around from page JavaScript.

`server.mjs` serves this page and mounts `proxy.mjs` on the same port, so the
page and its API calls share an origin. `proxy.mjs` forwards `/server/*` to the
configured VMS server and, with `--insecure`, accepts its self-signed
certificate.

### How the page knows a restore succeeded

This is the one place the browser is weaker than the command line, and the
proxy is what makes up the difference.

A successful restore restarts the server, which usually cuts the connection
instead of answering. The Node.js and TypeScript versions recognise that from
the error's `cause.code` being `ECONNRESET` or similar. A browser never sees
that: `fetch` rejects with a bare `Failed to fetch`, which is exactly what a
dead proxy or a dropped network looks like. A page that treated every failure
after the request as success would cheerfully report a failed restore as a
successful one.

So the proxy, which runs outside the browser and does see the socket error,
reports the code in an `x-nx-upstream-error` header, and the client treats the
restart codes as success and everything else as failure.

## Prerequisites

- **Node 18+** to run the dev server and the tests. No dependencies to install.
- An **administrator** account on the target site, local to the server. A
  cloud account uses the OAuth2 flow, which is a different sample.
- A modern browser.

The tests need neither a browser nor a server nor a network.

## Install

Nothing to install. The sample and its tests use only Node built-ins.

## Configure

Nothing is configured in the page. The server address is set once when you
start the dev server, so there is nothing for a page visitor to point at the
wrong machine:

```bash
node server.mjs --server-host https://192.168.1.10:7001 --insecure
```

| Flag | Purpose |
|---|---|
| `--server-host` | The VMS server to talk to, with scheme and port. |
| `--insecure` | Accept the server's self-signed certificate (lab use only). |
| `--port` | Port for this dev server (default 8080). |

This sample introduces no `NX_*` variable; the shared `.env` is not used here.

## Run

```bash
node server.mjs --server-host https://192.168.1.10:7001 --insecure
# then open http://127.0.0.1:8080/
```

Enter a local administrator username and password, then either press
**Download a dump**, or choose a dump file, type the server address in the
confirmation box, and press **Restore this dump**.

## Run the tests

```bash
node --test test_nx_backup_client.mjs test_proxy.mjs

# Or via the package script:
npm test
```

The tests cover the client and the proxy, not the DOM, which is the house rule
for browser samples. The restore confirmation is therefore in the client
(`restoreDatabase` refuses without `confirmed: true`) rather than in the page,
so that the guard is covered by a test.

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `No VMS server configured` | The dev server was started without `--server-host`. | Restart it with the flag. |
| `Proxy could not reach ...` | Wrong address, server down, or a self-signed certificate. | Check the address; add `--insecure`. |
| `Login unauthorized (HTTP 401/403)` | Wrong password, or a cloud account. | Use a local server account. |
| `The site refused the dump (HTTP 403)` after signing in | The account is not an administrator, or the session is no longer fresh. | Use an administrator. The page already logs in immediately before each call, so a 403 here points at the role. |
| `The server returned an empty dump` | A zero length body. | Check the account is an administrator and the site has finished starting. |
| `Type https://... in the confirmation box` | The guard did its job. | Type the address exactly as the page shows it. |
| The page shows `no server configured` and its buttons are greyed out | The dev server was started without `--server-host`, so `/config.json` has no address to give the page. | Restart `server.mjs` with `--server-host`, then reload. |
| `The load request failed (HTTP 502)` after a restore | The proxy could not reach the server, and said so without a restart marker, so the dump did not land. | Check the server is up, then retry. |
| `The server took the dump but gave no answer in time` | The whole upload went up, then the server neither answered nor dropped the connection for 5 minutes. | The outcome is unknown: the server may be restarting with the dump. Check it before restoring again. |
| The tab gets slow during a backup | The dump is large and it is all in memory. | Use the Python, Node.js or TypeScript version for a big site. |

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: sign in, back up, restore. |
| `app.mjs` | DOM wiring only. Reads inputs, calls the client, writes results. |
| `nx-backup-client.mjs` | All the API logic, framework free, so it can be tested offline. |
| `proxy.mjs` | The CORS forwarder. Streams the dump, and reports upstream socket errors. |
| `server.mjs` | Dev server: static files plus the proxy, on one port. |
| `test_nx_backup_client.mjs` | Offline tests for the client (injected `fetch`). |
| `test_proxy.mjs` | Offline tests for the proxy (injected upstream). |
| `package.json` | Name, `type: module`, and the `test` and `serve` scripts. No dependencies. |
