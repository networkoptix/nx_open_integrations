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
| [`rest-list-cameras`](rest-list-cameras) | Local-user login + list devices + logout | REST v4 | 10 |
| [`rest-list-cameras-cloud-user`](rest-list-cameras-cloud-user) | Scoped cloud token + site access via the relay | REST v4 | 10 |
| [`rest-event-log`](rest-event-log) | Scoped token, manual 307, v4 time window + parsing | REST v4 | 22 |
| [`media-http-stream`](media-http-stream) | Save a live/archive video clip to a file via `media.{format}`, both auth modes, relay 307 | REST v4 | 36 |
| [`rest-rule-schedule`](rest-rule-schedule) | Set an event rule's v4 schedule: `GET events/rules` + `PATCH events/rules/{id}` (presets + by-comment), both auth modes | REST v4 | 38 |
| [`virtual-camera-upload`](virtual-camera-upload) | Create a virtual camera and upload footage to it, both auth modes | REST v4 | 30 |

New to these? Read them top to bottom — that's the difficulty order.

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
- `--insecure` disables TLS verification for lab/self-signed certs.
- `--env-file` points at a shared `.env` (copy `../../.env.example`).

## Relation to the Node samples

Every folder here has a matching [`../node_js`](../node_js) port with identical
behavior and matching offline tests, so you can compare the two languages side
by side. The main surface difference: Python uses `--env-file`, while Node uses
`--dotenv` (Node 20.6+ reserves `--env-file` as a built-in).
