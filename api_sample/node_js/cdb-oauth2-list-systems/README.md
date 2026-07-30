# Cloud CDB — OAuth2 login + list Sites (Node.js)

Node.js port of [`../../python/cdb-oauth2-list-systems`](../../python/cdb-oauth2-list-systems).
Logs in with the OAuth2 password grant, gets a bearer token, then lists the
account's Sites. No third-party dependencies — built-in `fetch` (Node 18+) and
`node:test`.

## The flow

```
1. POST {cloud}/cdb/oauth2/token   -> bearer token
2. GET  {cloud}/cdb/systems        (Authorization: Bearer <token>)
```

The cloud lists **Sites**, not cameras. To list a site's cameras you need a
**site-scoped** token — see `../rest-list-cameras-cloud-user`.

## Run

```bash
node cdb_oauth2_sample.mjs --dotenv ../../.env

# Fully on the command line:
node cdb_oauth2_sample.mjs --host https://nxvms.com --user you@example.com --password 'pw'

# 2FA account:
node cdb_oauth2_sample.mjs --dotenv ../../.env --mfa-code 123456
```

> `--dotenv` is used instead of `--env-file` (a Node built-in); see the
> `cdb-get-token` README for why.

## Run the tests

```bash
node --test test_cdb_oauth2_sample.mjs   # or: npm test
```

## CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` / `--password` | Cloud credentials |
| `--mfa-code` | One-time 2FA code |
| `--cloud-site-id` | Scope the token to one site (omit for cloud-wide) |
| `--dotenv` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--debug` | Print the raw `/cdb/systems` JSON response |

## Files

| File | Purpose |
|------|---------|
| `cdb_oauth2_sample.mjs` | The sample (`NxCloudOAuthClient` + CLI). |
| `test_cdb_oauth2_sample.mjs` | Offline tests (`node:test`, mocked `fetch`). |
| `package.json` | `type: module`, `npm test` script. No dependencies. |
