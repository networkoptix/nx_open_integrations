# Cloud CDB — Refresh-token session (Python)

Keeps a token-based session alive **without re-sending the password**. It wraps
`{access_token, refresh_token, expiry}` in a `TokenSession` and demonstrates the
three things you must do to keep a session healthy.

## The idea

1. **Proactive refresh** — refresh shortly *before* the access token expires
   (a 60-second safety margin).
2. **Reactive refresh** — if a call still returns `401`, refresh once and retry.
3. **Rotation + storage** — always adopt the newest refresh token the server
   returns, and optionally persist the session to disk so it survives a restart.

## The calls

```
Login:    POST {cloud}/cdb/oauth2/token
          { grant_type:"password", response_type:"token",
            client_id:"3rdParty", username, password }

Refresh:  POST {cloud}/cdb/oauth2/token
          { grant_type:"refresh_token", response_type:"token",
            client_id:"3rdParty", refresh_token:"<latest refresh token>" }
```

## Prerequisites

- Python 3.8+. The tests need neither an account nor a network.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Uses the shared `NX_CLOUD_*` variables (`cp ../../.env.example ../../.env`).

## Run

```bash
# First login (acquires access + refresh tokens) and persist to a file:
python cdb_refresh_token.py --env-file ../../.env --store ./session.json

# Demonstrate a manual refresh + rotation:
python cdb_refresh_token.py --env-file ../../.env --store ./session.json --force-refresh

# Resume later WITHOUT a password (uses the saved/given refresh token):
python cdb_refresh_token.py --host https://nxvms.com --store ./session.json
python cdb_refresh_token.py --host https://nxvms.com --refresh-token <token>
```

> The `--store` file holds secrets and is written with `0600` permissions.

## Run the tests

```bash
pytest -v
```

## CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` / `--password` | Cloud credentials (for the first login) |
| `--mfa-code` | One-time 2FA code |
| `--refresh-token` | Resume using this refresh token (skip the password) |
| `--store` | Persist the session to this file (holds secrets; `0600`) |
| `--force-refresh` | Do one refresh now to demonstrate rotation |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--debug` | Print the raw token JSON responses |

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials. | Re-check email/password; add `--mfa-code` for 2FA. |
| Refresh fails after resuming | The refresh token expired or was rotated away. | Log in again with `--user`/`--password` to get a fresh pair. |
| `SSLError` | TLS trust. | Lab only: add `--insecure`. |

## Files

| File | Purpose |
|------|---------|
| `cdb_refresh_token.py` | The sample (`TokenSession` + CLI). |
| `test_cdb_refresh_token.py` | Offline tests (mocked HTTP + clock). |
| `requirements.txt` | `requests` + `pytest`. |
