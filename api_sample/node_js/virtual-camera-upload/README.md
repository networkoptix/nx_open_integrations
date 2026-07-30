# Virtual camera — create & upload recorded footage (Node.js)

Creates a **virtual camera** on **one VMS server** and uploads a local video
file into its archive as recorded footage. A virtual camera has no live source;
you push it pre-recorded media and the server ingests it as if it had been
captured at the time you specify.

Node.js port of [`../../python/virtual-camera-upload`](../../python/virtual-camera-upload).
Zero dependencies: built-in `fetch` (Node 18+), `node:crypto`, `node:fs`, and
`node:test`. ESM (`.mjs`). The file is read in chunks, so a large clip is never
slurped into memory all at once.

```
Logged in to https://192.168.1.10:7001 as admin
  Created virtual device {a1b2c3d4-...}
  Lock acquired
  3 chunk(s) uploaded (1048576 B each)
  Upload complete; server is importing footage at 1718496000000ms
  Released
Done. Uploaded 2750342 bytes to device {a1b2c3d4-...} as archive starting 1718496000000ms.
```

> **Note:** Actual ingestion can only be confirmed against a **live server with
> virtual-camera support**. The offline tests verify the call sequence, the
> chunking, and the request payloads — not that a real server accepts the media.

## What the code does (Nx 5.0+ bearer-token auth, /rest/v4)

All calls go to the server base URL with `Authorization: Bearer <token>`.

1. **Log in** — `POST /rest/v4/login/sessions` with `{username, password}` → `{"token": ...}`.
2. **Create the virtual device** — `POST /rest/v4/devices/*/virtual` with
   `{"name": ...}` → the new device (read its `id`). *Skipped if `--device-id` is given.*
   The `*` is the current-server wildcard and is part of the path.
3. **Lock the device** — `PATCH /rest/v4/devices/{id}/virtual/lock` with
   `{"ttlMs": ...}` → the lock token, returned at **`lockInfo.token`** (the reply
   is `{id, lockInfo:{userId, token, ttlMs, progress}}`).
4. **Create the upload** — `POST /rest/v4/devices/{id}/virtual/uploads` with
   `{"items": [{filename, sizeB, md5, startTimeMs, chunkSizeB}]}`. The response
   echoes the `chunkSizeB` the server wants — the sample uses that if present.
   `md5` is the base64 MD5 of the full file. **`startTimeMs` is declared here**
   (where the footage lands on the timeline). **`durationMs` is optional** — pass
   `--duration-ms` if you know the clip length; if omitted, the server derives
   the duration from the video file's own metadata. If that metadata is missing
   or unreadable and no `durationMs` was sent, the archive period comes back as
   `0` and the footage will not appear on the timeline (see Troubleshooting).
