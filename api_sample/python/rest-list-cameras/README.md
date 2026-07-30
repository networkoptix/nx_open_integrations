# REST Server API — Log in & list cameras (Python)

Connects to **one VMS server/site** and lists its **cameras** (devices). This is
the sample that actually enumerates cameras — something the Cloud CDB cannot do.

```
Logged in to https://192.168.1.10:7001 as admin

NAME          STATUS   MODEL          ID
Lobby Cam     Online   AXIS M3045-V   {a1b2...}
Parking Cam   Online   Hanwha XNV     {c3d4...}
```

## What the code does (Nx 5.0+ bearer-token auth)

1. **Log in** — `POST /rest/v4/login/sessions` with `{username, password}` → `{"token": ...}`.
2. **List cameras** — `GET /rest/v4/devices` with `Authorization: Bearer <token>`.
3. **Log out** — `DELETE /rest/v4/login/sessions/<token>` to release the session
   (done automatically, even if an error occurs).

## Prerequisites

- Python 3.8+
- Network access to an Nx VMS server and a **local** server account
  (username/password). Cloud users use a different login flow — see the note below.
- The tests need neither a server nor a network.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Uses `NX_SERVER_*` variables (separate from the cloud ones). They live in the same
shared template at the repo root:

```bash
cp ../../.env.example ../../.env   # then edit the NX_SERVER_* lines
```

- `NX_SERVER_HOST` — e.g. `https://192.168.1.10:7001` (include `https://` and the
  port), or a relay address `https://<siteId>.relay.vmsproxy.com`.
- `NX_SERVER_USER`, `NX_SERVER_PASSWORD` — a **local** server account.

## Run

```bash
# Local servers almost always use a self-signed cert, so --insecure is normal here:
python rest_list_cameras.py --env-file ../../.env --insecure

# Or fully on the command line:
python rest_list_cameras.py \
  --host https://192.168.1.10:7001 \
  --user admin \
  --password 'your-password' \
  --insecure
```

## Run the tests

```bash
pytest -v
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `SSLError` / certificate verify failed | Local server uses a self-signed cert. | Add `--insecure` (expected for local servers). |
| `Could not reach https://...` | Wrong IP/port, server down, or firewall. | Confirm host + port `7001`, and that the server is reachable. |
| `Login unauthorized (HTTP 401/403)` | Wrong password, or this is a **cloud** user. | Use a local account. Cloud users need the cloud OAuth2 token flow (see note). |
| `Login response did not contain a token` | Hitting the wrong URL/version. | Confirm the host is a VMS server; this sample uses `/rest/v4`. |
| `No cameras found on this site` | The site genuinely has no devices, or the account lacks permission to see them. | Check in the Nx client; use an account that can view the cameras. |
| Raw `http://` refused | Bearer auth requires HTTPS. | Use `https://` (and the secure port). |

### Local vs. Cloud users

This sample logs in as a **local** server user. If you only have a **cloud**
account, the server delegates authentication to the cloud: you obtain a bearer
token from `POST /cdb/oauth2/token` (with `scope=... cloudSystemId=<id>`) and then
use it against the server. That cloud-user flow can be added as a follow-up sample
if you need it.

## Files

| File | Purpose |
|------|---------|
| `rest_list_cameras.py` | The sample. Run it directly. |
| `test_rest_list_cameras.py` | Offline tests (mocked HTTP). |
| `requirements.txt` | `requests` + `pytest`. |
