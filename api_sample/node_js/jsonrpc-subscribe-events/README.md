# JSON-RPC — Subscribe to the live event log (Node.js)

Instead of polling `GET /rest/v4/events/log`, this sample opens a single
**JSON-RPC WebSocket** connection and asks the server to push new events as
they happen.

## The flow

```
1. Open:        WS   {server}/jsonrpc
2. Log in:      "rest.v4.login.sessions.create"
                { username, password, setSession: true }
                setSession applies the resulting token to THIS socket --
                no separate REST call, no Authorization header.
3. Subscribe:   "rest.v4.events.log.all.subscribe"   { }
                -> reply #1: the current event log (same record shape as a
                   plain GET /rest/v4/events/log call)
                -> then: one pushed message per new event, for as long as
                   we stay subscribed
4. Unsubscribe: "rest.v4.events.log.all.unsubscribe" { }   (best-effort, on exit)
```

The sample listens **forever** once subscribed, until either you press
Ctrl+C or the server closes the connection on its own — both stop it the
same way: unsubscribe, close the socket, exit. See "What happens if
something goes wrong" below for how a server-side close is reported.

Every message on the wire is a JSON-RPC 2.0 envelope:
`{"jsonrpc":"2.0", "id": <n>, "method": "...", "params": {...}}` out,
`{"jsonrpc":"2.0", "id": <n>, "result": ...}` (or `"error"`) back. Pushed
notifications aren't numbered replies to anything we sent, so this sample
treats **any message that doesn't match a pending request id** as a live
notification — see `NxJsonRpcClient._onMessage()`.

## WS pacakge, dependency required

This sample needs a WebSocket client, and Node's own built-in `WebSocket`
only became stable in **Node 22**. To keep running on **Node 18+**, this
sample uses the [`ws`](https://www.npmjs.com/package/ws) package — its
only dependency.

## Run

```bash
npm install   # only needed once, for the 'ws' dependency

# Local server with a self-signed cert (typical lab) -> use --insecure:
node jsonrpc_subscribe_events.mjs --dotenv ../../.env --insecure

# Fully on the command line:
node jsonrpc_subscribe_events.mjs \
  --host https://192.168.1.10:7001 \
  --user admin --password 'pw' \
  --insecure
```

While it's listening, trigger anything that writes to the event log on that
site (create motions events, fire a soft trigger event, etc.) and it prints as a `(live)`
line.

Press **Ctrl+C** to stop and the sample unsubscribes and closes the socket.

## Run the tests

```bash
node --test test_jsonrpc_subscribe_events.mjs   # or: npm test
```

Tests run fully offline against `FakeWebSocket`, a small stand-in for `ws`'s
`WebSocket` — no server, no real socket, no network.

## What happens if something goes wrong

| Situation | Result |
|---|---|
| Login rejected (bad credentials) | `ApiError` |
| Any other JSON-RPC error reply | `ApiError` with the server's message and code |
| Network/DNS failure reaching the host | `ApiError`, no WebSocket ever opens |

## CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | Server URL, e.g. `https://192.168.1.10:7001`.|
| `--user` / `--password` | Local server credentials |
| `--dotenv` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (usually needed for local servers) |

## Files

| File | Purpose |
|------|---------|
| `jsonrpc_subscribe_events.mjs` | The sample (`NxJsonRpcClient` + CLI). |
| `test_jsonrpc_subscribe_events.mjs` | Offline tests (`node:test`, a fake WebSocket). |
| `package.json` | `type: module`, `npm test` script. One dependency: `ws`. |
