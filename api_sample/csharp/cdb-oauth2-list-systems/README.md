# Cloud CDB — OAuth2 login + list Sites (C#)

Logs in to the Nx Cloud with the **OAuth2 password grant**, gets a bearer token,
then lists the Sites registered to your account. This is the natural second step
after [`../cdb-get-token`](../cdb-get-token) (which only gets the token). C# port
of [`../../python/cdb-oauth2-list-systems`](../../python/cdb-oauth2-list-systems)
and [`../../node_js/cdb-oauth2-list-systems`](../../node_js/cdb-oauth2-list-systems).

```
Logged in as: you@example.com (bearer token acquired)

NAME             STATUS     VERSION  ID
HQ — Building A  activated  6.0      1111....-5555
Warehouse 3      activated  6.0      2222....-6666
```

## The calls

```
1. POST {cloud}/cdb/oauth2/token   -> bearer token
2. GET  {cloud}/cdb/systems        (Authorization: Bearer <token>)
```

The login body:

```
POST {cloud}/cdb/oauth2/token
Content-Type: application/json
{ "grant_type":"password", "response_type":"token", "client_id":"3rdParty",
  "username":"<cloud email>", "password":"<cloud password>" }
```

Optional body fields: `mfaCode` (2FA accounts) and `scope:"cloudSystemId=<id>"`.
The response's `access_token` begins with `nxcdb-`.

The cloud lists **Sites**, not cameras. To list a site's cameras you need a
**site-scoped** token — pass `--cloud-site-id` here to request a scoped token
instead of a cloud-wide one. (`GET /cdb/systems` is the wire endpoint name; the
data it returns are your Sites.)

## Project layout

```
cdb-oauth2-list-systems/
  src/    NxCloudOAuthClient.cs  Config.cs  Program.cs  NxOauth2ListSystems.csproj   ← the sample
  tests/  NxCloudOAuthClientTests.cs  NxOauth2ListSystems.Tests.csproj               ← offline xUnit
```

`NxCloudOAuthClient` is the API logic (the part to read); `Program.cs` is just
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

# 2FA account:
dotnet run -- --env-file ../../../.env --mfa-code 123456

# Scope the token to one site instead of a cloud-wide token:
dotnet run -- --env-file ../../../.env --cloud-site-id 1111....-5555

# Print the raw /cdb/systems JSON (to stderr) for debugging:
dotnet run -- --env-file ../../../.env --debug
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
| `--debug` | Print the raw `/cdb/systems` JSON response |

Config precedence: **CLI flag > environment variable > `.env`**
(`NX_CLOUD_HOST` / `NX_CLOUD_USER` / `NX_CLOUD_PASSWORD` / `NX_CLOUD_SITE_ID`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials. | Re-check email/password; add `--mfa-code` for 2FA. |
| `Token was rejected` | Expired token. | Re-run to log in again. |
| `Could not reach …` | Wrong host or no network. | Check `--host` and connectivity. |
| TLS / certificate error | Self-signed cert. | Lab only: add `--insecure`. |
| `No Sites found on this account.` | Account has no Sites, or lacks permission. | Confirm in the Nx cloud portal. |

## Files

| File | Purpose |
|------|---------|
| `src/NxCloudOAuthClient.cs` | The API logic (`NxCloudOAuthClient`, `SystemList`, `SystemsTable`). |
| `src/Config.cs` | `.env` reader, arg parser, CLI>env>.env precedence. |
| `src/Program.cs` | CLI wiring (`Main`). |
| `tests/NxCloudOAuthClientTests.cs` | Offline xUnit tests (fake `HttpMessageHandler`). |
