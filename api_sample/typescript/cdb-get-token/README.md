# Cloud CDB — Get an OAuth2 token (TypeScript)

TypeScript port of [`../../node_js/cdb-get-token`](../../node_js/cdb-get-token) (see
also the [Python version](../../python/cdb-get-token)). The smallest possible
authentication example: make **one** call, get a **bearer token**, print it.
Everything else in the Nx Cloud / site APIs is just "send this token in an
`Authorization: Bearer` header."

No third-party **runtime** dependencies — uses the built-in global `fetch` and
the built-in `node:test` runner. It runs directly on Node 22.6+ via native
**type stripping** (`node cdb_get_token.ts`) — there is no build step. The only
dependencies are dev-only (`typescript` + `@types/node`) for type-checking.

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

## Running TypeScript

These samples have **no build step**. Node 22.6+ strips the TypeScript types at
load time and runs the `.ts` file directly:

- **Requirement:** Node.js **22.6+** (native type stripping; this repo is
  developed against Node 22). For the built-in global `fetch` you need Node 18+,
  which 22 includes.
- **Run:** `node cdb_get_token.ts --dotenv ../../.env`
- **Test:** `node --test test_cdb_get_token.ts` (offline; mocked `fetch`).
- **Type-check:** from the `typescript/` root run `npm run typecheck`
  (`tsc --noEmit`). The shared `tsconfig.json` enforces the house style:
  `verbatimModuleSyntax`, `erasableSyntaxOnly`, `isolatedModules`,
  `allowImportingTsExtensions`. Shared API shapes are imported **type-only**
  from [`../nx-types.ts`](../nx-types.ts) so they erase completely at runtime.

## Prerequisites

- Node.js 22.6+ (type stripping) — see **Running TypeScript** above.
- An Nx Cloud account (email + password). The **tests need no account / network.**

## Install

No runtime dependencies to install. For type-checking only, install the dev
dependencies from the `typescript/` root:

```bash
cd ..        # the typescript/ folder
npm install  # installs typescript + @types/node (dev-only)
```

## Configure

Reuses the shared `NX_CLOUD_*` variables. Copy the template at the repo root:

```bash
cp ../../.env.example ../../.env   # then edit it
```

## Run

```bash
# Using the shared .env:
node cdb_get_token.ts --dotenv ../../.env

# Or fully on the command line:
node cdb_get_token.ts \
  --host https://nxvms.com \
  --user you@example.com \
  --password 'your-password'

# 2FA account:
node cdb_get_token.ts --dotenv ../../.env --mfa-code 123456

# Scope the token to one site:
node cdb_get_token.ts --dotenv ../../.env --cloud-site-id <site-id>
```

> **Why `--dotenv` and not `--env-file`?** Node 20.6+ reserves `--env-file` as
> a built-in flag. It scans *every* CLI argument (even ones after the script)
> and, if the file is missing, kills the process with a cryptic
> `node: <path>: not found` before this sample's code runs. Using `--dotenv`
> keeps error handling in the sample's hands. (The Python sample uses
> `--env-file`; there's no such collision in Python.)

Handy for scripts — print just the token and capture it:

```bash
TOKEN=$(node cdb_get_token.ts --dotenv ../../.env --token-only)
curl -H "Authorization: Bearer $TOKEN" https://nxvms.com/cdb/systems
```

## Run the tests

```bash
node --test test_cdb_get_token.ts
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
| `Unsupported file extension ".ts"` / strip errors | Node older than 22.6. | Upgrade to Node 22.6+ (this repo targets Node 22). |

## Where to go next

- [`../../node_js/cdb-get-token`](../../node_js/cdb-get-token) — the Node.js sample this is ported from.
- [`../../python/cdb-get-token`](../../python/cdb-get-token) — the original Python version.

## Files

| File | Purpose |
|------|---------|
| `cdb_get_token.ts` | The sample. Run it directly with `node cdb_get_token.ts`. |
| `test_cdb_get_token.ts` | Offline tests (`node:test`, mocked `fetch`). |
| `../nx-types.ts` | Shared API types, imported **type-only** (erased at runtime). |
| `../tsconfig.json` | Compiler settings for `npm run typecheck`. |
