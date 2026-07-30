# Cloud CDB — Refresh-token session (C#)

Keeps a token-based session alive **without re-sending the password**. It wraps
`{access_token, refresh_token, expiry}` in a `TokenSession` and demonstrates the
three things you must do to keep a session healthy. C# port of
[`../../python/cdb-refresh-token`](../../python/cdb-refresh-token) and
[`../../node_js/cdb-refresh-token`](../../node_js/cdb-refresh-token).

```
login  : access_token=nxcdb-xxxxxxxxxxxxxxxx...  ~3600s to expiry  refresh_token=nxcdb-rrrrrrrrr...

Session saved to ./session.json — re-run without a password to resume.
```

## The idea

1. **Proactive refresh** — refresh shortly *before* the access token expires
   (a 60-second safety margin).
2. **Reactive refresh** — if a call still returns `401`, refresh once and retry.
3. **Rotation + storage** — always adopt the newest refresh token the server
   returns, and optionally persist the session to disk so it survives a restart.

## The calls

```
Login:    POST {cloud}/cdb/oauth2/token
          { grant_type:"password", response_type:"token",
            client_id:"3rdParty", username, password }

Refresh:  POST {cloud}/cdb/oauth2/token
          { grant_type:"refresh_token", response_type:"token",
            client_id:"3rdParty", refresh_token:"<latest refresh token>" }
```

The response's `access_token` begins with `nxcdb-`. Some deployments rotate the
`refresh_token` on every refresh; the sample always adopts the latest one.

## Project layout

```
cdb-refresh-token/
  src/    TokenSession.cs  Config.cs  Program.cs  NxRefreshToken.csproj   ← the sample
  tests/  TokenSessionTests.cs  NxRefreshToken.Tests.csproj               ← offline xUnit
```

`TokenSession` is the API logic (the part to read); `Program.cs` is just CLI
wiring. The session takes an `HttpClient` and a clock, so the tests inject a fake
handler and a controllable clock and run with no account and no network.

## Prerequisites

- **.NET SDK 10.0+** (`dotnet --version`).

## Run

```bash
cd src

# First login (acquires access + refresh tokens) and persist to a file:
dotnet run -- --env-file ../../../.env --store ./session.json

# Demonstrate a manual refresh + rotation:
dotnet run -- --env-file ../../../.env --store ./session.json --force-refresh

# Resume later WITHOUT a password (uses the saved/given refresh token):
dotnet run -- --host https://nxvms.com --store ./session.json
dotnet run -- --host https://nxvms.com --refresh-token <token>
```

> The `--store` file holds secrets and is written with `0600` permissions
> (on platforms that support Unix file modes).

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
| `--user` / `--password` | Cloud credentials (for the first login) |
| `--mfa-code` | One-time 2FA code |
| `--refresh-token` | Resume using this refresh token (skip the password) |
| `--store` | Persist the session to this file (holds secrets; `0600`) |
| `--force-refresh` | Do one refresh now to demonstrate rotation |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |
| `--debug` | Print the raw token JSON responses |

Config precedence: **CLI flag > environment variable > `.env`**
(`NX_CLOUD_HOST` / `NX_CLOUD_USER` / `NX_CLOUD_PASSWORD` / `NX_CLOUD_REFRESH_TOKEN`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials. | Re-check email/password; add `--mfa-code` for 2FA. |
| Refresh fails after resuming | The refresh token expired or was rotated away. | Log in again with `--user`/`--password` to get a fresh pair. |
| `Could not reach …` | Wrong host or no network. | Check `--host` and connectivity. |
| TLS / certificate error | Self-signed cert. | Lab only: add `--insecure`. |

## Files

| File | Purpose |
|------|---------|
| `src/TokenSession.cs` | The API logic (`TokenSession`, `TokenResponse`). |
| `src/Config.cs` | `.env` reader, arg parser, CLI>env>.env precedence. |
| `src/Program.cs` | CLI wiring (`Main`). |
| `tests/TokenSessionTests.cs` | Offline xUnit tests (fake `HttpMessageHandler` + clock). |
