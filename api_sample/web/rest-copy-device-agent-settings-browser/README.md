# REST API, copy Device Agent settings to another device (browser)

Downloads the settings an analytics Engine (a plugin, e.g. a motion or object
detector) keeps for one device's Device Agent, then applies them to another
device, from a web page. Handy for rolling out the same analytics
configuration across several cameras that run the same plugin, without
re-entering it by hand in the client for each one.

```
$ node server.mjs --server-host https://192.168.1.10:7001 --insecure

Nx browser sample running:
  open    http://localhost:8080/
  static  served from this folder (index.html, app.mjs, ...)
  server  /server/*   -> https://192.168.1.10:7001
  TLS     self-signed certs accepted (--insecure)
```

The page then offers two things: a button that downloads
`nx-device-agent-settings-{cameraA-id}-20260916T031200Z.json`, and a form
that loads a chosen settings file and applies it to another device once you
type that device's ID to confirm.

## What the code does

**Download**

1. Log in: `POST /server/rest/v4/login/sessions` with `{username, password}`,
   which returns `{"token": ...}`.
2. Get: `GET /server/rest/v4/analytics/engines/{engineId}/deviceAgents/{deviceId}/settings`
   with `Authorization: Bearer <token>`. The answer must be a JSON object; it
   is handed to the browser as a JSON file download, keys sorted.
3. Log out: `DELETE /server/rest/v4/login/sessions/<token>`.

**Apply**

1. Check the chosen file, before logging in: it must be valid JSON, and the
   top level must be a JSON object (a list is refused).
2. Log in, as above.
3. Set: `PUT /server/rest/v4/analytics/engines/{engineId}/deviceAgents/{deviceId}/settings`
   with a body built from the file, dropping `deviceId`, `engineId` and
   `_error`. Everything else, `values`, `model`, `analyzedStream`,
   `disableStreamSelection`, is forwarded unchanged.
4. Log out.

The log out runs whether the action worked or not. If the log out itself
fails after a successful action, the page keeps the success message and adds
a warning line under it: `Warning: could not log out: <reason>.`

Every path starts `/server/`, which is this page's own dev proxy. See below.

**What counts as applied.** Any 2xx answer whose body is empty, is not JSON,
or is JSON without errors. A 2xx whose body carries a non-empty `_error` map
means the server took the settings but the Engine rejected some of them; the
page shows `The server took the settings but the Engine reported errors:`
followed by one `name: message` line per setting. Anything that is not a 2xx
is a failure.

**No redirect is followed**, on any request. A 3xx is shown as a failure,
never as an applied change. A browser holds the redirect back without telling
the page its code, so the page says `HTTP 3xx (redirect not followed)`, e.g.
`Applying settings failed: HTTP 3xx (redirect not followed). The settings were
not applied.`

**When apply gets an error answer.** A 4xx means the server refused the
settings: `Applying settings failed: HTTP 404. The settings were not applied.
The target device may not be running this Engine.` A 5xx from the server may
come after it wrote some of them: `Applying settings failed: HTTP 500. The
server may have applied some of them; download the device's settings to
check.`

**When the outcome is unknown.** If the connection to the server could not be
made at all (refused, DNS, unreachable, connect timeout), the page says
`Could not reach the server (...). The settings were not applied.` If the
server's certificate was refused, it says `Certificate verification failed.
Local servers use a self-signed certificate, restart server.mjs with
--insecure. The settings were not applied.` If it was
lost after the settings were sent (the server dropped the connection, or said
nothing for 60 s), the page cannot know whether they landed and says so:
`Outcome unknown: the connection was lost after the settings were sent.
Download the device's settings to check.`

### Three things worth knowing

- **The URL carries the identity, not the body.** `engineId` and `deviceId`
  appear only in the path for both calls, and are not even in the spec's PUT
  request body schema. The response echoes them back for your own reference,
  which is why they are dropped before the settings are re-sent to a
  different device. `_error` is dropped too: it is the source device's error
  report, and sending it would claim errors the target never had.
- **One device per apply action.** Applying writes to exactly one target. To
  roll the same settings out to several devices, choose the same file again
  with a different target device ID: this page does not loop for you.
- **The settings are opaque.** `values` is whatever name/value pairs that
  Engine's plugin defines; this sample does not know or validate their shape.
  If the target device is not running the Engine you named, the `PUT` is
  rejected and the sample reports that rather than guessing.

## Files, the browser way

A page cannot write to an arbitrary path or read one back. **Download** hands
the settings to the browser as a file download, so the browser's Save dialog
decides where it lands and what happens to a file of the same name; the page
never overwrites anything itself. **Apply** reads them back from a file you
choose in the browser's file picker. Download once, apply as often as you
like, one target device per apply.

