# Nx API Samples — Node.js

Node.js versions of the Nx API samples. Each is a self-contained folder with the
sample, an offline test suite, and its own README. All REST samples target the
latest **`/rest/v4`** API.

**Zero runtime dependencies.** Samples use Node's built-in `fetch` (Node 18+)
and the built-in `node:test` runner — nothing to `npm install` to run or test
them. Each folder still ships a `package.json` for the `npm test` shortcut.

## Samples

| Folder | What it shows | API | Tests |
|---|---|---|---|
| [`cdb-get-token`](cdb-get-token) | One login call → a bearer token | Cloud CDB | 14 |
| [`cdb-oauth2-list-systems`](cdb-oauth2-list-systems) | Login + `GET /cdb/systems` (your Sites), 2FA, token scope | Cloud CDB | 12 |
| [`cdb-refresh-token`](cdb-refresh-token) | Proactive + reactive refresh, rotation, disk persistence | Cloud CDB | 13 |
| [`rest-list-cameras`](rest-list-cameras) | Local-user login + `GET /rest/v4/devices` + logout | REST v4 | 10 |
| [`rest-list-cameras-cloud-user`](rest-list-cameras-cloud-user) | Scoped cloud token + site access via the relay | REST v4 | 10 |
| [`rest-event-log`](rest-event-log) | Scoped token, manual 307, v4 time window + parsing | REST v4 | 30 |
| [`media-http-stream`](media-http-stream) | Save a live/archive video clip to a file via `media.{format}`, both auth modes, relay 307 | REST v4 | 33 |
| [`rest-rule-schedule`](rest-rule-schedule) | Set an event rule's v4 schedule: `GET events/rules` + `PATCH events/rules/{id}` (presets + by-comment), both auth modes | REST v4 | 25 |
| [`virtual-camera-upload`](virtual-camera-upload) | Create a virtual camera and upload footage to it, both auth modes | REST v4 | 28 |
| [`jsonrpc-subscribe-events`](jsonrpc-subscribe-events) | Subscribe to the live event log over a JSON-RPC WebSocket | JSON-RPC | 16 |
| [`jsonrpc-subscribe-events-cloud-user`](jsonrpc-subscribe-events-cloud-user) | Same as above, but via a scoped cloud token and the cloud relay | JSON-RPC | 39 |

New to these? Read them top to bottom — that's the difficulty order.

> **Dependency note:** every sample above has zero runtime dependencies
> (built-in `fetch`). `jsonrpc-subscribe-events` and
> `jsonrpc-subscribe-events-cloud-user` are the exceptions — both need a
> WebSocket client, and Node's own built-in `WebSocket` only became stable in
> Node 22, so they use the `ws` package to stay on Node 18+. See their
> READMEs.

## Run any sample

```bash
cd <folder>
node <the_sample>.mjs --dotenv ../../.env       # add --insecure for local servers
node --test                                     # offline; no account or network
```

> **`--dotenv`, not `--env-file`:** Node 20.6+ reserves `--env-file` as a
> built-in flag that aborts the process if the file is missing, before the
> sample's own argument parsing runs. These samples use their own `--dotenv`
> flag instead.

## Conventions (shared across all Node samples)

- Each sample is a single runnable `.mjs` with a `main()` guarded by
  `import.meta.url === \`file://${process.argv[1]}\``.
- Core logic takes an injectable `fetchImpl` (defaults to global `fetch`) so
  tests run fully offline with a fake fetch — no account, no network.
- Flags follow **CLI > env var > `.env`** precedence; credentials are never
  hard-coded.
- `--insecure` disables TLS verification for lab/self-signed certs.
- `--dotenv` points at a shared `.env` (copy `../../.env.example`).

## Relation to the other languages

Every folder here has a matching [`../python`](../python) port with identical
behavior and matching offline tests, and a matching [`../typescript`](../typescript)
port that runs on the same runtime. The browser samples live in
[`../web`](../web), and the C# versions in [`../csharp`](../csharp).
