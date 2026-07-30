# REST API — List cameras, cloud user via relay (Node.js)

Node.js port of [`../../python/rest-list-cameras-cloud-user`](../../python/rest-list-cameras-cloud-user),
on the latest **`/rest/v4`** API. Lists ONE site's cameras using a **cloud
account**, reaching the site through the Cloud relay with a **site-scoped**
token. No third-party dependencies — built-in `fetch` (Node 18+) and `node:test`.

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
so the bearer header is handled deliberately (see `../rest-event-log` for the
full follow-the-redirect-with-bearer pattern).

## Run

```bash
node rest_cloud_sample.mjs --dotenv ../../.env

# Fully on the command line:
node rest_cloud_sample.mjs \
  --cloud-host https://nxvms.com \
  --user you@example.com --password 'pw' \
  --site-id <your-site-id>
```

`--dotenv` is used instead of `--env-file` (a Node built-in); see the
`cdb-get-token` README for why.

## Run the tests

```bash
node --test test_rest_cloud_sample.mjs   # or: npm test
```

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
| `rest_cloud_sample.mjs` | The sample (`NxCloudSiteClient` + CLI). |
| `test_rest_cloud_sample.mjs` | Offline tests (`node:test`, mocked `fetch`). |
| `package.json` | `type: module`, `npm test` script. No dependencies. |
