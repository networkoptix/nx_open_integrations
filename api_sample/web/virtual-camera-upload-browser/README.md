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

The progress log on the page reads like this:

```
Hashed 2750342 byte(s) (MD5 5RRVFA6vXjK2NxOQ0NDdVw==)
Created virtual device {a1b2c3d4-…}
Upload created (id footage.mkv, chunk 1048576 B)
Uploaded chunk 1/3
Uploaded chunk 2/3
Uploaded chunk 3/3
Upload confirmed complete
Lock acquired
Consume started
Consume progress: 40%
Consume progress: 100%
Released lock
```

> **Note:** Actual ingestion can only be confirmed against a **live server with
> virtual-camera support**. The offline tests verify the call sequence, the
> chunking, and the request payloads — not that a real server accepts the media.

## The v4 flow (matches the Python source)

The file is **uploaded to the server first**, with no lock needed for that part.
The device is only **locked while the upload is imported** into the archive (the
consume step), so the lock window stays short and other clients can use the
device the rest of the time.

```
1. POST   {server}/rest/v4/login/sessions  {username,password,setCookie:false}      -> { token }
2. POST   {server}/rest/v4/devices/*/virtual  {name}                                -> device id   [skip with an existing id]

   -- upload the file (no lock needed) --
3. POST   {server}/rest/v4/devices/{id}/virtual/uploads
            {items:[{filename, sizeB, md5, startTimeMs, durationMs, chunkSizeB}]}   -> server chunkSizeB + uploadId
4. PUT    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=<n>
            raw bytes, Content-Type: application/octet-stream
5. GET    {server}/rest/v4/devices/{id}/virtual/uploads/{uploadId}                  -> uploadProgressPercent must be 100

   -- import it into the archive (this part holds the lock) --
6. PATCH  {server}/rest/v4/devices/{id}/virtual/lock  {ttlMs}                       -> token at lockInfo.token
7. PATCH  {server}/rest/v4/devices/{id}/virtual/consume
            {token, uploadId, startTimeMs}                                          -> starts the import
8. PATCH  {server}/rest/v4/devices/{id}/virtual/extend  {ttlMs, token}              -> renews the lock + lockInfo.progress (0–100),
            repeated until progress reaches 100                                        polled every pollIntervalMs
9. PATCH  {server}/rest/v4/devices/{id}/virtual/release  {token}                    (always, once a lock is held)
+  DELETE {server}/rest/v4/login/sessions/<token>                                   (best-effort)
```

If anything fails **after** the upload was created, the page best-effort cancels
it — `DELETE /rest/v4/devices/{id}/virtual/uploads/{uploadId}` (valid while the
upload is uploading or consuming) — **before** releasing the lock, so a failed
run doesn't leave an orphaned upload/consume in progress on the server.

### Notes on the flow

- **`lock`, `consume` and `extend` are current, not deprecated.** Older copies
  of the OpenAPI spec marked them deprecated; the **current** spec does not, and
  `consume` is what actually imports an uploaded file into the archive. The
  chunk PUTs alone do **not** start the import.
- **Create-upload needs no lock.** Steps 3–5 carry no token at all. Only the
  import (steps 6–9) locks the device.
- **`durationMs` is optional.** The create-upload item is
  `{filename, sizeB, md5, startTimeMs, chunkSizeB}` plus `durationMs` when the
  page's "Clip duration" field is filled in. `startTimeMs` is declared at
  **create-upload** (it reserves the archive period) *and* again at **consume**
  (it triggers the import into that period). If `durationMs` is left blank, the
  server derives the clip's duration from the video file's own metadata; if that
  metadata is missing or unreadable, the archive period comes back as `0` and
  the footage won't appear on the timeline.
- **Lock token lives at `lockInfo.token`.** The v4 lock reply is
  `{ id, lockInfo: { token, progress, … } }`. We read `lockInfo.token`, and
  defensively fall back to a top-level `token` for older/edge shapes. The same
  `lockInfo.progress` field is what the `extend` poll reports.

The `*` in step 2 is the current-server wildcard — it is part of the path, not a
placeholder. The `uploadId` in steps 4/5/7 is the server-returned `uploadId`, or
the file's name if none is echoed.

## Poll timing (no form fields — module constants)

This house has **no CLI**, and the page deliberately keeps its current look, so
the consume-poll timing is not exposed as form fields. It lives in two exported
module constants in `nx-virtual-camera-client.mjs`:

| Constant | Default | Purpose |
|----------|---------|---------|
| `DEFAULT_POLL_INTERVAL_MS` | `2000` | Gap between `extend` polls while consume runs. |
| `DEFAULT_CONSUME_TIMEOUT_MS` | `300000` | Max wait for consume to reach 100% before giving up. |

Both are overridable per run through the existing options object:

```js
await uploadVideo(client, file, {
  name, startTimeMs, durationMs, deviceId,
  pollIntervalMs: 3000,      // override DEFAULT_POLL_INTERVAL_MS
  consumeTimeoutMs: 600000,  // override DEFAULT_CONSUME_TIMEOUT_MS
  onProgress: logLine,
});
```