5. **Upload the bytes** — for each zero-based chunk `n`,
   `PUT /rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=n` with the raw
   chunk bytes and `Content-Type: application/octet-stream`. `uploadId` is the
   server-returned id (or the file's name).
6. **Check status** — `GET /rest/v4/devices/{id}/virtual/uploads/{uploadId}`.
   There is **no separate consume call**: `PATCH /rest/v4/devices/{id}/virtual/consume`
   is **deprecated**, and the import starts automatically once all chunks reach
   the uploads endpoint. This GET reports the import progress.
7. **Release the lock** — `PATCH /rest/v4/devices/{id}/virtual/release` with
   `{"token": <lock>}` (always run, even on error, so the lock is freed).

The session token is also released with `DELETE /rest/v4/login/sessions/<token>`
on the way out.

## Prerequisites

- Node.js 18+ (for built-in `fetch` and `node:test`).
- Network access to an Nx VMS server with virtual-camera support, and a
  **local** server account (username/password). Cloud users use a different
  login flow — see [`../rest-list-cameras`](../rest-list-cameras).
- A local video file to upload.
- The tests need neither a server nor a network.

## Configure

Uses the `NX_SERVER_*` variables, shared with the other `rest-` samples in the
template at the repo root:

```bash
cp ../../.env.example ../../.env   # then edit the NX_SERVER_* lines
```

- `NX_SERVER_HOST` — e.g. `https://192.168.1.10:7001` (include `https://` and the
  port), or a relay address `https://<siteId>.relay.vmsproxy.com`.
- `NX_SERVER_USER`, `NX_SERVER_PASSWORD` — a **local** server account.

Config precedence is **CLI flag > environment variable > `.env`**. Point at a
`.env` file with `--dotenv <path>` (named `--dotenv`, not `--env-file`, which is
a Node built-in flag).

## Run

```bash
# Local servers almost always use a self-signed cert, so --insecure is normal here.
# Create a new virtual camera named "Front Door" and upload a clip into it:
node virtual_camera_upload.mjs \
  --dotenv ../../.env --insecure \
  --file ./footage.mkv \
  --name "Front Door" \
  --start-time 2026-06-16T00:00:00Z

# Upload to an EXISTING virtual device (skips the create step):
node virtual_camera_upload.mjs \
  --dotenv ../../.env --insecure \
  --file ./footage.mkv \
  --device-id '{a1b2c3d4-...}'

# Or fully on the command line:
node virtual_camera_upload.mjs \
  --server-host https://192.168.1.10:7001 \
  --user admin \
  --password 'your-password' \
  --file ./footage.mkv \
  --start-time 1718496000000 \
  --ttl 600 \
  --chunk-size 2097152 \
  --insecure
```

## Run the tests

```bash
node --test test_virtual_camera_upload.mjs
```

## CLI flags

| Flag | Required | Default | Purpose |
|------|----------|---------|---------|
| `--file` | yes | — | Local video file to upload. |
| `--name` | no | `Virtual Camera` | Name for the new virtual device. |
| `--device-id` | no | — | Upload to an existing virtual device (skips create). |
| `--start-time` | no | now | Archive start: ISO 8601 (e.g. `2026-06-16T00:00:00Z`) or epoch ms. |
| `--duration-ms` | no | — | Clip length in **milliseconds**. Optional: if omitted, the server derives it from the video file's own metadata. |
| `--ttl` | no | `300` | Lock time-to-live, in seconds. |
| `--chunk-size` | no | `1048576` | Requested chunk size in bytes (the server may override). |
| `--server-host` | yes* | `NX_SERVER_HOST` | Server URL, e.g. `https://192.168.1.10:7001`. |
| `--user` | yes* | `NX_SERVER_USER` | Local server username. |
| `--password` | yes* | `NX_SERVER_PASSWORD` | Local server password. |
| `--dotenv` | no | `.env` | Path to a `.env` file (not `--env-file`). |
| `--insecure` | no | off | Skip TLS verification (usual for local servers). |

\* Required, but may come from the environment / `.env` instead of the flag.

`--insecure` prefers a per-client undici `Agent` dispatcher (scoped to this
client only); if undici can't be imported it falls back to the process-wide
`NODE_TLS_REJECT_UNAUTHORIZED=0` escape hatch.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `fetch failed` / certificate error | Local server uses a self-signed cert. | Add `--insecure` (expected for local servers). |
| `Could not reach https://...` | Wrong IP/port, server down, or firewall. | Confirm host + port `7001`, and that the server is reachable. |
| `Login unauthorized (HTTP 401/403)` | Wrong password, or this is a **cloud** user. | Use a local account. See [`../rest-list-cameras`](../rest-list-cameras). |
| `Create virtual device failed` | Server build lacks virtual-camera support, or the account can't add devices. | Confirm the server supports virtual cameras and the account has admin rights. |
| `Lock virtual device failed` | The device is already locked by another client. | Wait for the existing lock's TTL to expire, or use a longer `--ttl`. |
| `Chunk N upload failed` | The wrong `chunkSizeB` or a truncated read. | The sample uses the server's returned `chunkSizeB`; check disk/network. |
| Status shows as completed and/or the API response shows `uploadProgressPercent: 100`, but footage doesn't appear, and `durationMs` reads `0` | No `--duration-ms` was passed, and the server couldn't read the duration from the file's own metadata (e.g. unusual container, corrupted header). A zero-length archive period is invisible on the timeline. | Re-run with an explicit `--duration-ms <milliseconds>`. |
| `Upload status failed` / footage doesn't appear | `startTimeMs` overlaps existing footage, or the md5 didn't match. | Pick a non-overlapping `--start-time`; re-run so md5 is recomputed. |
| Raw `http://` refused | Bearer auth requires HTTPS. | Use `https://` (and the secure port). |

## Files

| File | Purpose |
|------|---------|
| `virtual_camera_upload.mjs` | The sample. Run it directly. |
| `test_virtual_camera_upload.mjs` | Offline tests (mocked `fetch`). |
| `package.json` | Zero-dependency, ESM, `node --test` script. |

## Related samples

- [`../rest-list-cameras`](../rest-list-cameras) — log in to one server and list its cameras (the direct-server auth this sample mirrors).
- [`../media-http-stream`](../media-http-stream) — save a video clip from a camera to a file (the reverse direction: pulling media out).
- [`../../python/virtual-camera-upload`](../../python/virtual-camera-upload) — the Python original.
