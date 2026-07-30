# REST Server API — List cameras, local user (TypeScript)

TypeScript port of [`../../node_js/rest-list-cameras`](../../node_js/rest-list-cameras)
(see also the [`Python version`](../../python/rest-list-cameras)), on the
**latest `/rest/v4`** API. Logs in to a single VMS server as a local user, lists
its cameras (devices), then logs out. No third-party **runtime** dependencies —
built-in `fetch` (Node 18+) and `node:test`. The only dependencies are dev-only
(`typescript` + `@types/node`) for type-checking.

Shared API types are imported type-only from [`../nx-types.ts`](../nx-types.ts),
so Node's type stripping removes them at runtime and each sample still runs on
its own.

## Running TypeScript

These samples run **directly on Node 22.6+** via native type stripping — no
build step. From this folder:

```bash
# Run the sample (type annotations are stripped at load time):
node rest_list_cameras.ts --dotenv ../../.env --insecure

# Run the offline tests:
node --test test_rest_list_cameras.ts

# Type-check the whole TypeScript tree (from ../, uses tsconfig.json):
npm run typecheck
```

> Type stripping is erasable-syntax-only: no enums, namespaces, parameter
> properties, or `import =`. The shared types are imported with `import type`,
> matching `verbatimModuleSyntax`.

## The flow (v4)

```
1. POST   {server}/rest/v4/login/sessions   {username, password, setCookie:false}  -> {"token": ...}
2. GET    {server}/rest/v4/devices          (Authorization: Bearer <token>)
3. DELETE {server}/rest/v4/login/sessions/<token>
```

> The v4 login request/response is identical to v3 (`{username, password,
> setCookie}` in, `{token}` out) — only the version segment changed.

## Run

```bash
# Local server with a self-signed cert (typical lab) -> use --insecure:
node rest_list_cameras.ts --dotenv ../../.env --insecure

# Fully on the command line:
node rest_list_cameras.ts \
  --host https://192.168.1.10:7001 \
  --user admin --password 'pw' \
  --insecure
```

`--host` is the server URL (`https` + port), or a relay address like
`https://<siteId>.relay.vmsproxy.com`. `--dotenv` is used instead of
`--env-file` (a Node built-in); see the `cdb-get-token` README for why.

## CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | Server URL, e.g. `https://192.168.1.10:7001` |
| `--user` / `--password` | Local server credentials |
| `--dotenv` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (usually needed for local servers) |

## Files

| File | Purpose |
|------|---------|
| `rest_list_cameras.ts` | The sample (`NxServerClient` + CLI), typed against `../nx-types.ts`. |
| `test_rest_list_cameras.ts` | Offline tests (`node:test`, mocked `fetch`). |
