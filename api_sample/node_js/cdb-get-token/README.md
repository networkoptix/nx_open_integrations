# Cloud CDB — Get an OAuth2 token (Node.js)

Node.js port of [`../../python/cdb-get-token`](../../python/cdb-get-token). The
smallest possible authentication example: make **one** call, get a **bearer
token**, print it. Everything else in the Nx Cloud / site APIs is just "send
this token in an `Authorization: Bearer` header."

No third-party dependencies — uses the built-in global `fetch` and the built-in
`node:test` runner.

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

- Node.js 18+ (for the built-in global `fetch`).
- An Nx Cloud account (email + password). The **tests need no account / network.**

## Install

No dependencies to install. Optionally:

```bash
npm install   # only sets up the bin/scripts; there are no packages to fetch
```

## Configure

Reuses the shared `NX_CLOUD_*` variables. Copy the template at the repo root:

```bash
cp ../../.env.example ../../.env   # then edit it
```

## Run

```bash
# Using the shared .env:
node cdb_get_token.mjs --dotenv ../../.env

# Or fully on the command line:
node cdb_get_token.mjs \
  --host https://nxvms.com \
  --user you@example.com \
  --password 'your-password'

# 2FA account:
node cdb_get_token.mjs --dotenv ../../.env --mfa-code 123456

# Scope the token to one site:
node cdb_get_token.mjs --dotenv ../../.env --cloud-site-id <site-id>
```

> **Why `--dotenv` and not `--env-file`?** Node 20.6+ reserves `--env-file` as
> a built-in flag. It scans *every* CLI argument (even ones after the script)
> and, if the file is missing, kills the process with a cryptic
> `node: <path>: not found` before this sample's code runs. Using `--dotenv`
> keeps error handling in the sample's hands. (The Python sample uses
> `--env-file`; there's no such collision in Python.)

Handy for scripts — print just the token and capture it:

```bash
TOKEN=$(node cdb_get_token.mjs --dotenv ../../.env --token-only)
curl -H "Authorization: Bearer $TOKEN" https://nxvms.com/cdb/systems
```

## Run the tests

```bash
node --test test_cdb_get_token.mjs
# or
npm test
```

## CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` | Cloud account email |
| `--password` | Cloud account password |
| `--mfa-code` | One-time 2FA code (only if your account has 2FA) |
| `--cloud-site-id` | Scope the token to one site (omit for cloud-wide) |
| `--dotenv` | Path to a `.env` file (default `.env`). Named to avoid Node's built-in `--env-file`. |
| `--insecure` | Skip TLS verification (lab use only) |
| `--token-only` | Print just the token string (handy for scripting) |

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login failed: ... (HTTP 401/403)` | Wrong credentials, or 2FA required. | Re-check credentials; add `--mfa-code` for a 2FA account. |
| `Token response did not contain an access_token` | Wrong host, or an unexpected response. | Confirm `--host` is the cloud host, e.g. `https://nxvms.com`. |
| `Could not reach https://...` | Wrong host / no network. | Check `--host` (include `https://`, no trailing slash) and connectivity. |
| TLS / certificate error | TLS trust problem. | Lab only: add `--insecure` (sets `NODE_TLS_REJECT_UNAUTHORIZED=0`). |

## Where to go next

- `../../python/cdb-oauth2-list-systems` — uses this same token to list your Sites.
- `../../python/rest-list-cameras-cloud-user` — uses a **site-scoped** token
  (set `--cloud-site-id`) to list a site's cameras via the relay.

## Files

| File | Purpose |
|------|---------|
| `cdb_get_token.mjs` | The sample. Run it directly. |
| `test_cdb_get_token.mjs` | Offline tests (`node:test`, mocked `fetch`). |
| `package.json` | `type: module`, `npm test` script. No dependencies. |
