# REST Server API — List cameras, local user (Node.js)

Node.js port of [`../../python/rest-list-cameras`](../../python/rest-list-cameras),
updated to the **latest `/rest/v4`** API. Logs in to a single VMS server as a
local user, lists its cameras (devices), then logs out. No third-party
dependencies — built-in `fetch` (Node 18+) and `node:test`.

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
node rest_list_cameras.mjs --dotenv ../../.env --insecure

# Fully on the command line:
node rest_list_cameras.mjs \
  --host https://192.168.1.10:7001 \
  --user admin --password 'pw' \
  --insecure
```

`--host` is the server URL (`https` + port), or a relay address like
`https://<siteId>.relay.vmsproxy.com`. `--dotenv` is used instead of
`--env-file` (a Node built-in); see the `cdb-get-token` README for why.

## Run the tests

```bash
node --test test_rest_list_cameras.mjs   # or: npm test
```

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
| `rest_list_cameras.mjs` | The sample (`NxServerClient` + CLI). |
| `test_rest_list_cameras.mjs` | Offline tests (`node:test`, mocked `fetch`). |
| `package.json` | `type: module`, `npm test` script. No dependencies. |