## Why the browser needs a proxy at all

A local Nx server is a different origin from this page and does not send CORS
headers for it, so the browser blocks direct calls. It also usually presents a
self-signed TLS certificate, which the browser refuses outright. Neither can be
worked around from page JavaScript.

`server.mjs` serves this page and mounts `proxy.mjs` on the same port, so the
page and its API calls share an origin. `proxy.mjs` forwards `/server/*` to the
configured VMS server and, with `--insecure`, accepts its self-signed
certificate. It holds each request and answer whole in memory, which is fine
only because Device Agent settings are a small JSON object; a proxy for large
bodies would have to stream.

The proxy follows no redirect. Every answer it, rather than the VMS server,
produces names its cause in an `x-nx-upstream-error` header: the socket error
code, `UPSTREAM_TIMEOUT` with a 504 when the server said nothing for 60 s
(the seconds go in `x-nx-upstream-timeout-seconds`, so the page can say
`no answer within 60 s`), `NO_SERVER_HOST` (502) without `--server-host`, `BAD_REQUEST` (400) when the
page's request never arrived whole, or `PROXY_ERROR` (500) for a fault of its
own. The page reads that code before the status, so the proxy's 502 is never
reported as the VMS server's, and it is how the page tells "never sent" from
"outcome unknown". Only certificate codes and connect failures count as
"never sent"; a TLS error after connecting (any other `ERR_SSL_...`) may come
after the request went out. A browser that leaves mid-request cancels the upstream call
instead of leaving it running.

## Prerequisites

- **Node 18+** to run the dev server and the tests. No dependencies to install.
- A server account with **Power User** or better, for both the source and
  target devices.
- The source and target devices must run the Device Agent for the given
  Engine (i.e. that analytics plugin must be enabled on them).
- A modern browser.

The tests need neither a browser nor a server nor a network.

## Finding the device and engine ids

