# Virtual camera — create & upload recorded footage (Node.js)

Creates a **virtual camera** on **one VMS server** and uploads a local video
file into its archive as recorded footage. A virtual camera has no live source;
you push it pre-recorded media and the server ingests it as if it had been
captured at the time you specify.

Zero dependencies: built-in `fetch` (Node 18+), `node:crypto`, `node:fs`, and
`node:test`. ESM (`.mjs`). The file is read in chunks, so a large clip is never
slurped into memory all at once.

```
Logged in to https://192.168.1.10:7001 as admin
  Created virtual device {a1b2c3d4-...}
  3 chunk(s) uploaded (1048576 B each)
  Upload confirmed complete
  Lock acquired
  Consume started
  Consume progress: 40%
  Consume progress: 100%
  Released
Done. Uploaded 2750342 bytes to device {a1b2c3d4-...} as archive starting 1718496000000ms.
```

> **Note:** Actual ingestion can only be confirmed against a **live server with
> virtual-camera support**. The offline tests verify the call sequence, the
> chunking, and the request payloads — not that a real server accepts the media.

## What the code does (Nx 5.0+ bearer-token auth, /rest/v4)

All calls go to the server base URL with `Authorization: Bearer <token>`.

The file is **uploaded to the server first**, with no lock needed for that part.
The device is only **locked while the upload is imported** into the archive
(the consume step), so the lock window stays short and other clients can use
the device the rest of the time.

1. **Log in** — `POST /rest/v4/login/sessions` with `{username, password}` → `{"token": ...}`.
2. **Create the virtual device** — `POST /rest/v4/devices/*/virtual` with
   `{"name": ...}` → the new device (read its `id`). *Skipped if `--device-id` is given.*
   The `*` is the current-server wildcard and is part of the path.
3. **Create the upload** — `POST /rest/v4/devices/{id}/virtual/uploads` with
   `{"items": [{filename, sizeB, md5, startTimeMs, chunkSizeB}]}`. The response
   echoes the `chunkSizeB` the server wants — the sample uses that if present —
   and the server-assigned `uploadId`. `md5` is the base64 MD5 of the full file.
   `startTimeMs` reserves the archive period here, and is passed again at
   consume (step 7) to trigger the actual import. **`durationMs` is optional** —
   pass `--duration-ms` if you know the clip length; if omitted, the server
   derives the duration from the video file's own metadata. If that metadata is
   missing or unreadable and no `durationMs` was sent, the archive period comes
   back as `0` and the footage will not appear on the timeline (see
   Troubleshooting).
