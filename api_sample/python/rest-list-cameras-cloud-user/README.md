# REST API — List a site's cameras with a CLOUD account (Python)

Lists the cameras on **one specific site** using your **cloud** login, by way of
a **site-scoped token** and the Cloud relay. This is the cloud counterpart of
`../rest-list-cameras` (which uses a local server account).

```
Got site-scoped token for 1111....-5555

NAME          STATUS   MODEL          ID
Lobby Cam     Online   AXIS M3045-V   {a1b2...}
```

## The key idea: token scope

A cloud token comes in two flavours:

| Token | How you get it | What it can do |
|-------|----------------|----------------|
| **Cloud-wide (cdb)** | `POST /cdb/oauth2/token` **without** scope | Account-level CDB calls, e.g. list your Sites |
| **Site-scoped** | `POST /cdb/oauth2/token` **with** `scope=cloudSystemId=<id>` | Call **that one site's** API (cameras, users, etc.) |

A cloud-wide token is **not** accepted by an individual site — that is the
mistake this sample exists to demonstrate the fix for. To list a site's cameras
with a cloud account, you must request the token with `cloudSystemId`.

## What the code does

1. **Get a scoped token** — `POST {cloud}/cdb/oauth2/token` with
   `scope=cloudSystemId=<your-site-id>`.
2. **Reach the site via the relay** — `https://<site-id>.relay.vmsproxy.com`.
3. **List cameras** — `GET /rest/v4/devices` with `Authorization: Bearer <token>`.
4. **Delete the token** on the cloud when finished (automatic cleanup).

## Prerequisites

- Python 3.8+
- A cloud account with access to the target site, and that site's
  **Cloud Site ID** (a UUID). Find it in the Nx desktop client or cloud portal.
- The tests need neither an account nor a network.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Uses the shared `NX_CLOUD_*` variables plus `NX_CLOUD_SITE_ID`:

```bash
cp ../../.env.example ../../.env   # then set NX_CLOUD_SITE_ID
```

## Run

```bash
python rest_cloud_sample.py --env-file ../../.env --insecure

# Or fully on the command line:
python rest_cloud_sample.py \
  --cloud-host https://nxvms.com \
  --user you@example.com \
  --password 'your-password' \
  --site-id 1111....-5555 \
  --insecure
```

Add `--mfa-code 123456` if your cloud account has 2FA enabled.

## Run the tests

```bash
pytest -v
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials, wrong site id, or no access to that site. | Re-check all three; add `--mfa-code` for 2FA. |
| `The site rejected the token` | Token was not scoped to this site (or wrong site). | Confirm `--site-id` is correct; the scope must be `cloudSystemId=<that id>`. |
| `Could not reach https://<id>.relay.vmsproxy.com` | Site offline, not cloud-connected, or no relay. | Confirm the site is online and connected to the cloud. |
| `SSLError` | Relay/site TLS trust. | Lab only: add `--insecure`. |
| `No cameras found on this site` | Site has no devices, or account lacks permission. | Verify in the Nx client with an account that can see the cameras. |

## Relation to the other camera sample

- `../rest-list-cameras` — **local** server user, talks directly to the server
  (`https://<ip>:7001`). No cloud, no scope.
- **this sample** — **cloud** user, talks to the site via the relay, using a
  `cloudSystemId`-scoped token.

## Files

| File | Purpose |
|------|---------|
| `rest_cloud_sample.py` | The sample. Run it directly. |
| `test_rest_cloud_sample.py` | Offline tests (mocked HTTP). |
| `requirements.txt` | `requests` + `pytest`. |
