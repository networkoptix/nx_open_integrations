# Cloud CDB — get a bearer token (C#)

The smallest "how do I authenticate?" example. It makes one call to the Nx Cloud
and prints the bearer token you then put in an `Authorization: Bearer <token>`
header on every other CDB / site request. C# port of
[`../../python/cdb-get-token`](../../python/cdb-get-token) and
[`../../node_js/cdb-get-token`](../../node_js/cdb-get-token).

```
Token acquired.

access_token : nxcdb-xxxxxxxxxxxxxxxx
expires_in   : 3600 seconds

Use it on later requests as a header:
  Authorization: Bearer nxcdb-xxxxxxxxxxxxxxxx
```

## The one call

```
POST {cloud}/cdb/oauth2/token
Content-Type: application/json
{ "grant_type":"password", "response_type":"token", "client_id":"3rdParty",
  "username":"<cloud email>", "password":"<cloud password>" }
```

Optional body fields: `mfaCode` (2FA accounts) and `scope:"cloudSystemId=<id>"`
(scope the token to one site; omit for a cloud-wide token). The response's
`access_token` begins with `nxcdb-`.

## Project layout

```
cdb-get-token/
  src/    NxCloudTokenClient.cs  Config.cs  Program.cs  NxGetToken.csproj   ← the sample
  tests/  NxCloudTokenClientTests.cs  NxGetToken.Tests.csproj               ← offline xUnit
```

`NxCloudTokenClient` is the API logic (the part to read); `Program.cs` is just
CLI wiring. The client takes an `HttpClient`, so the tests inject one backed by a
fake handler and run with no account and no network.

## Prerequisites

- **.NET SDK 10.0+** (`dotnet --version`).

## Run

```bash
cd src

# Using the shared .env (copy ../../../.env.example to .env and fill it in):
dotnet run -- --env-file ../../../.env

# Or fully on the command line:
dotnet run -- --host https://nxvms.com --user you@example.com --password 'your-password'

# 2FA account, or scope the token to one site:
dotnet run -- --env-file ../../../.env --mfa-code 123456
dotnet run -- --env-file ../../../.env --cloud-site-id 1111....-5555

# Just the raw token (for scripting):
dotnet run -- --token-only --env-file ../../../.env
```

## Run the tests

```bash
cd tests
dotnet test
```

> Note: these tests were written but **not executed in the authoring
> environment** (no .NET SDK available there). They use only standard xUnit +
> a fake `HttpMessageHandler`; run `dotnet test` locally to confirm green.

## CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` / `--password` | Cloud credentials |
| `--mfa-code` | One-time 2FA code |
| `--cloud-site-id` | Scope the token to one site (omit for cloud-wide) |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--token-only` | Print just the raw token |

Config precedence: **CLI flag > environment variable > `.env`**
(`NX_CLOUD_HOST` / `NX_CLOUD_USER` / `NX_CLOUD_PASSWORD` / `NX_CLOUD_SITE_ID`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials. | Re-check email/password; add `--mfa-code` for 2FA. |
| `Could not reach …` | Wrong host or no network. | Check `--host` and connectivity. |
| TLS / certificate error | Self-signed cert. | Lab only: add `--insecure`. |

## Files

| File | Purpose |
|------|---------|
| `src/NxCloudTokenClient.cs` | The API logic (`NxCloudTokenClient`, `TokenResult`). |
| `src/Config.cs` | `.env` reader, arg parser, CLI>env>.env precedence. |
| `src/Program.cs` | CLI wiring (`Main`). |
| `tests/NxCloudTokenClientTests.cs` | Offline xUnit tests (fake `HttpMessageHandler`). |