- **Device id**: see the support article
  [How to find device IDs](https://support.networkoptix.com/hc/en-us/articles/41797563591447-How-to-find-device-IDs).
- **Engine id**: call `GET /rest/v4/analytics/engines` (any authenticated user).
  It returns every Analytics Engine on the site as `{id, name, integrationId}`;
  match the `name` you see in the client's Analytics Engines list to its `id`.

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

`--insecure` takes no value: `--insecure=yes` is refused, as is a value flag
given without its value.

This sample introduces no `NX_*` variable; the shared `.env` is not used here.

`server.mjs` exits with:

| Code | Meaning |
|---|---|
| 0 | Not reached in normal use: the dev server runs until you stop it. |
| 1 | An error you can fix: a `--server-host` that is not a URL, or a port already in use. One `ERROR: ...` line, no stack trace. |
| 2 | A usage error: unknown flag, a value flag without its value, `--insecure=...`, a bad `--port`. |
| 130 | Stopped with Ctrl-C (prints `Interrupted.`). |

The page itself reports every outcome in its status box rather than an exit
code.

## Run

```bash
node server.mjs --server-host https://192.168.1.10:7001 --insecure
# then open http://localhost:8080/
```

Enter a server username and password with Power User or better, then either:

- fill in the engine and source device IDs and press **Download settings**, or
- choose a downloaded settings file, fill in the engine and target device IDs,
  type the target device ID in the confirmation box, and press
  **Apply settings**.

## Run the tests

```bash
node --test test_nx_device_agent_settings_client.mjs test_proxy.mjs

# Or via the package script:
npm test
```

The tests cover the client, the proxy and the dev server's flags, not the DOM,
which is the house rule for browser samples. The apply confirmation is
therefore in the client (`applySettings` refuses without `confirmed: true`),
and so is the log in, act, log out sequence (`runSession`), so that both are
covered by tests. The proxy tests also run the real proxy against a
throwaway server on 127.0.0.1, for redirects, dropped connections and
timeouts.

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `No VMS server configured. Restart server.mjs with --server-host https://<ip>:7001.` (on apply, then `The settings were not applied.`) | The dev server was started without `--server-host`. | Restart it with the flag. |
| `Could not reach the server (...).` (on apply, then `The settings were not applied.`) | Wrong address, or the server is down. Nothing was sent. | Check the address and port. |
| `Certificate verification failed. Local servers use a self-signed certificate, restart server.mjs with --insecure.` (on apply, then `The settings were not applied.`) | The server presents a self-signed certificate and the dev server was started without `--insecure`. On apply, nothing was sent. | Restart `server.mjs` with `--insecure`. |
| `Could not reach the server: no answer within 60 s.` (on apply, then `The settings were not applied.`) | On log in or download, the server took the request and said nothing for 60 s. | Check the server is healthy, then try again. |
| `Could not reach the server: <reason>.` (on apply, then `The settings were not applied.`) | The page could not reach the dev server itself, e.g. `server.mjs` was stopped. | Restart `server.mjs` and reload the page. |
| `The dev server could not read the request from the page.` (on apply, then `The settings were not applied.`) | The page's request was cut off before it reached the dev server. | Try again. |
| `The dev server failed while handling the request.` | A fault in `proxy.mjs` itself. On apply the page says `Outcome unknown: ...` instead, as the `PUT` may have gone out. | Try again; on apply, download the target device's settings first. |
| `The connection to the server was lost (...).` | On log in or download, the server dropped the connection. | Try again. |
| `Outcome unknown: the connection was lost after the settings were sent. Download the device's settings to check.` | The server dropped the connection, or said nothing for 60 s, after the `PUT` went out. | Download the target device's settings and compare before applying again. |
| `Login unauthorized (HTTP 401/403). Check the password, and note that a cloud account cannot log in here. It needs the OAuth2 flow.` | Wrong password, or a cloud account. | Use a local server account. |
| `Login failed: HTTP <n>.` | The server refused the login for a reason other than the password, e.g. a 5xx or a 3xx redirect. | Check the address and port, and that the server is healthy. |
| `Login failed: the response was not valid JSON.` or `... did not contain a token.` | `--server-host` points at something that is not a VMS server. | Check the address and port. |
| `Reading settings was refused (HTTP 401/403). This endpoint needs Power User or better.` (or `Applying settings was refused ...`) | The account is below Power User. | Use an account with Power User or better. |
| `Applying settings failed: HTTP 4xx. The settings were not applied. The target device may not be running this Engine.` | The target device is not running that Engine, or the settings don't match what its plugin expects. | Confirm the target has the same analytics plugin enabled, and that the engine ID is right for that device. |
| `Applying settings failed: HTTP 5xx. The server may have applied some of them; download the device's settings to check.` | The server failed part-way through the `PUT`. | Download the target device's settings and compare before applying again. |
| `... HTTP 3xx (redirect not followed).` (or `... HTTP 302 (redirect not followed).`) | The address answers with a redirect, e.g. a plain-HTTP port or a gateway. | Use the server's own HTTPS address and port. |
| `The server took the settings but the Engine reported errors:` | The `PUT` landed, but the Engine rejected the settings listed under it. | Fix those values in the file (or on the source device) and apply again. |
| `Reading settings failed: HTTP <n>.` | The server could not read the settings, e.g. a 404 for an engine or device ID it does not know. | Check the engine and device IDs. |
| `Reading settings failed: the server did not return a JSON object.` | The download answer was not a settings object. | Check the engine and device IDs, and the address. |
| `Refusing to apply without confirmation. This overwrites the target device's existing Device Agent settings.` | The guard did its job. | Type the target device ID exactly as entered above. |
| `Type <device ID> in the confirmation box to enable apply.` | The typed value did not match the target device ID. | Re-type it exactly. |
| `<file> is not valid JSON: <reason>.` | The chosen file is not a settings file this sample produced. | Run Download first, or check the file. |
| `<file> does not hold a JSON object.` | The file is JSON, but a list or a bare value, not a settings object. | Choose a file that Download produced. |
| `Warning: could not log out: <reason>.` under a success message or the Engine-errors block, e.g. `... HTTP 500.`, `... no answer within 60 s.`, `... no connection (ECONNREFUSED).` | The action finished; only ending the session failed. After any other failure the page shows only that failure. | Nothing to redo for the logout. The session expires on its own. |
| `ERROR: --insecure takes no value` (or `ERROR: Missing value for --port`) | A flag was given in the wrong form. | `--insecure` alone; `--port 8080`, `--server-host https://...`. |

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: sign in, download, apply. |
| `app.mjs` | DOM wiring only. Reads inputs, calls the client, writes results. |
| `nx-device-agent-settings-client.mjs` | All the API logic, framework free, so it can be tested offline. |
| `proxy.mjs` | The CORS forwarder. |
| `server.mjs` | Dev server: static files plus the proxy, on one port. |
| `test_nx_device_agent_settings_client.mjs` | Offline tests for the client (injected `fetch`). |
| `test_proxy.mjs` | Offline tests for the proxy (injected or loopback upstream) and the dev server's flags. |
| `package.json` | Name, `type: module`, and the `test` and `serve` scripts. No dependencies. |
