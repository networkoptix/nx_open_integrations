# Play camera video in the browser, with an HTML5 `<video>` tag

This sample plays an Nx camera's **live (or archive) video** in a plain
`<video>` element on a web page — no app, no framework, no build step. It
supports **both** auth modes: **Direct to Media Server** (connect to one media
server by IP:port with a LOCAL server account, all entered on the page), or
**Pull Stream via Cloud Relay** (a cloud account reaching the site over the
relay). The whole point is a question teams ask constantly: *"how do I put an
authenticated Nx camera stream in a normal `<video>` tag?"*

For the **lower-latency** live alternative (WebRTC, sub-second), see
[`../webrtc-live-view`](../webrtc-live-view). This `media.webm` approach is
simpler and dependency-free, but plays with more buffering delay than WebRTC.

## What it shows

- The Nx media endpoint: `GET /rest/v4/devices/{id}/media.webm` with a bearer
  token. `webm` is the container an HTML5 `<video>` plays progressively for
  live.
- How to **authenticate a `<video>` tag**, which can't send an `Authorization`
  header (see below).
- Both auth flows in one client: a direct local-server login (the server address
  and local credentials are entered on the page) and cloud OAuth2 with a
  site-scoped token.

## The media endpoint

```
GET {base}/rest/v4/devices/{id}/media.webm   (Authorization: Bearer <token>)
    ?stream=primary|secondary    hi/lo-res; this sample defaults to secondary
    &positionMs=<epoch ms>      archive start time; OMIT for live
    &durationMs=<ms>            optional clip length
```

`{base}` is the media server you entered on the page (direct) or the site relay
`https://<siteId>.relay.vmsproxy.com` (cloud). We ignore the endpoint's many
transcoding parameters and use just `stream` and (for archive) `positionMs`.

## The key design: authenticating a `<video>` tag via the proxy

A `<video src="…">` is a plain GET the browser issues on its own. **It cannot
carry an `Authorization` header.** So we can't just point it at a bearer-only
endpoint. The flow this sample uses instead:

1. **Log in through the proxy** with a normal `fetch` (which *can* send and read
   JSON) and get the bearer token in JavaScript — `NxMediaClient.login()`.
2. **Point `<video>.src` at a SAME-ORIGIN proxy URL** that carries the token as
   a query param `auth=<token>` — `NxMediaClient.buildMediaUrl()`:

   ```
   direct:  /server/<encoded-base>/rest/v4/devices/<id>/media.webm?stream=secondary&auth=<token>
            where <encoded-base> = encodeURIComponent("https://192.168.1.10:7001")
   cloud:   /relay/<siteId>/rest/v4/devices/<id>/media.webm?stream=secondary&auth=<token>
            (+ &positionMs=<ms> for archive)
   ```

   For Direct mode the first `/server/` path segment is the **URI-encoded media
   server base URL** (scheme+host+port) you typed on the page; the proxy decodes
   it and forwards there.

3. **The proxy converts that param into a header.** Before forwarding, it
   **removes** `auth` from the upstream URL and instead sends
   `Authorization: Bearer <token>` to Nx, then **streams** the video body
   straight back to the browser:

   ```js
   const { path, token } = extractAuth(subPath);   // strip ?auth
   if (token) headers["authorization"] = `Bearer ${token}`;
   // … fetch(upstream) … then pipe the body, never buffer it:
   Readable.fromWeb(upstream.body).pipe(res);
   ```

So the token only ever travels **same-origin** to your local proxy. Nx receives
a normal bearer header — the token is **never** sent to Nx as a URL parameter.
For cloud mode the proxy also follows the relay's **307** redirect server-side,
**re-attaching** the bearer across the hop (a browser refuses to do this).

## Read this first: CORS (and self-signed TLS)

A browser will **block** `fetch()` to the Nx Cloud, the relay, or a local server
— they're different origins and don't return the CORS headers a browser
requires. A local server also presents a **self-signed** TLS certificate the
browser refuses outright. You **cannot** disable CORS from JavaScript; it's a
browser rule, not a bug in the sample. (See
[`../rest-list-cameras-browser`](../rest-list-cameras-browser) for a deeper CORS
walkthrough.)

### The solution: run the included dev server (one command)

This folder ships a tiny zero-dependency dev server, split by concern:

