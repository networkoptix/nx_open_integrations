# Cloud CDB — OAuth2 login + list Sites (Python)

Logs in to the Nx Cloud with the **OAuth2 password grant**, gets a bearer token,
then lists the Sites registered to your account. This is the natural second step
after `../cdb-get-token` (which only gets the token).

```
Logged in. Your account has 2 Site(s):

NAME              SITE ID                                ROLE
HQ — Building A   1111....-5555                          Owner
Warehouse 3       2222....-6666                          Administrator
```

## The flow

```
1. POST {cloud}/cdb/oauth2/token   -> bearer token
2. GET  {cloud}/cdb/systems        (Authorization: Bearer <token>)
```

The cloud lists **Sites**, not cameras. To list a site's cameras you need a
**site-scoped** token — see `../rest-list-cameras-cloud-user`. (Pass
`--cloud-site-id` here to request a scoped token instead of a cloud-wide one.)

## Prerequisites

- Python 3.8+
- A cloud account. The tests need neither an account nor a network.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Uses the shared `NX_CLOUD_*` variables:

```bash
cp ../../.env.example ../../.env   # then set NX_CLOUD_HOST / USER / PASSWORD
```

## Run

```bash
python cdb_oauth2_sample.py --env-file ../../.env

# Or fully on the command line:
python cdb_oauth2_sample.py \
  --host https://nxvms.com \
  --user you@example.com \
  --password 'your-password'

# 2FA account:
python cdb_oauth2_sample.py --env-file ../../.env --mfa-code 123456
```

## Run the tests

```bash
pytest -v
```

## CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` / `--password` | Cloud credentials |
| `--mfa-code` | One-time 2FA code |
| `--cloud-site-id` | Scope the token to one site (omit for cloud-wide) |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--debug` | Print the raw `/cdb/systems` JSON response |

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials. | Re-check email/password; add `--mfa-code` for 2FA. |
| `SSLError` | TLS trust. | Lab only: add `--insecure`. |
| Empty Site list | Account has no Sites, or lacks permission. | Confirm in the Nx cloud portal. |

## Files

| File | Purpose |
|------|---------|
| `cdb_oauth2_sample.py` | The sample. Run it directly. |
| `test_cdb_oauth2_sample.py` | Offline tests (mocked HTTP). |
| `requirements.txt` | `requests` + `pytest`. |
