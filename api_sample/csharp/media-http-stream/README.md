# REST API — Save a video clip to a file (C#)

Fetches a short video **clip** from one camera and **streams it to a file** you
can play in VLC / ffplay / a browser. The command-line counterpart of the
browser [`../../web/media-http-stream`](../../web/media-http-stream) sample and a
C# port of [`../../typescript/media-http-stream`](../../typescript/media-http-stream),
on the latest **`/rest/v4`** API. Built-in `HttpClient` + `System.Text.Json` —
no third-party packages.

```
Saving 10s live clip of device {cam-id} (webm) to clip-cam-id-2026-06-15T12-00-00-000Z.webm ...
Done. Wrote 1843200 bytes to clip-cam-id-2026-06-15T12-00-00-000Z.webm
```

## Two auth modes

Same two modes as the web/TypeScript sample:

| `--mode` | What it does | Vars |
|---|---|---|
| `direct` *(default)* | Connect to ONE media server by IP:port with a **local** server account. | `NX_SERVER_HOST` / `NX_SERVER_USER` / `NX_SERVER_PASSWORD` |
| `cloud` | Reach the site over the **Cloud relay** with a cloud account; the token is scoped with `cloudSystemId`. | `NX_CLOUD_HOST` / `NX_CLOUD_USER` / `NX_CLOUD_PASSWORD` / `NX_CLOUD_SITE_ID` |

## The media endpoint

```
GET /rest/v4/devices/{id}/media.{format}    (Authorization: Bearer <token>)
  ?positionMs=<ms>     archive start time; OMIT for LIVE
  &durationMs=<ms>     how much footage to pull (bounds the clip)
```

`format` is one of the containers the v4 spec allows (taken verbatim from
`docs/v4_api_spec.json`, do not subset): `webm, mpegts, mpjpeg, mp4, mkv, _3gp,
rtp, flv, f4v` (default `webm`). `webm` / `mp4` / `mkv` are the most broadly
playable for short saved clips.

- **No `--pos`** -> LIVE: save the next `--duration` seconds.
- **`--pos <ISO|epochMs>`** -> ARCHIVE: save `--duration` seconds starting there.

## Flow walkthrough

The whole flow lives in **`src/NxMediaClient.cs`** (`Program.cs` is just CLI
wiring). The interesting parts:

**1 — `LoginAsync()`: two flows, one method.** Direct posts to
`{server}/rest/v4/login/sessions` for a `token`; cloud posts to
`{cloud}/cdb/oauth2/token` with `scope=cloudSystemId=<id>` for an `access_token`.

**2 — `SaveClipAsync()`: stream the body to a `Stream`, no buffering.**
```csharp
// ResponseHeadersRead -> the body is streamed, not buffered into memory.
HttpResponseMessage response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
Stream source = await response.Content.ReadAsStreamAsync(ct);
// copied to the destination Stream in 80 KB chunks; never holds the whole clip.
```
The destination is **injectable** (any `Stream`), so tests write to a
`MemoryStream`; the CLI writes to a real `FileStream`. A linked
`CancellationTokenSource` cancels after `durationMs + grace`, the client-side
safety stop that keeps a live stream from hanging the CLI.

**3 — The relay 307.** `GetFollowingRedirectsAsync` follows the relay's 307 by
hand: .NET (like browsers) drops the `Authorization` header across a cross-host
redirect, so the client sets `AllowAutoRedirect = false` and **re-attaches the
bearer on each hop** (max 5).

**4 — `LogoutAsync()`: revoke the token (best-effort).** `DELETE` the server
session (direct) or the cloud token (cloud).

The token is always sent as an `Authorization: Bearer` header — **never** in the
URL.

## Project layout

```
media-http-stream/
  src/    NxMediaClient.cs  Config.cs  Program.cs  NxMediaHttpStream.csproj
  tests/  NxMediaClientTests.cs  NxMediaHttpStream.Tests.csproj
```

## Prerequisites

- **.NET SDK 10.0+**
- A camera/device id, and either a local server account (direct) or a cloud
  account with the target site's **Cloud Site ID** (a UUID).

