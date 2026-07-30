# Virtual camera — create & upload footage, in the browser

Front-end (browser) counterpart of
[`../../python/virtual-camera-upload`](../../python/virtual-camera-upload), on
the latest **`/rest/v4`** API. A plain HTML page creates a **virtual camera** on
**one Nx VMS server** and uploads a chosen video file into its archive as
recorded footage — no framework, no build step, no npm dependencies.

A virtual camera has no real RTSP source; you push it pre-recorded media and the
server ingests it as if it had been captured at the start time you give.

This is the **DIRECT** variant: the page talks to a single VMS server you type
in (not the cloud, no relay).

## The corrected v4 flow (matches the Python source)

```
1. POST   {server}/rest/v4/login/sessions  {username,password,setCookie:false}      -> { token }
2. POST   {server}/rest/v4/devices/*/virtual  {name}                                -> device id   [skip with an existing id]
3. PATCH  {server}/rest/v4/devices/{id}/virtual/lock  {ttlMs}                        -> token at lockInfo.token
4. POST   {server}/rest/v4/devices/{id}/virtual/uploads
            {items:[{filename, sizeB, md5, startTimeMs, chunkSizeB}]}                -> server chunkSizeB + uploadId
5. PUT    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=<n>
            raw bytes, Content-Type: application/octet-stream
6. GET    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}                   -> import status
7. PATCH  {server}/rest/v4/devices/{id}/virtual/release  {token}                     (always, even on error)
+  DELETE {server}/rest/v4/login/sessions/<token>                                    (best-effort)
```

### What's "corrected" here

- **No `consume` call.** `PATCH .../virtual/consume` is **deprecated** and is
  **not** used. Completing the chunk PUTs to `.../virtual/uploads/{uploadId}`
  starts the import automatically. We then **GET** that same endpoint (step 6) to
  read status.
- **`durationMs` is optional.** The create-upload item is
  `{filename, sizeB, md5, startTimeMs, chunkSizeB}` plus `durationMs` when the
  page's "Clip duration" field is filled in. `startTimeMs` is declared at
  **create-upload** (step 4), not at a separate step. If `durationMs` is left
  blank, the server derives the clip's duration from the video file's own
  metadata; if that metadata is missing or unreadable, the archive period comes
  back as `0` and the footage won't appear on the timeline.
- **Lock token lives at `lockInfo.token`.** The v4 lock reply is
  `{ id, lockInfo: { token, … } }`. We read `lockInfo.token`, and defensively
  fall back to a top-level `token` for older/edge shapes.

The `*` in step 2 is the current-server wildcard — it is part of the path, not a
placeholder. The `uploadId` in steps 5/6 is the server-returned `uploadId`, or
the file's name if none is echoed.

## The browser MD5 problem (why we vendor `md5.mjs`)

The create-upload item **requires** an `md5` field (base64 of the file's MD5
digest). The browser's Web Crypto (`crypto.subtle.digest`) supports SHA family
hashes but **has no MD5**. To keep this sample's *"no npm install"* promise, we
**vendor** a small, self-contained pure-JS MD5 in
[`md5.mjs`](md5.mjs) (RFC 1321). The page reads the selected file once with
`file.arrayBuffer()`, computes `md5Base64(...)`, and slices the same bytes per
chunk with `Uint8Array.subarray`.

`md5.mjs` is proven correct in `test_md5.mjs` against the canonical vectors —
e.g. `md5("") = d41d8cd9…427e` (base64 `1B2M2Y8AsgTpgAmY7PhCfg==`) and
`md5("abc") = 90015098…7f72` — plus a cross-check against Node's `crypto` across
the 56/64-byte padding boundaries.

## Read this first: CORS + self-signed TLS (why a plain page won't reach the server)

A browser will **block** `fetch()` to a local Nx server because (1) it is a
different origin and sends no CORS headers, and (2) it almost always presents a
**self-signed TLS certificate** the browser refuses. You can't fix either from
page JavaScript — it's browser security, not a bug.

### The solution: run the included dev server (one command)

```bash
cd web/virtual-camera-upload-browser

node server.mjs
#   --server-host https://192.168.1.10:7001   (optional: only PREFILLS the page field)
#   --port 8080                                (default shown)

# Then open the printed URL:
#   http://localhost:8080/
```

On the page, enter the **Server address** (`https://ip:port`), a **local**
server **username/password**, a **device name**, pick a **video file**, set the
**archive start time** (defaults to now), optionally a device id, optionally a
**clip duration (ms)** — leave it blank to let the server derive it from the
file's own metadata — and click **Upload footage**. Progress (created id, lock,
N chunks, status, released) and any errors are shown inline.

### How the proxy targets the server you type

Unlike the list-cameras sample, the target server is chosen on the **page**, so
the client encodes it into the route and `proxy.mjs` decodes it per request:

```
{baseUrl}/server/<encodeURIComponent("https://192.168.1.10:7001")>/rest/v4/...
        -> https://192.168.1.10:7001/rest/v4/...
```

The proxy forwards the **method**, the **body** (including raw `PUT` chunk
bytes), and the **`Authorization: Bearer`** header for every verb, and **always
tolerates the self-signed cert** (a direct local server practically always uses
one). `--server-host` is optional and only prefills the address field;
`--insecure` is accepted for parity but is a no-op here (direct is always
insecure). `server.mjs` serves the static files and mounts the proxy on **one
port** (same-origin = no CORS). In production, front the Nx API with your own
same-origin backend / reverse proxy that adds auth, CORS, and a real cert.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: server address, login, device name, file input, start time, optional clip duration, upload button, progress log. |
| `app.mjs` | DOM wiring only — reads the form (incl. `<input type=file>`), runs the upload, streams progress. |
| `nx-virtual-camera-client.mjs` | The API logic (`NxVirtualCameraClient` + `uploadVideo`). Imported by the page **and** the tests. |
| `md5.mjs` | Vendored pure-JS MD5 (Web Crypto has none). Returns base64 for the create-upload item. |
| `proxy.mjs` | The forwarder: decodes `/server/<encoded base>/…` and relays method/body/bearer. No static serving. |
| `server.mjs` | Dev server: serves the static demo + mounts the proxy. **This is what you run.** |
| `test_md5.mjs` | Offline MD5 tests against known vectors + a `crypto` cross-check. |
| `test_nx_virtual_camera_client.mjs` | Offline tests for the client/orchestration (`node:test`, fake `fetch`). |
| `test_proxy.mjs` | Offline tests for route decoding + forwarding (stubbed global fetch). |
| `package.json` | `type: module`; `npm test`, `npm run serve`. No dependencies. |

## Run the tests

The API logic, the MD5, and the proxy routing are split out so they test
offline — no browser, no account, no network:

```bash
node --test test_md5.mjs test_nx_virtual_camera_client.mjs test_proxy.mjs   # or: npm test
```

**What the tests cannot cover:** a real footage ingest needs a live Nx server.
The offline suite exercises the full request *sequence* (with a fake fetch) and
proves the MD5, but it does not perform an actual upload, and it does not drive
a real `<input type="file">` (the browser file-picker / `File` object) — those
require manual testing against a live server in a browser.
