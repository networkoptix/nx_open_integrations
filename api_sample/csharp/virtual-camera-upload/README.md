# Virtual camera — create & upload recorded footage (C#)

Creates a **virtual camera** on **one VMS server** and uploads a local video
file into its archive as recorded footage. A virtual camera has no live source;
you push it pre-recorded media and the server ingests it as if it had been
captured at the time you specify. This sample is using the built-in `HttpClient` and
`System.Text.Json`, no third-party packages.

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

> **Note:** Actual ingestion can be confirmed against a **live server with
> virtual-camera support**. The offline tests verify the call sequence, the
> chunking, and the request payloads — not that a real server accepts the media.

## What the code does (Nx 5.0+ bearer-token auth, /rest/v4)

The API logic lives in **`src/Client.cs`**; the end-to-end sequence in
**`src/Orchestrator.cs`**; `Program.cs` is just CLI wiring. All calls go to the
server base URL with `Authorization: Bearer <token>`.

The file is **uploaded to the server first**, with no lock needed for that part.
The device is only **locked while the upload is imported** into the archive
(the consume step), so the lock window stays short and other clients can use the
device the rest of the time.

1. **Log in** — `POST /rest/v4/login/sessions` with `{username, password, setCookie:false}` → `{"token": ...}`.
2. **Create the virtual device** — `POST /rest/v4/devices/*/virtual` with
   `{"name": ...}` → the new device (read its `id`). *Skipped if `--device-id` is given.*
   The `*` is the current-server wildcard and is part of the path.
3. **Create the upload** — `POST /rest/v4/devices/{id}/virtual/uploads` with
   `{"items": [{filename, sizeB, md5, startTimeMs, durationMs, chunkSizeB}]}`.
   **No lock is needed here.** The response echoes the `chunkSizeB` the server
   wants (the sample uses it if present) and the server-assigned `uploadId`.
   `md5` is the base64 MD5 of the full file (`MD5.ComputeHash` →
   `Convert.ToBase64String`). `startTimeMs` reserves the archive period here, and
   is passed again at consume (step 7) to trigger the actual import.
   **`durationMs` is optional** — pass `--duration-ms` if you know the clip
   length; if omitted, the server derives the duration from the video file's own
   metadata. If that metadata is missing or unreadable and no `durationMs` was
   sent, the archive period comes back as `0` and the footage will not appear on
   the timeline (see Troubleshooting).
