# REST API — List cameras, cloud user via relay (TypeScript)

TypeScript port of [`../../node_js/rest-list-cameras-cloud-user`](../../node_js/rest-list-cameras-cloud-user)
(see also the [Python original](../../python/rest-list-cameras-cloud-user)),
on the latest **`/rest/v4`** API. Lists ONE site's cameras using a **cloud
account**, reaching the site through the Cloud relay with a **site-scoped**
token. Zero runtime dependencies — built-in `fetch` (Node 18+) and `node:test`.
Shared API shapes are imported type-only from [`../nx-types.ts`](../nx-types.ts),
so they are erased at runtime.

## Why this differs from the local-user sample

A cloud-wide token is **not** accepted by an individual site. You must request a
token scoped to the target site with `scope="cloudSystemId=<id>"`, then call the
site through its relay.

## The flow

```
1. POST   {cloud}/cdb/oauth2/token   (..., scope:"cloudSystemId=<id>")  -> scoped token
2. GET    https://<id>.relay.vmsproxy.com/rest/v4/devices   (Authorization: Bearer <token>)
3. DELETE {cloud}/cdb/oauth2/token/<token>
```

The relay may answer with an HTTP **307**; this sample uses `redirect:"manual"`
so the bearer header is handled deliberately and re-attached across the hop (see
`../../node_js/rest-event-log` for the full follow-the-redirect-with-bearer pattern).

## Running TypeScript

These samples run **directly on Node 22.6+** via native type stripping — there
is no build step. Node erases the type annotations at load time and runs the
result. The `tsconfig.json` enforces `erasableSyntaxOnly` and
`verbatimModuleSyntax`, so every annotation is purely erasable and type imports
use `import type`.

```bash
# Run the sample (Node 22.6+, no build):
node rest_cloud_sample.ts --dotenv ../../.env

# Fully on the command line:
node rest_cloud_sample.ts \
  --cloud-host https://nxvms.com \
  --user you@example.com --password 'pw' \
  --site-id <your-site-id>

# Run the offline tests:
node --test test_rest_cloud_sample.ts

# Type-check the whole TypeScript sample set (dev-only typescript + @types/node):
npm run typecheck
```

`--dotenv` is used instead of `--env-file` (a Node built-in); see the
`cdb-get-token` README for why.

## CLI flags

| Flag | Purpose |
|------|---------|
| `--cloud-host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` / `--password` | Cloud credentials |
| `--site-id` | Cloud Site ID of the target site (UUID) |
| `--mfa-code` | One-time 2FA code |
| `--dotenv` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |

## Files

| File | Purpose |
|------|---------|
| `rest_cloud_sample.ts` | The sample (`NxCloudSiteClient` + CLI), typed against `../nx-types.ts`. |
| `test_rest_cloud_sample.ts` | Offline tests (`node:test`, mocked `fetch`). |

Dependencies live in the shared [`../package.json`](../package.json):
`type: module`, `npm test` / `npm run typecheck` scripts, and dev-only
`typescript` + `@types/node`. No runtime dependencies.
