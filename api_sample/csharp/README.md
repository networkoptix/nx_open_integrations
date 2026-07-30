# Nx API Samples — C#

C# (.NET 10) versions of the Nx API samples. Each is a self-contained folder with
the sample app, an offline test project, and its own README. All REST samples
target the latest **`/rest/v4`** API.

**No third-party runtime packages:** the samples use the framework's
`HttpClient` + `System.Text.Json`. The only dependency is **xUnit**, and only in
the test projects.

## Runtime requirement

These projects target **`net10.0`**, so the **.NET 10 SDK/runtime is required** to
run `dotnet test` / `dotnet run`. Check with `dotnet --version` (expect `10.x`).

If `dotnet` is missing, install the latest SDK (`brew install dotnet` on macOS, or
download from https://dotnet.microsoft.com/download). No roll-forward or
side-by-side runtime juggling is needed — the samples target the current LTS.

> **Heads-up on verification:** these C# samples were authored in an
> environment **without the .NET SDK**, so `dotnet build` / `dotnet test` were
> not run there. `cdb-get-token` and `rest-list-cameras-cloud-user` build clean
> on .NET 10 locally; the other four are newly ported and await a local
> `dotnet test`. The code follows standard .NET patterns and the tests use only
> xUnit + a fake `HttpMessageHandler` — run `dotnet test` locally to confirm
> green. (The Python and Node samples in this repo *were* run green.)

## Samples

Full parity with the Python set — all nine samples.

| Folder | What it shows | API | Tests |
|---|---|---|---|
| [`cdb-get-token`](cdb-get-token) | One login call → a bearer token | Cloud CDB | 14 |
| [`cdb-oauth2-list-systems`](cdb-oauth2-list-systems) | OAuth2 login + `GET /cdb/systems` (list your Sites), 2FA, token scope | Cloud CDB | 23 |
| [`cdb-refresh-token`](cdb-refresh-token) | Reuse a session without re-sending the password: proactive + reactive refresh, rotation, disk persistence | Cloud CDB | 21 |
| [`rest-list-cameras`](rest-list-cameras) | Local-user login direct to one VMS server + `GET /rest/v4/devices` + logout | REST v4 | 15 |
| [`rest-list-cameras-cloud-user`](rest-list-cameras-cloud-user) | Scoped cloud token + site access via the relay (manual 307 + bearer) | REST v4 | 15 |
| [`rest-event-log`](rest-event-log) | Scoped token + relay 307 + event-log time window/parsing + event-type manifest | REST v4 | 32 |
| [`media-http-stream`](media-http-stream) | Save a live/archive video clip to a file via `media.{format}`, both auth modes, relay 307 | REST v4 | 30 |
| [`rest-rule-schedule`](rest-rule-schedule) | Set an event rule's v4 schedule: `GET events/rules` + `PATCH events/rules/{id}` (presets + by-comment), both auth modes | REST v4 | 38 |
| [`virtual-camera-upload`](virtual-camera-upload) | Create a virtual camera and upload footage to it, both auth modes | REST v4 | 40 |

## Project layout (per sample)

```
<sample>/
  src/    <Client>.cs  Config.cs  Program.cs  <Name>.csproj      ← the runnable app
  tests/  <Client>Tests.cs  <Name>.Tests.csproj                  ← offline xUnit
  README.md
```

`src` holds the app; `tests` is a separate xUnit project that references it (the
idiomatic .NET split — `dotnet run` runs the app, `dotnet test` runs the tests).

## Run any sample

```bash
cd <sample>/src
dotnet run -- --env-file ../../../.env        # add --insecure for local/self-signed

cd ../tests
dotnet test                                    # offline; no account or network
```

## Conventions (shared across all C# samples)

- The API logic lives in a client class (e.g. `NxCloudTokenClient`); `Program.cs`
  is only CLI wiring.
- The client takes an injected `HttpClient`, so tests run fully offline with a
  fake `HttpMessageHandler` (the C# equivalent of the Node `fetchImpl` seam).
- `argparse`-style flags follow **CLI > env var > `.env`** precedence; a tiny
  `DotEnv` reader handles the file. Credentials are never hard-coded.
- **Bearer-token only**, latest **`/rest/v4`**, and the relay's **307 followed
  manually with the bearer re-attached** (.NET drops `Authorization` on a
  cross-host redirect, so `AllowAutoRedirect = false`).
- `--insecure` disables TLS verification for lab/self-signed certs.

## Relation to the other languages

Each folder mirrors the matching [`../python`](../python) and [`../node_js`](../node_js)
sample with the same behavior and matching offline tests. C# uses `--env-file`
(like Python; Node uses `--dotenv`).