## Run

```bash
cd src

# Direct to a media server (local account):
dotnet run -- \
  --mode direct \
  --server-host https://192.168.1.10:7001 \
  --user admin --password 'your-password' \
  --device-id {cam-id} --duration 10 --insecure

# Through the Cloud relay (cloud account):
dotnet run -- \
  --mode cloud \
  --cloud-host https://nxvms.com \
  --user you@example.com --password 'your-password' \
  --site-id 1111....-5555 --device-id {cam-id} \
  --format mp4 --duration 10 --insecure

# Archive clip starting at a time (ISO or epoch ms):
dotnet run -- --mode direct --server-host https://192.168.1.10:7001 \
  --user admin --password 'pw' --device-id {cam-id} \
  --pos 2026-06-15T12:00:00Z --duration 30 --out morning.mp4 --insecure
```

Add `--mfa-code 123456` if your cloud account has 2FA. Without `--out`, the file
is named `clip-<device>-<timestamp>.<format>`.

## Run the tests

```bash
cd tests
dotnet test
```

> Note: these tests were written but **not executed in the authoring
> environment** (no .NET SDK there). They use standard xUnit + a fake
> `HttpMessageHandler`; run `dotnet test` locally to confirm green. The 307 test
> proves the bearer is re-attached across the relay hop; the streaming tests
> write the fake clip to a `MemoryStream` and to a real temp file.

## CLI flags

| Flag | Purpose |
|------|---------|
| `--mode` | `direct` (default) or `cloud` |
| `--server-host` | Media server, e.g. `https://192.168.1.10:7001` (direct mode) |
| `--cloud-host` | Cloud host, e.g. `https://nxvms.com` (cloud mode) |
| `--user` / `--password` | Credentials (server account for direct, cloud account for cloud) |
| `--site-id` | Cloud Site ID of the target site (UUID, cloud mode) |
| `--mfa-code` | One-time 2FA code (cloud mode) |
| `--device-id` | The camera/device to record |
| `--format` | Container: `webm` (default), `mpegts`, `mpjpeg`, `mp4`, `mkv`, `_3gp`, `rtp`, `flv`, `f4v` |
| `--pos` | Archive start (ISO time or epoch ms). Omit for LIVE. |
| `--duration` | Clip length in seconds (default 10) |
| `--out` | Output file path (default `clip-<device>-<ts>.<format>`) |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |

Config precedence: **CLI > env var > `.env`** (`NX_MODE`, `NX_SERVER_HOST` /
`NX_SERVER_USER` / `NX_SERVER_PASSWORD`, `NX_CLOUD_HOST` / `NX_CLOUD_USER` /
`NX_CLOUD_PASSWORD` / `NX_CLOUD_SITE_ID`, `NX_DEVICE_ID`, `NX_MEDIA_FORMAT`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials or wrong account type. | Direct needs a LOCAL server account; cloud needs `--mode cloud` + `--mfa-code` for 2FA. |
| `The server rejected the token` | Cloud token not scoped to this site. | Confirm `--site-id`; the scope must be `cloudSystemId=<that id>`. |
| `Unsupported format` | Format not on this endpoint. | Use one of the listed v4 containers (HLS/`m3u8` is not supported here). |
| `Media response had no body to save` | Empty/aborted stream. | Confirm the device is online and has footage for the requested window. |
| TLS / certificate error | Self-signed lab server. | Lab only: add `--insecure`. |

## Files

| File | Purpose |
|------|---------|
| `src/NxMediaClient.cs` | API logic (login both modes, build URL, stream-to-Stream save, 307 follow, logout). |
| `src/Config.cs` | `.env` reader, arg parser, format/position/duration validators, CLI>env>.env precedence. |
| `src/Program.cs` | CLI wiring (`Main`); builds the no-auto-redirect HttpClient and the output `FileStream`. |
| `tests/NxMediaClientTests.cs` | Offline xUnit tests (fake `HttpMessageHandler`; streams to MemoryStream + temp file). |