4. **Upload the bytes** — for each zero-based chunk `n`,
   `PUT /rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=n` with the raw
   chunk bytes and `Content-Type: application/octet-stream`. `uploadId` is the
   server-returned id (or the file's name).
5. **Check the upload status** — `GET /rest/v4/devices/{id}/virtual/uploads/{uploadId}`.
   Confirms `uploadProgressPercent` reached `100`, i.e. the server has all the
   bytes, before anything is locked or imported.
6. **Lock the device** — `PATCH /rest/v4/devices/{id}/virtual/lock` with
   `{"ttlMs": ...}` → the lock token, returned at **`lockInfo.token`** (the reply
   is `{id, lockInfo:{userId, token, ttlMs, progress}}`).
7. **Start the import (consume)** — `PATCH /rest/v4/devices/{id}/virtual/consume`
   with `{"token": <lock>, "uploadId": ..., "startTimeMs": ...}`. Starts
   importing the already-uploaded file as camera footage.
8. **Poll progress (extend)** — `PATCH /rest/v4/devices/{id}/virtual/extend`
   with `{"ttlMs": ..., "token": <lock>}`, called repeatedly (every
   `--poll-interval` seconds). Each call **renews the lock** and returns
   `lockInfo.progress` (0–100); the sample loops until it reaches `100`, or
   raises an error after `--consume-timeout` seconds.
9. **Release the lock** — `PATCH /rest/v4/devices/{id}/virtual/release` with
   `{"token": <lock>}` (always run once a lock is held, even on error, so the
   lock is freed).

`lock`, `consume`, and `extend` used to carry a "deprecated" notice in older
copies of the spec; the **current spec no longer marks them deprecated**, so
this sample drives the import with the full
lock → consume → extend(poll) → release sequence. Note that create-upload
(step 3) needs **no lock** at all.

If anything fails **after** the upload was created, the sample best-effort
cancels it — `DELETE /rest/v4/devices/{id}/virtual/uploads/{uploadId}` (valid
while the upload is uploading or consuming) — so a failed run doesn't leave an
orphaned upload/consume in progress on the server. The cancel runs *before* the
lock is released.

The session token is also released with `DELETE /rest/v4/login/sessions/<token>`
on the way out.

## Prerequisites

- Node.js 18+ (for built-in `fetch` and `node:test`).
- Network access to an Nx VMS server with virtual-camera support, and a
  **local** server account (username/password). Cloud users use a different
  login flow — see [`cdb-get-token`](../cdb-get-token).
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

# Or fully on the command line, tuning the consume-poll timing:
node virtual_camera_upload.mjs \
  --server-host https://192.168.1.10:7001 \
  --user admin \
  --password 'your-password' \
  --file ./footage.mkv \
  --start-time 1718496000000 \
  --ttl 600 \
  --chunk-size 2097152 \
  --poll-interval 3 \
  --consume-timeout 600 \
  --insecure
```

## Run the tests

```bash
node --test test_virtual_camera_upload.mjs
```

Name the file explicitly: a bare `node --test` discovers nothing here, because
this house names its test files `test_*.mjs` rather than `*.test.mjs`.

## CLI flags

| Flag | Required | Default | Purpose |
|------|----------|---------|---------|
| `--file` | yes | — | Local video file to upload. |
| `--name` | no | `Virtual Camera` | Name for the new virtual device. |
| `--device-id` | no | — | Upload to an existing virtual device (skips create). |
| `--start-time` | no | now | Archive start: ISO 8601 (e.g. `2026-06-16T00:00:00Z`) or epoch ms. |
| `--duration-ms` | no | — | Clip length in **milliseconds**. Optional: if omitted, the server derives it from the video file's own metadata. |
| `--ttl` | no | `300` | Lock time-to-live, in seconds (also the `ttlMs` sent with every `extend` poll). |
| `--chunk-size` | no | `1048576` | Requested chunk size in bytes (the server may override). |
| `--poll-interval` | no | `2` | Seconds between `extend` polls while consume runs. |
| `--consume-timeout` | no | `300` | Max seconds to wait for consume to reach 100% before giving up. |
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
| `Upload did not complete: server reports uploadProgressPercent=N` | A chunk was dropped or truncated in transit. | Check disk/network; re-run (a fresh MD5/upload is computed each run). |
| `Lock virtual device failed` | The device is already locked by another client. | Wait for the existing lock's TTL to expire, or use a longer `--ttl`. |
| `Chunk N upload failed` | The wrong `chunkSizeB` or a truncated read. | The sample uses the server's returned `chunkSizeB`; check disk/network. |
| `Consume did not reach 100% within Ns` | Import is slow (large file) or stuck server-side. | Re-run with a longer `--consume-timeout`; check server logs if it keeps happening. |
| Consume reaches 100% but footage doesn't appear, and `durationMs` reads `0` | No `--duration-ms` was passed, and the server couldn't read the duration from the file's own metadata (e.g. unusual container, corrupted header). A zero-length archive period is invisible on the timeline. | Re-run with an explicit `--duration-ms <milliseconds>`. |
| Footage doesn't appear / import fails | `startTimeMs` overlaps existing footage, or the md5 didn't match. | Pick a non-overlapping `--start-time`; re-run so md5 is recomputed. |
| Raw `http://` refused | Bearer auth requires HTTPS. | Use `https://` (and the secure port). |

## Files

| File | Purpose |
|------|---------|
| `virtual_camera_upload.mjs` | The sample. Run it directly. |
| `test_virtual_camera_upload.mjs` | Offline tests (mocked `fetch`). |
| `package.json` | Zero-dependency, ESM, `node --test` script. |
