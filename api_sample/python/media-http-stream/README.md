# media-http-stream (Python)

Save a short **video clip** from an Nx camera to a **file** — the command-line
counterpart of the browser [`../../web/media-http-stream`](../../web/media-http-stream)
sample. A CLI can't render a `<video>`, so it fetches the media stream and writes
it to a file you can open in VLC, `ffplay`, or a browser.

Latest **`/rest/v4`** API. Uses `requests`, streaming the body to disk in chunks
so the clip is never held in memory all at once.

## What it does

1. Logs in and gets a bearer token (one of two auth modes).
2. `GET /rest/v4/devices/{id}/media.{format}` with `Authorization: Bearer <token>`.
3. Streams the response body straight to a file (never buffered in memory).
4. Logs out (revokes the token).

## Auth modes

| `--mode` | How you connect | Env vars |
|---|---|---|
| `direct` (default) | Direct to one media server by IP:port with a **local** server account | `NX_SERVER_HOST`, `NX_SERVER_USER`, `NX_SERVER_PASSWORD` |
| `cloud` | Pull the stream over the **Cloud relay** with a cloud account (token scoped with `cloudSystemId`, relay 307 followed manually with the bearer re-attached) | `NX_CLOUD_HOST` (default `https://nxvms.com`), `NX_CLOUD_USER`, `NX_CLOUD_PASSWORD`, `NX_CLOUD_SITE_ID` |

Both modes also read `NX_MODE`, `NX_DEVICE_ID`, and `NX_MEDIA_FORMAT`.

## Live vs. archive

- **No `--pos`** → **live**: saves the next `--duration` seconds.
- **`--pos <ISO|epochMs>`** → **archive**: saves `--duration` seconds starting there,
  e.g. `--pos 2026-06-15T12:00:00Z` or `--pos 1700000000000`.

Because a CLI must terminate, the clip is always bounded by `--duration` (seconds,
default 10). `durationMs` is sent to the server **and** used as a client-side
safety stop (a wall-clock check during `iter_content`), so the program can never
hang on an endless live stream.

## Formats

`--format` is one of the containers the v4 spec allows for this endpoint
(verbatim from `docs/v4_api_spec.json`):

```
webm  mpegts  mpjpeg  mp4  mkv  _3gp  rtp  flv  f4v
```

`webm` (default), `mp4`, and `mkv` are the most broadly playable for short saved
clips. `mpjpeg` is a multipart MJPEG stream (frames, not a single video); the
rest are the remaining containers the server can mux to. There is **no** HLS
(`.m3u8`) on this device endpoint.

## Install

```bash
pip install -r requirements.txt
```

## Run

```bash
# Live 10s webm from a local server (self-signed cert -> --insecure)
python3 media_http_stream.py --mode direct \
  --server-host https://192.168.1.10:7001 --user admin --password 'secret' \
  --device-id {camera-id} --insecure

# 15s archive mp4 over the cloud relay, explicit output file
python3 media_http_stream.py --mode cloud \
  --site-id {site-id} --user me@example.com --password 'secret' \
  --device-id {camera-id} --format mp4 \
  --pos 2026-06-15T12:00:00Z --duration 15 --out lobby.mp4

# Or put the vars in a .env and just pass --env-file
python3 media_http_stream.py --mode cloud --device-id {camera-id} --env-file ../../.env
```

Config precedence is **CLI flag > environment variable > `.env`**; credentials are
never hard-coded. If `--out` is omitted, the file is named
`clip-<device>-<timestamp>.<format>`.

### Flags

```
--mode direct|cloud      auth mode (default direct)
--server-host <url>      media server base URL (direct mode)
--cloud-host <url>       cloud base URL (cloud mode; default https://nxvms.com)
--user / --password      local server account (direct) or cloud account (cloud)
--site-id <uuid>         Site ID (cloud mode)
--mfa-code <code>        2FA code (cloud mode)
--device-id <id>         camera/device id
--format <fmt>           container (default webm)
--pos <ISO|epochMs>      archive start; omit for live
--duration <seconds>     clip length (default 10)
--out <path>             output file (default clip-<device>-<ts>.<fmt>)
--env-file <path>        .env file to read (default .env)
--insecure               accept self-signed TLS (typical for local servers)
```

## Test

Offline — HTTP and the byte stream are mocked, so no account, network, or live
camera is needed:

```bash
pip install -r requirements.txt
pytest -v
```

The tests cover arg parsing, format/position/duration validation, mode-aware
config, both login flows, media-URL building (live vs. archive, no token in the
URL), streaming to a sink **and** to a real temp file, the relay 307 + bearer
re-attach, the client-side safety stop, and the auth/error paths.

## Notes

- The token is sent as an `Authorization` header — never in the URL (unlike the
  browser sample, which has to pass it to its local proxy as a query param
  because a `<video>` tag can't send headers).
- Unlike the Node sample (which uses `--dotenv` because Node reserves
  `--env-file`), this Python sample uses **`--env-file`**, matching the other
  Python samples in this repo.
- Actual playback isn't unit-testable without a live server; the tests verify the
  request, the streaming wiring, and the bytes written.
```