- **`proxy.mjs`** — the CORS forwarder only. Relays `/cloud/*`,
  `/relay/<siteId>/*`, and `/server/<encoded-base>/*` from outside the browser;
  performs the relay 307 + bearer re-attach hop; converts the `<video>` `?auth`
  param into a bearer header; and **streams** the video body. For Direct mode it
  decodes the user-provided server base from the first path segment and forwards
  there, always tolerating the server's self-signed cert. No static serving —
  reusable by other web samples.
- **`server.mjs`** — the static file server for the demo. It mounts the proxy so
  both run on **one port** (same-origin = no CORS). **This is what you run.**

```bash
cd web/media-http-stream

# Both modes work with NO required flags — just run it:
node server.mjs
#   --cloud-host https://nxvms.com   (default)
#   --port 8080                      (default)

# Optional: prefill the Direct-mode "Server address" field on the page:
node server.mjs --server-host https://192.168.1.10:7001

# Then open the printed URL:
#   http://localhost:8080/
```

In **Direct to Media Server** mode you type the server's IP/host and port
(scheme included, e.g. `https://192.168.1.10:7001`) and the **local** server
account **on the page** — the server is no longer a startup flag. A self-signed
TLS cert is normal for a local server, so the Direct upstream **always** accepts
one (this is a localhost dev tool). `--server-host` is now only an optional
prefill for that field.

## Using the page

Pick an auth mode at the top; the form adapts:

| Mode | Fields you enter |
|------|------------------|
| **Direct to Media Server** | **Server address** (`https://<ip>:<port>`), **local** server username, **local** server password, **camera/device ID** |
| **Pull Stream via Cloud Relay** | **Cloud Site ID** (UUID), cloud email, cloud password (+ MFA), **camera/device ID** |

In Direct mode the **Server address** and the username/password are the media
server's own IP:port and a **local** server account — *not* a cloud account.
Both modes also let you choose the **stream** (secondary = low-res/lighter,
primary = high-res) and an optional **archive position** (an ISO time or epoch
ms; leave blank to play **live**). Click **Play** to log in and start the video;
**Stop** clears it and revokes the token.

### The flags

| Flag | What it does |
|------|--------------|
| `--server-host https://<ip>:7001` | **Optional.** Prefills the Direct-mode **Server address** field on the page. Not required — you can type the address on the page instead. |
| `--cloud-host https://nxvms.com` | The cloud origin **cloud** mode uses (default shown). |
| `--insecure` | Lets the proxy accept a **self-signed** TLS cert for the **cloud/relay** upstreams too. Implemented with an Undici `Agent({ connect: { rejectUnauthorized: false } })` so only the proxy's upstream fetch is affected. The **Direct** upstream always accepts a self-signed cert without this flag, since local servers normally present one. |

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: mode toggle, adaptive login form, stream/archive controls, and the `<video>`. |
| `app.mjs` | DOM wiring only — reads the form, calls the client, points `<video>` at the media URL. |
| `nx-media-client.mjs` | The API logic (`NxMediaClient`): login (both modes) + `buildMediaUrl()`. Imported by the page **and** the tests. |
| `proxy.mjs` | The CORS forwarder (a module): `/cloud/*`, `/relay/<id>/*`, `/server/<encoded-base>/*` (decodes the user-provided server base from the path); auth→bearer conversion; 307 hop; body streaming. No static serving. |
| `server.mjs` | Dev server: serves the static demo + mounts the proxy. **This is what you run.** |
| `test_nx_media_client.mjs` | Offline tests for the client (`node:test`, fake `fetch`). |
| `test_proxy.mjs` | Offline tests for the proxy: route dispatch, auth→bearer conversion, the 307 hop, body streaming (fake upstream, no network). |
| `package.json` | `type: module`; `npm test`, `npm run serve`. No dependencies. |

## Run the tests

The API logic and the proxy's forwarding rules test offline — no browser, no
account, no network:

```bash
node --test test_nx_media_client.mjs test_proxy.mjs   # or: npm test
```

What the tests **don't** cover: the real video actually rendering. Just like the
[`../webrtc-live-view`](../webrtc-live-view) sample, that needs a live camera, a
real account, and a browser, so it can only be checked by running the sample for
real. The tests verify everything *around* the video — URL building, the auth
flows, and that the proxy turns `?auth=<token>` into a bearer header and streams
the body — but please verify end-to-end playback against your own system.
