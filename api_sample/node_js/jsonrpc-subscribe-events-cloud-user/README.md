# JSON-RPC — Subscribe to the live event log, cloud user via relay (Node.js)

Cloud-user counterpart of [`../jsonrpc-subscribe-events`](../jsonrpc-subscribe-events).
Same live-push idea — one JSON-RPC WebSocket instead of polling
`GET /rest/v4/events/log` — but reached with a **cloud account** through the
**Cloud relay**, using a **site-scoped** token instead of a local server
username/password.

## Using Cloud Relay

A cloud-wide token isn't accepted by an individual site. So this sample:

1. Gets a token scoped to the target site (`scope=cloudSystemId=<id>`).
2. Opens the WebSocket directly at `{relay}/jsonrpc`, with
   `Authorization: Bearer <token>` on the handshake. (redirect while needed)
3. Subscribes / unsubscribes exactly like the local-user sample.
4. Deletes the scoped token on the cloud when done (best-effort).

The relay is always TLS, so this sample refuses a redirect to a non-`wss://`
location rather than falling back to an unencrypted connection.

> **Notice** : The [`ws`](https://www.npmjs.com/package/ws)
> package has a built-in `followRedirects: true` option that follows the
> relay's redirect on its own, preserving the `Authorization` header. For
> most apps that's the simpler.
> This sample follows the redirect by hand on purpose, to make the hand-off explicit:
> it shows exactly which statuses count as a redirect, where the `Location`
> header comes from, and why the bearer has to be resent.
> If you ever hit a case `followRedirects` doesn't handle the way you expect, 
>this manual loop is the fallback to drop in.

## The flow

```
1. POST  {cloud}/cdb/oauth2/token   (..., scope:"cloudSystemId=<id>")  -> scoped token
2. Open  wss://<site-id>.relay.vmsproxy.com/jsonrpc   (Authorization: Bearer <token> on the handshake)
         -> the relay redirects to the serving node; we follow it manually, same bearer
3. Subscribe:   "rest.v4.events.log.all.subscribe"   { limit: <--limit, default 100> }
                -> reply #1: the current event log, bounded by limit
                -> then: one pushed message per new event, for as long as we stay subscribed
4. Unsubscribe: "rest.v4.events.log.all.unsubscribe" { }   (on Ctrl+C, best-effort)
5. DELETE {cloud}/cdb/oauth2/token/<token>                  (best-effort)
```

The sample listens **forever** once subscribed — press Ctrl+C when you're
done. That triggers unsubscribe, a clean socket close, and the cloud token
delete before the process exits.

A keep-alive ping goes out every 25s to stop idle-timeout proxies from
silently dropping the connection. If the socket closes on its own anyway,
the sample prints why instead of hanging forever.

## WS pacakge, dependency required

Same as `../jsonrpc-subscribe-events`: every other Node sample in this repo
has **zero** runtime dependencies (built-in `fetch`). This one needs a
WebSocket client, and Node's own built-in `WebSocket` only became stable in
**Node 22**. To keep running on **Node 18+** like the rest of `node_js/`,
this sample uses the [`ws`](https://www.npmjs.com/package/ws) package — its
only dependency.

## Run

```bash
npm install   # only needed once, for the 'ws' dependency

node jsonrpc_subscribe_events_cloud_user.mjs --dotenv ../../.env

# Fully on the command line:
node jsonrpc_subscribe_events_cloud_user.mjs \
  --cloud-host https://nxvms.com \
  --user you@example.com --password 'pw' \
  --site-id <your-site-id>
```

While it's listening, trigger anything that writes to the event log on that
site (unplug a camera, fire a soft trigger, etc.) and it prints as a `(live)`
line. Press **Ctrl+C** when you're done.

`--dotenv` is used instead of `--env-file` (a Node built-in); see the
`cdb-get-token` README for why.

## Run the tests

```bash
node --test test_jsonrpc_subscribe_events_cloud_user.mjs   # or: npm test
```

Tests run fully offline against a fake `fetch` (for login/logout) and
`FakeWebSocket` (for the socket, including the relay's manual redirect) — no
server, no cloud, no network.

## What happens if something goes wrong

| Situation | Result |
|---|---|
| Token rejected (HTTP 401/403) | `AuthError` — check the token's `cloudSystemId` scope |
| Relay redirects to a non-`wss://` location | `ApiError` — never falls back to an unencrypted connection |
| Any other unexpected handshake response | `ApiError` |
| Network/DNS failure reaching the relay | `ApiError`, no WebSocket ever opens |
| Socket closes on its own after connecting | Printed to stdout with the close code, not silent |
| Relay keeps redirecting past `MAX_REDIRECTS` | `ApiError` — likely means the site isn't reachable; confirm via Nx Cloud or the web admin |
| Initial event log reply is too large | `--limit` (default 100) bounds it; `--max-payload-mb` raises the frame ceiling as a backstop |

## CLI flags

| Flag | Purpose |
|------|---------|
| `--cloud-host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` / `--password` | Cloud credentials |
| `--site-id` | Cloud Site ID of the target site (UUID) |
| `--mfa-code` | One-time 2FA code |
| `--dotenv` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--limit` | Cap the initial event log snapshot (default `100`) |
| `--max-payload-mb` | Max WebSocket frame size in MiB (default `100`) |

## Files

| File | Purpose |
|------|---------|
| `jsonrpc_subscribe_events_cloud_user.mjs` | The sample (`NxCloudJsonRpcClient` + CLI). |
| `test_jsonrpc_subscribe_events_cloud_user.mjs` | Offline tests (`node:test`, mocked `fetch`, a fake WebSocket). |
| `package.json` | `type: module`, `npm test` script. One dependency: `ws`. |
