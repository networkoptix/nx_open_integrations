# Live camera video in the browser, with WebRTC

This sample logs in to Nx Cloud, shows the list of cameras on your site, and
plays **live video** from the camera you pick — all in a plain web page, no app
to install. "How do I show a live Nx camera on my own web page?" is one of the
most common questions, so this README explains it slowly and assumes no prior
WebRTC knowledge. If you just want to run it, jump to [Quick start](#quick-start).

---

## What you'll end up with

A web page with a login box. After you log in, you get a drop-down of your
cameras and a **Play** button. Press Play and the live picture appears in a
video player on the page.

---

## The 30-second mental model

There are **two very different connections** happening, and understanding the
split is the key to this whole sample:

1. **The "paperwork" calls — logging in and listing cameras.** These are
   ordinary web requests (HTTP). Browsers refuse to let a web page make these
   calls directly to Nx Cloud for security reasons (this is called **CORS** —
   explained below). So this sample ships a tiny local helper program (a
   "proxy") that makes those calls *for* the page.

2. **The live video itself.** This does **not** go through the proxy. Video uses
   a technology called **WebRTC**, which opens its own special connection
   straight from your browser to your site. That kind of connection is **not**
   blocked by CORS, so the video flows directly.

So: **login + camera list = through the local proxy. Live video = direct.**
You don't have to do anything special for that split — the code handles it — but
it explains why you start a little server before opening the page.

---

## What is WebRTC (in plain English)?

WebRTC is the same technology video-call apps use to send live video between
browsers with very low delay. Instead of the browser repeatedly asking a server
"any new video yet?", WebRTC sets up a direct, continuous pipe and the video
just streams down it. Nx uses WebRTC so you can watch a camera live, in a
browser, with almost no lag.

Setting up that pipe by hand is complicated (it involves a back-and-forth
"handshake" called *signaling*, plus *ICE* for finding a network path). You do
**not** write any of that yourself. Network Optix publishes a library —
[`@networkoptix/webrtc-stream-manager`](https://www.npmjs.com/package/@networkoptix/webrtc-stream-manager)
— that does all of it. This sample just hands the library three things and
points the result at a `<video>` tag:

- **which site** (your Site ID),
- **which camera** (picked from the drop-down),
- **a token** proving you're allowed to watch (you get this automatically when
  you log in).

---

## What is CORS, and why the proxy?

CORS ("Cross-Origin Resource Sharing") is a browser safety rule. A web page
served from one place is, by default, **not allowed to read responses** from a
different place (a different "origin") unless that other place explicitly opts
in with special headers. Nx Cloud doesn't send those headers to arbitrary web
pages, so a browser blocks the login and camera-list calls. You'd see an error
like *"... has been blocked by CORS policy"*.

The fix is the included **proxy** (`proxy.mjs`, run by `server.mjs`). It runs on
your own computer, serves the web page, and forwards the login/list calls to Nx
Cloud from *outside* the browser, where the CORS rule doesn't apply. Everything
the page talks to is then "same place," so the browser is happy. (The live video
skips all this because WebSockets/WebRTC aren't CORS-restricted.)

This is exactly the same proxy used by the sibling sample
[`../rest-list-cameras-browser`](../rest-list-cameras-browser); see that README
for a deeper CORS walkthrough.

---

## Quick start

You need **Node.js 18 or newer** installed. Nothing else to install — the WebRTC
library is loaded automatically from a CDN when the page runs.

```bash
cd web/webrtc-live-view

# 1. Start the local server (it serves the page AND proxies the HTTP calls).
node server.mjs
#    options: --cloud-host https://nxvms.com   (default)
#             --insecure                        (only for a local/self-signed site)

# 2. Open the URL it prints, e.g.:
#    http://localhost:8080/
```

In the page:

1. Enter your **Cloud Site ID** (a UUID — find it in the Nx desktop client),
   your **cloud email**, and **password** (and an **MFA code** only if your
   account uses two-factor login). Click **Log in & load cameras**.
2. Pick a camera from the drop-down and click **Play**. The live video appears.
3. **Stop** ends the stream.

That's it. You never type a server address or token — the page gets the token
from your login and works out the rest from the Site ID.

---

## How the code is organized

| File | What it does |
|------|--------------|
| `index.html` | The page: login form, camera drop-down, and the `<video>`. |
| `app.mjs` | DOM wiring only: login → fill the drop-down → Play/Stop. |
| `nx-cloud-client.mjs` | The login + list-cameras logic (shared with the REST browser sample). |
| `webrtc-view.mjs` | The live-video logic: a small wrapper around the Nx WebRTC library. |
| `proxy.mjs` | The CORS forwarder for the HTTP calls (login/list). No static serving. |
| `server.mjs` | The local dev server: serves the page **and** mounts the proxy. **Run this.** |
| `test_*.mjs` | Offline tests (no account, no network) — see [Tests](#tests). |

The interesting new file is **`webrtc-view.mjs`**. In plain terms it:

1. builds the small config the library wants (site relay address; then site +
   camera + token),
2. loads the library (from `https://esm.sh/@networkoptix/webrtc-stream-manager`),
3. calls `StreamManager.configure(...)` then `.connect(...)`,
4. listens for the library's `track` event and sets `video.srcObject` to the
   incoming stream — that single line is what makes the picture appear.

---

## A note on dependencies and the CDN

The previous browser sample was truly dependency-free. This one is **build-free
but not dependency-free**: the Nx WebRTC library is a real package that itself
depends on `rxjs`, so the page loads it at runtime from **esm.sh** (a CDN that
serves npm packages as browser-ready modules and resolves those dependencies for
you). The exact version is pinned in `webrtc-view.mjs`
(`@networkoptix/webrtc-stream-manager@0.1.29`).

If you'd rather not rely on a CDN, you can `npm install` the package and a
bundler (Vite, esbuild, …) and point the import at your local build instead —
but that adds a build step, which this sample intentionally avoids.

---

## Tests

The login/list logic and our WebRTC *wiring* are covered by offline tests that
use a fake video element and a fake stand-in for the library — so they run with
no account, no network, and no real camera:

```bash
node --test test_nx_cloud_client.mjs test_proxy.mjs test_webrtc_view.mjs
# or simply:
npm test
```

What the tests **don't** cover: the real video actually rendering. That needs a
live camera, a real account, and a browser, so it can only be checked by running
the sample for real. The WebRTC wiring follows the library's documented v0.1.29
API, but please verify end-to-end against your own system.

---

## Troubleshooting

| Symptom | Likely cause & fix |
|---|---|
| *"blocked by CORS policy"* in the console, or login does nothing | The server isn't running, or you opened `index.html` directly. Start it with `node server.mjs` and open the printed `http://localhost:8080/`. |
| **Login fails (HTTP 401)** | Wrong email/password. Confirm you can log in at nxvms.com. 2FA accounts need the MFA code. |
| Camera list loads, but **Play shows nothing** | The video path is direct WebRTC to the relay. Check the browser console for errors; confirm the camera is online; some networks block the peer-to-peer connection. Try a different camera or network. |
| **Black video with a spinner** | The handshake worked but media hasn't arrived yet, or the camera has no current stream. Give it a few seconds; check the camera in the Nx client. |
| **The library fails to load** | The page loads it from esm.sh; check your network allows that CDN, or switch to a local bundled copy (see the dependencies note above). |
| Local/self-signed site | Start the server with `--insecure` so the proxy will talk to a self-signed relay (lab use only). |

---

## Going further

- Archive playback (seek to a past time) — the library's `connect()` accepts a
  `position` in milliseconds, and connections expose `updatePosition()` /
  `updateSpeed()`.
- Stream quality — pass `targetStream: "HIGH" | "LOW"` instead of `"AUTO"`.
- Multiple cameras at once — call `startLiveView()` for several `<video>`
  elements; the library shares one manager instance.