`uploadVideo` also accepts `sleepFn` / `nowFn` so the poll loop can be driven by
a fake clock in tests — that is how the offline suite exercises the loop without
waiting. The consume progress itself needs no new UI: each poll emits a
`Consume progress: N%` message through the existing `onProgress` callback, which
`app.mjs` already pipes into the status log.

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
file's own metadata — and click **Upload footage**. Progress (hash, created id,
N chunks, upload confirmed, lock, consume progress, released) and any errors are
shown inline.

### How the proxy targets the server you type

Unlike the list-cameras sample, the target server is chosen on the **page**, so
the client encodes it into the route and `proxy.mjs` decodes it per request:

```
{baseUrl}/server/<encodeURIComponent("https://192.168.1.10:7001")>/rest/v4/...
        -> https://192.168.1.10:7001/rest/v4/...
```

The proxy forwards the **method** (including `PATCH` and `DELETE`), the **body**
(including raw `PUT` chunk bytes), and the **`Authorization: Bearer`** header for
every verb, and **always tolerates the self-signed cert** (a direct local server
practically always uses one). `--server-host` is optional and only prefills the
address field; `--insecure` is accepted for parity but is a no-op here (direct is
always insecure). `server.mjs` serves the static files and mounts the proxy on
**one port** (same-origin = no CORS). In production, front the Nx API with your
own same-origin backend / reverse proxy that adds auth, CORS, and a real cert.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The page: server address, login, device name, file input, start time, optional clip duration, upload button, progress log. |
| `app.mjs` | DOM wiring only — reads the form (incl. `<input type=file>`), runs the upload, streams progress. |
| `nx-virtual-camera-client.mjs` | The API logic (`NxVirtualCameraClient` + `uploadVideo` + `waitForConsume`). Imported by the page **and** the tests. |
| `md5.mjs` | Vendored pure-JS MD5 (Web Crypto has none). Returns base64 for the create-upload item. |
| `proxy.mjs` | The forwarder: decodes `/server/<encoded base>/…` and relays method/body/bearer. No static serving. |
| `server.mjs` | Dev server: serves the static demo + mounts the proxy. **This is what you run.** |
| `test_md5.mjs` | Offline MD5 tests against known vectors + a `crypto` cross-check. |
| `test_nx_virtual_camera_client.mjs` | Offline tests for the client/orchestration (`node:test`, fake `fetch`, fake clock). |
| `test_proxy.mjs` | Offline tests for route decoding + forwarding (stubbed global fetch). |
| `package.json` | `type: module`; `npm test`, `npm run serve`. No dependencies. |

## Run the tests

The API logic, the MD5, and the proxy routing are split out so they test
offline — no browser, no account, no network:

```bash
node --test test_md5.mjs test_nx_virtual_camera_client.mjs test_proxy.mjs   # or: npm test
```

(A bare `node --test` finds nothing here: the files are named `test_*.mjs`, not
`*.test.mjs`, so name them explicitly.)

**What the tests cannot cover:** a real footage ingest needs a live Nx server.
The offline suite exercises the full request *sequence* (with a fake fetch) and
proves the MD5, but it does not perform an actual upload, and it does not drive
a real `<input type="file">` (the browser file-picker / `File` object) — those
require manual testing against a live server in a browser.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Could not reach the API at /server/…` | The dev server isn't running, or the page was opened as a `file://` URL. | Run `node server.mjs` and open the printed `http://localhost:8080/`. |
| Browser console shows a CORS or certificate error | Something is calling the VMS server directly instead of through the proxy. | Every call must go through `{baseUrl}/server/<encoded base>/…`; keep `baseUrl` empty (same origin). |
| `Login unauthorized (HTTP 401/403)` | Wrong password, or this is a **cloud** user. | Use a **local** server account. |
| `Create virtual device failed` | Server build lacks virtual-camera support, or the account can't add devices. | Confirm the server supports virtual cameras and the account has admin rights. |
| `Chunk N upload failed` | The wrong `chunkSizeB`, or the proxy dropped the raw body. | The sample uses the server's returned `chunkSizeB`; check the dev server's console. |
| `Upload did not complete: server reports uploadProgressPercent=N` | A chunk was dropped or truncated in transit, so the server does not have all the bytes. The run fails **before** any lock, and the partial upload is cancelled. | Re-run (the MD5 and the upload are recomputed each time); check the network / the dev server's console. |
| `Consume did not reach 100% within Ns (last progress: P%)` | The import is slow (large file) or stuck server-side. The upload is cancelled and the lock released. | Pass a larger `consumeTimeoutMs` to `uploadVideo` (default `DEFAULT_CONSUME_TIMEOUT_MS` = 300000 ms); check the server logs if it keeps happening. |
| `Lock virtual device failed` | The device is already locked by another client. | Wait for the existing lock's TTL to expire, or pass a longer `ttlMs`. |
| Consume reaches 100% but footage doesn't appear, and `durationMs` reads `0` | The "Clip duration" field was blank and the server couldn't read the duration from the file's own metadata. A zero-length archive period is invisible on the timeline. | Re-run with an explicit clip duration in milliseconds. |
| Footage doesn't appear / import fails | `startTimeMs` overlaps existing footage, or the md5 didn't match. | Pick a non-overlapping start time; re-run so the md5 is recomputed. |
