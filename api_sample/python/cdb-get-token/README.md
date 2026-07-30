# Cloud CDB — Get an OAuth2 token (Python)

The smallest possible authentication example: make **one** call, get a **bearer
token**, print it. Everything else in the Nx Cloud / site APIs is just "send
this token in an `Authorization: Bearer` header."

```
Token acquired.

access_token : nxcdb-eyJhbGciOi...
expires_in   : 3600 seconds

Use it on later requests as a header:
  Authorization: Bearer nxcdb-eyJhbGciOi...
```

## The one call

```
POST https://nxvms.com/cdb/oauth2/token
Content-Type: application/json

{
  "grant_type":    "password",
  "response_type": "token",
  "client_id":     "3rdParty",
  "username":      "you@example.com",
  "password":      "your-password"
}
```

Optional fields:

- `"mfaCode": "123456"` — only if your account has **2FA** enabled.
- `"scope": "cloudSystemId=<id>"` — scope the token to **one** site. Omit it
  for a **cloud-wide** token (the usual case).

The response includes `access_token` (it starts with `nxcdb-`) and usually
`expires_in` (lifetime in seconds).

## Prerequisites

- Python 3.8+
- An Nx Cloud account (email + password). The **tests need no account / network.**

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Reuses the shared `NX_CLOUD_*` variables. Copy the template at the repo root:

```bash
cp ../../.env.example ../../.env   # then edit it
```

## Run

```bash
# Using the shared .env:
python cdb_get_token.py --env-file ../../.env

# Or fully on the command line:
python cdb_get_token.py \
  --host https://nxvms.com \
  --user you@example.com \
  --password 'your-password'

# 2FA account:
python cdb_get_token.py --env-file ../../.env --mfa-code 123456

# Scope the token to one site:
python cdb_get_token.py --env-file ../../.env --cloud-site-id <site-id>
```

Handy for scripts — print just the token and capture it:

```bash
TOKEN=$(python cdb_get_token.py --env-file ../../.env --token-only)
curl -H "Authorization: Bearer $TOKEN" https://nxvms.com/cdb/systems
```

## Run the tests

```bash
pytest -v
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login failed: ... (HTTP 401/403)` | Wrong credentials, or 2FA required. | Re-check credentials; add `--mfa-code` for a 2FA account. |
| `Token response did not contain an access_token` | Wrong host, or an unexpected response. | Confirm `--host` is the cloud host, e.g. `https://nxvms.com`. |
| `Could not reach https://...` | Wrong host / no network. | Check `--host` (include `https://`, no trailing slash) and connectivity. |
| `SSLError` | TLS trust problem. | Lab only: add `--insecure`. |

## Where to go next

- `../cdb-oauth2-list-systems` — uses this same token to list your Sites.
- `../rest-list-cameras-cloud-user` — uses a **site-scoped** token (set
  `--cloud-site-id`) to list a site's cameras via the relay.

## Files

| File | Purpose |
|------|---------|
| `cdb_get_token.py` | The sample. Run it directly. |
| `test_cdb_get_token.py` | Offline tests (mocked HTTP). |
| `requirements.txt` | `requests` + `pytest`. |
