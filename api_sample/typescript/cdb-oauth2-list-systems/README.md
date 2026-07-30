# Cloud CDB — OAuth2 login + list Sites (TypeScript)

TypeScript port of [`../../node_js/cdb-oauth2-list-systems`](../../node_js/cdb-oauth2-list-systems)
(see also the [Python version](../../python/cdb-oauth2-list-systems)).
Logs in with the OAuth2 password grant, gets a bearer token, then lists the
account's Sites. No third-party runtime dependencies — built-in `fetch`
(Node 18+) and `node:test`. Types come from the shared
[`../nx-types.ts`](../nx-types.ts) and are imported type-only.

## The flow

```
1. POST {cloud}/cdb/oauth2/token   -> bearer token
2. GET  {cloud}/cdb/systems        (Authorization: Bearer <token>)
```

The cloud lists **Sites**, not cameras. To list a site's cameras you need a
**site-scoped** token — see `../../node_js/rest-list-cameras-cloud-user`.

## Running TypeScript

These samples run directly on **Node 22.6+** via native type stripping — no
build step. The `.ts` files execute as-is; the types are erased at load time.

```bash
node cdb_oauth2_sample.ts --dotenv ../../.env

# Fully on the command line:
node cdb_oauth2_sample.ts --host https://nxvms.com --user you@example.com --password 'pw'

# 2FA account:
node cdb_oauth2_sample.ts --dotenv ../../.env --mfa-code 123456
```

> `--dotenv` is used instead of `--env-file` (a Node built-in); see the
> `cdb-get-token` README for why.

## Run the tests

```bash
node --test test_cdb_oauth2_sample.ts
```

## Type-check

```bash
# from the typescript/ folder:
npm run typecheck
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
| `cdb_oauth2_sample.ts` | The sample (`NxCloudOAuthClient` + CLI). |
| `test_cdb_oauth2_sample.ts` | Offline tests (`node:test`, mocked `fetch`). |

Types are shared in [`../nx-types.ts`](../nx-types.ts); dev-only tooling
(`typescript`, `@types/node`) lives in [`../package.json`](../package.json).
