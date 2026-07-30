# Nx API Samples — TypeScript

TypeScript versions of the Nx API samples, with full parity to the Python and
Node sets. All REST samples target the latest **`/rest/v4`** API.

**No build step, zero runtime dependencies.** The samples run directly on
**Node 22.6+** via native *type stripping* — Node erases the type annotations and
runs the file, so `node cdb-get-token/cdb_get_token.ts` just works. The only
dependencies are **dev-only** (`typescript` + `@types/node`) and are used purely
for editor support and `tsc --noEmit` type-checking. At runtime the samples use
only the built-in `fetch`, `node:test`, and `node:process` — nothing to install
to *run* or *test* them.

## Why TypeScript here

The point of these samples is to show the **shapes** of the Nx API. A shared
[`nx-types.ts`](nx-types.ts) describes the models once — token responses, sites,
cameras, event records, the event manifest, and the `fetch` seam — and every
sample imports them **type-only** (`import type { … } from "../nx-types.ts"`).
Because the imports are type-only, Node strips them entirely: there is no runtime
coupling between a sample and the shared file, yet the API surface is described
in one place and type-checked across all six samples.

## Samples

| Folder | What it shows | API | Tests |
|---|---|---|---|
| [`cdb-get-token`](cdb-get-token) | One login call → a bearer token | Cloud CDB | 14 |
| [`cdb-oauth2-list-systems`](cdb-oauth2-list-systems) | Login + `GET /cdb/systems` (your Sites), 2FA, token scope | Cloud CDB | 12 |
| [`cdb-refresh-token`](cdb-refresh-token) | Refresh without re-sending the password; rotation + on-disk persistence | Cloud CDB | 13 |
| [`rest-list-cameras`](rest-list-cameras) | Local-user login direct to one server + `GET /rest/v4/devices` | REST v4 | 10 |
| [`rest-list-cameras-cloud-user`](rest-list-cameras-cloud-user) | Scoped cloud token + site access via the relay (manual 307 + bearer) | REST v4 | 10 |
| [`rest-event-log`](rest-event-log) | Scoped token + relay 307 + event window/parsing + `--list-event-types` manifest | REST v4 | 30 |
| [`media-http-stream`](media-http-stream) | Save a live/archive video clip to a file — both auth modes, `media.{format}` streaming, relay 307 | REST v4 | 29 |
| [`rest-rule-schedule`](rest-rule-schedule) | Set an event rule's v4 schedule: `GET events/rules` + `PATCH events/rules/{id}` (Weekdays/Weekend/24x7 presets), both auth modes | REST v4 | 25 |
| [`virtual-camera-upload`](virtual-camera-upload) | Create a virtual camera and upload footage to it, both auth modes | REST v4 | 27 |

## Requirements

- **Node 22.6 or newer** (type stripping; enabled by default from Node 23.6).
  Check with `node --version`. Older Node will not run `.ts` directly.
- For type-checking only: `npm install` (pulls the dev-only `typescript` +
  `@types/node`).

## Run a sample

```bash
cd cdb-get-token
node cdb_get_token.ts --dotenv ../../.env       # add --insecure for self-signed certs
```

Like the Node samples, the CLI flag is **`--dotenv`** (not `--env-file`), and
config precedence is **CLI flag > environment variable > `.env`**. Credentials
are never hard-coded.

## Run the tests

Each sample ships offline tests (HTTP is mocked) that need no account and no
network:

```bash
cd cdb-get-token
node --test test_cdb_get_token.ts
```

> Note: a bare `node --test` finds nothing because the files are named
> `test_*.ts` (not Node's default `*.test.ts` glob). Pass the file(s) explicitly,
> e.g. `node --test test_*.ts`, or run every sample from this folder:
> `node --test "**/test_*.ts"`.

## Type-check

```bash
npm install        # once: dev-only typescript + @types/node
npm run typecheck  # tsc --noEmit across all samples + nx-types.ts
```

## Conventions (shared across all TypeScript samples)

- **No build, no bundler.** Run `.ts` directly on Node 22.6+; `tsconfig.json`
  exists only for type-checking and the editor.
- **Erasable syntax only** (`erasableSyntaxOnly`): no `enum`, `namespace`,
  parameter properties, or `import =` — only syntax Node can strip. String-literal
  union types stand in for enums.
- **Type-only shared imports** (`verbatimModuleSyntax`): models come from
  `../nx-types.ts` via `import type`, so they vanish at runtime.
- The API logic takes an injectable `fetchImpl: FetchImpl` (defaults to the global
  `fetch`) so tests run fully offline with a fake fetch — the same seam as the
  Node samples.
- **Bearer-token only**, latest **`/rest/v4`**, and the relay's **307 followed
  manually with the bearer re-attached** where the relay is involved.

## Relation to the other languages

Each folder mirrors the matching [`../node_js`](../node_js) and [`../python`](../python)
sample with the same behavior and matching offline tests. TypeScript uses
`--dotenv` (like Node). The browser samples live in [`../web`](../web), and the
C# versions in [`../csharp`](../csharp).