4. **Upload the bytes** — for each zero-based chunk `n`,
   `PUT /rest/v4/devices/{id}/virtual/uploads/{uploadId}?chunk=n` with the raw
   chunk bytes (`ByteArrayContent`) and `Content-Type: application/octet-stream`.
   `uploadId` is the server-returned id (or the file's name if none is echoed).
5. **Check the upload status** — `GET /rest/v4/devices/{id}/virtual/uploads/{uploadId}`.
   Confirms `uploadProgressPercent` reached `100`, i.e. the server has all the
   bytes, before anything is locked or imported.
6. **Lock the device** — `PATCH /rest/v4/devices/{id}/virtual/lock` with
   `{"ttlMs": ...}` → the lock token, returned at **`lockInfo.token`** (the reply
   is `{id, lockInfo:{userId, token, ttlMs, progress}}`; parsed defensively).
7. **Start the import (consume)** — `PATCH /rest/v4/devices/{id}/virtual/consume`
   with `{"token": <lock>, "uploadId": ..., "startTimeMs": ...}`. Starts
   importing the already-uploaded file as camera footage. Nothing imports on its
   own when the last chunk lands — this call is what starts it.
8. **Poll progress (extend)** — `PATCH /rest/v4/devices/{id}/virtual/extend`
   with `{"ttlMs": ..., "token": <lock>}`, called repeatedly (every
   `--poll-interval` seconds). Each call **renews the lock** and returns
   `lockInfo.progress` (0–100); the sample loops until it reaches `100`, or
   throws after `--consume-timeout` seconds.
9. **Release the lock** — `PATCH /rest/v4/devices/{id}/virtual/release` with
   `{"token": <lock>}` (always run once a lock is held, even on error, so the
   lock is freed).

If anything fails **after** the upload was created, the sample best-effort
cancels it — `DELETE /rest/v4/devices/{id}/virtual/uploads/{uploadId}` (valid
while the upload is uploading or consuming) — before releasing the lock, so a
failed run doesn't leave an orphaned upload/consume in progress on the server.
Any error from that cleanup is swallowed so it can never mask the real failure.

`lock`, `consume`, and `extend` are **current** endpoints. An older copy of the
OpenAPI spec marked them deprecated; the updated spec does not, and the import
genuinely needs all three.

The session token is also released with `DELETE /rest/v4/login/sessions/<token>`
on the way out.

## Project layout

```
virtual-camera-upload/
  src/    Client.cs  Orchestrator.cs  Config.cs  LoggingHandler.cs  Program.cs  NxVirtualCameraUpload.csproj
  tests/  NxVirtualCameraUploadTests.cs  NxVirtualCameraUpload.Tests.csproj
```

## Prerequisites

- **.NET SDK 10.0+**
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

Config precedence is **CLI flag > environment variable > `.env`**.

## Run

```bash
cd src

# Local servers almost always use a self-signed cert, so --insecure is normal here.
# Create a new virtual camera named "Front Door" and upload a clip into it:
dotnet run -- \
  --env-file ../../../.env --insecure \
  --file ./footage.mkv \
  --name "Front Door" \
  --start-time 2026-06-16T00:00:00Z \
  --duration-ms 30000

# Upload to an EXISTING virtual device (skips the create step):
dotnet run -- \
  --env-file ../../../.env --insecure \
  --file ./footage.mkv \
  --device-id '{a1b2c3d4-...}'

# Or fully on the command line, tuning the consume-poll timing:
dotnet run -- \
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

A large clip imports slowly. If the run ends with `Consume did not reach 100%
within 300s`, the upload was fine — only the poll gave up; raise
`--consume-timeout`.

## See the raw requests and responses (`--debug`)

Add `--debug` to print the full exchange to stderr — useful for confirming the
create-upload body (including `durationMs` when provided) and watching
`lockInfo.progress` climb on each `extend` poll:

```bash
dotnet run -- \
  --server-host https://172.19.15.65:7001 \
  --user admin --password 'your-password' \
  --file ./sample.mp4 --duration-ms 30000 \
  --insecure --debug
```

Each call prints as:

```
--> PATCH https://172.19.15.65:7001/rest/v4/devices/{id}/virtual/extend
    Authorization: Bearer <hidden>
    body: {"ttlMs":300000,"token":"…"}
<-- 200 OK (PATCH …/virtual/extend)
    body: {"id":"{id}","lockInfo":{"userId":"…","token":"…","ttlMs":300000,"progress":40}}
```

The chunk PUTs show `body: <1048576 bytes application/octet-stream>` rather than dumping
raw video. Redirect to a file with `2> debug.log` if you want to keep it.

## Run the tests

```bash
cd tests
dotnet test
```

52 offline xUnit cases†, covering the pure helpers (chunk planning, MD5, start-time
parsing, the defensive JSON readers incl. `ParseLockProgress` / `ParseUploadProgress`),
the `extend`-poll loop, and the full orchestration — happy path, existing-device,
upload-incomplete, and both failure/cancel paths. The poll loop takes an injectable
delay and clock, so the tests never actually sleep.

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
| `--env-file` | no | `.env` | Path to a `.env` file. |
| `--insecure` | no | off | Skip TLS verification (usual for local servers). |
| `--debug` | no | off | Print every HTTP request (method, URL, body) and response (status, body) to stderr. JSON is shown verbatim; binary chunks are summarized as a byte count; the bearer token is hidden. |

\* Required, but may come from the environment / `.env` instead of the flag.

`startTimeMs` (from `--start-time`) is sent at create-upload **and** again at
consume. `durationMs` (from `--duration-ms`) is optional; if omitted, the server
derives the clip's duration from the uploaded file's own metadata.
`--poll-interval` and `--consume-timeout` are in **seconds** and accept
fractional values; both must be positive.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| TLS / certificate error | Local server uses a self-signed cert. | Add `--insecure` (expected for local servers). |
| `Could not reach https://...` | Wrong IP/port, server down, or firewall. | Confirm host + port `7001`, and that the server is reachable. |
| `Login unauthorized (HTTP 401/403)` | Wrong password, or this is a **cloud** user. | Use a local account. See [`../rest-list-cameras`](../rest-list-cameras). |
| `Create virtual device failed` | Server build lacks virtual-camera support, or the account can't add devices. | Confirm the server supports virtual cameras and the account has admin rights. |
| `Upload did not complete: server reports uploadProgressPercent=N` | A chunk was dropped or truncated in transit, so the server never received the whole file. Nothing is locked or imported. | Check disk/network and re-run (a fresh MD5 and upload are computed each run). |
| `Lock virtual device failed` | The device is already locked by another client. | Wait for the existing lock's TTL to expire, or use a longer `--ttl`. |
| `Chunk N upload failed` | The wrong `chunkSizeB` or a truncated read. | The sample uses the server's returned `chunkSizeB`; check disk/network. |
| `Consume did not reach 100% within Ns (last progress: P%)` | The import is slow (large file) or stuck server-side. The bytes uploaded fine; only the poll gave up. | Re-run with a longer `--consume-timeout` (and/or a larger `--poll-interval`); check server logs if it keeps happening. |
| Consume reaches 100% but footage doesn't appear, and `durationMs` reads `0` | No `--duration-ms` was passed, and the server couldn't read the duration from the file's own metadata (e.g. unusual container, corrupted header). A zero-length archive period is invisible on the timeline. | Re-run with an explicit `--duration-ms <milliseconds>`. |
| `Start consume failed` / footage doesn't appear | `startTimeMs` overlaps existing footage, or the md5 didn't match. | Pick a non-overlapping `--start-time`; re-run so md5 is recomputed. |
| `TaskCanceledException` / `Could not reach ...` on a big chunk | The `HttpClient` timeout (120 s) is shorter than one chunk's transfer. | Use a smaller `--chunk-size`, or raise the timeout in `Program.BuildHttpClient`. |
| Raw `http://` refused | Bearer auth requires HTTPS. | Use `https://` (and the secure port). |

## Files

| File | Purpose |
|------|---------|
| `src/Client.cs` | API logic (login, create, create-upload, chunk PUT, upload status, cancel upload, lock, consume, extend, release) + pure helpers. |
| `src/Orchestrator.cs` | The create → upload → status → lock → consume → poll → release sequence, plus `WaitForConsumeAsync` (injectable delay/clock) and the cancel-on-failure cleanup. |
| `src/Config.cs` | `.env` reader, arg parser, CLI>env>.env precedence. |
| `src/LoggingHandler.cs` | `--debug` wiretap: a `DelegatingHandler` that logs each request/response. |
| `src/Program.cs` | CLI wiring (`Main`); builds the HttpClient; validates the flags. |
| `tests/NxVirtualCameraUploadTests.cs` | Offline xUnit tests (fake `HttpMessageHandler`, fake clock). |
