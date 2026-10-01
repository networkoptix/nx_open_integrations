# Nx API Samples — Python

Python versions of the Nx API samples. Each is a self-contained folder with the
sample, an offline test suite, and its own README. All REST samples target the
latest **`/rest/v4`** API.

**One dependency:** [`requests`](https://pypi.org/project/requests/) for HTTP
(plus `pytest` for the offline tests). Each folder has its own
`requirements.txt`.

## Samples

| Folder | What it shows | API | Tests |
|---|---|---|---|
| [`cdb-get-token`](cdb-get-token) | One login call → a bearer token | Cloud CDB | 8 |
| [`cdb-oauth2-list-systems`](cdb-oauth2-list-systems) | Login + list Sites, 2FA, token scope | Cloud CDB | 12 |
| [`cdb-refresh-token`](cdb-refresh-token) | Proactive + reactive refresh, rotation, disk persistence | Cloud CDB | 13 |
| [`rest-get-token`](rest-get-token) | Mediaserver login session: get a token, use it, revoke it | REST v4 | 23 |
| [`rest-list-cameras`](rest-list-cameras) | Local-user login + list devices + logout | REST v4 | 10 |
| [`rest-list-cameras-cloud-user`](rest-list-cameras-cloud-user) | Scoped cloud token + site access via the relay | REST v4 | 10 |
| [`rest-event-log`](rest-event-log) | Scoped token, manual 307, v4 time window + parsing | REST v4 | 22 |
| [`media-http-stream`](media-http-stream) | Save a live/archive video clip to a file via `media.{format}`, both auth modes, relay 307 | REST v4 | 36 |
| [`rest-rule-schedule`](rest-rule-schedule) | Set an event rule's v4 schedule: `GET events/rules` + `PATCH events/rules/{id}` (presets + by-comment), both auth modes | REST v4 | 38 |
| [`rest-operate-ptz-via-api`](rest-operate-ptz-via-api) | Read PTZ capabilities, then move/stop/abs-move and drive presets and tours, both auth modes | REST v4 | 23 |
| [`rest-configure-system-via-api`](rest-configure-system-via-api) | First-time site setup: name, admin password, cloud bind (personal or organization), default toggles | REST v4 + CDB | 82 |
| [`virtual-camera-upload`](virtual-camera-upload) | Create a virtual camera and upload footage to it, both auth modes | REST v4 | 42 |
| [`rest-backup-site-database`](rest-backup-site-database) | Dump the Site database to a file and load it back: `GET` and `POST site/database`, streamed as opaque bytes, fresh-session permissions | REST v4 | 68 |

New to these? Read them top to bottom — that's the difficulty order.

## Other Python samples (outside the shared catalog)

These two have no port in the other languages yet, so they are not in the table
above.

- [`rest-configure-system-via-api`](rest-configure-system-via-api) — first-time
  setup for one VMS server/site: set its name and local admin password, and
  optionally connect it to the Cloud.
- [`rest-operate-ptz-via-api`](rest-operate-ptz-via-api) — drive a PTZ
  (Pan-Tilt-Zoom) camera on one server/site, local or cloud-relayed: report the
  camera's PTZ capabilities, then issue the requested command.

## Run any sample

```bash
cd <folder>
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python <the_sample>.py --env-file ../../.env          # add --insecure for local servers
pytest -v                                             # offline; no account or network
```

## Conventions (shared across all Python samples)

- Each sample is a single runnable `.py` with a `main()` and an `if __name__ ==
  "__main__"` guard.
- Core logic takes an injectable HTTP layer so the tests run fully offline with
  mocked responses (no account, no network).
- `argparse` flags follow **CLI > env var > `.env`** precedence; credentials are
  never hard-coded.
- `--insecure` disables TLS verification for lab/self-signed certs. With it,
  samples also call `urllib3.disable_warnings(InsecureRequestWarning)` — an
  insecure request is what you just asked for, so the per-request warning only
  buries the sample's own output. Don't carry that call into production code:
  there the warning is the point. (The Node and TypeScript ports filter Node's
  equivalent `NODE_TLS_REJECT_UNAUTHORIZED` warning; .NET emits none.)
- `--env-file` points at a shared `.env` (copy `../../.env.example`).
