# Cloud CDB — Refresh-token session (TypeScript)

TypeScript port of [`../../node_js/cdb-refresh-token`](../../node_js/cdb-refresh-token)
(see also the [Python version](../../python/cdb-refresh-token)).
Keeps a token-based session alive without re-sending the password: it wraps
`{accessToken, refreshToken, expiry}` in a `TokenSession` and shows the three
things you must do to keep a session healthy.

No third-party runtime dependencies — built-in global `fetch` and `node:test`.
Shared API types are imported **type-only** from
[`../nx-types.ts`](../nx-types.ts), so Node's type stripping removes the import
at runtime and there is no runtime coupling.

## The idea

1. **Proactive refresh** — refresh shortly *before* the access token expires
   (`ensureValid()` checks a 60-second safety margin).
2. **Reactive refresh** — if a call still returns `401`, refresh once and retry
   (`authorizedGet()` does this).
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

## Running TypeScript

These samples run **directly on Node 22.6+** via native type stripping — there
is **no build step**. Node erases the type annotations and runs the `.ts` file
as-is. The shared types are imported with `import type`, and the test imports the
sample with an explicit `.ts` extension.

```bash
# First login (acquires access + refresh tokens) and persist to a file:
node cdb_refresh_token.ts --dotenv ../../.env --store ./session.json

# Demonstrate a manual refresh + rotation:
node cdb_refresh_token.ts --dotenv ../../.env --store ./session.json --force-refresh

# Resume later WITHOUT a password (uses the saved/given refresh token):
node cdb_refresh_token.ts --host https://nxvms.com --store ./session.json
node cdb_refresh_token.ts --host https://nxvms.com --refresh-token <token>
```

> The store file holds secrets and is written with `0600` permissions.
> `--dotenv` is used instead of `--env-file` (a Node built-in); see the
> `cdb-get-token` README for the full explanation.

## Run the tests

The **tests need no account / network.**

```bash
node --test test_cdb_refresh_token.ts
```

Type-check (dev-only; from the `typescript/` folder, needs `typescript` +
`@types/node` installed):

```bash
npm run typecheck
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
| `--dotenv` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--debug` | Print the raw token JSON responses |

## Files

| File | Purpose |
|------|---------|
| `cdb_refresh_token.ts` | The sample (`TokenSession` + CLI). |
| `test_cdb_refresh_token.ts` | Offline tests (`node:test`, mocked `fetch` + clock). |

## See also

- Node.js version: [`../../node_js/cdb-refresh-token`](../../node_js/cdb-refresh-token)
- Python version: [`../../python/cdb-refresh-token`](../../python/cdb-refresh-token)
- Shared TypeScript types: [`../nx-types.ts`](../nx-types.ts)
