# REST Server API — Get a token from the mediaserver (C#)

The smallest possible **"how do I authenticate?"** sample. It gets a bearer token
from **one mediaserver**, uses it on a real authenticated request, hands it back,
and then proves the token is dead. No cameras, no events — just the session.

Fully covered by offline tests. .NET 10, `HttpClient` +
`System.Text.Json` — **no NuGet runtime dependencies** (xUnit is test-only).

```
Logged in to https://192.168.1.10:7001 as admin

token      : vms-4f1c9e2a-...
session id : {a1b2c3d4-...}
username   : admin
age        : 0 seconds
expires in : 600 seconds

Using the token: GET /rest/v4/login/sessions/current
  -> 200 OK, the server recognised the token. Session belongs to 'admin'.

Logging out: DELETE /rest/v4/login/sessions/current
  -> session deleted.

Re-checking with the same token: GET /rest/v4/login/sessions/current
  -> HTTP 401, the token is rejected. That is the expected result: logout worked.
```

## What the code does (Nx 5.0+ bearer-token auth)

1. **Get a token** — `POST /rest/v4/login/sessions` with `{username, password}` →
   `{id, username, token, ageS, expiresInS}`, parsed into a `LoginSession` record.
2. **Use the token** — `GET /rest/v4/login/sessions/current` with
   `Authorization: Bearer <token>`. The literal `current` (the v4 API also accepts
   `-`) means *"the token in my Authorization header"*, so this one call both
   proves the token works and shows you what a session actually contains.
3. **Revoke the token** — `DELETE /rest/v4/login/sessions/current` releases the
   session and the token with it. `current` again means "the token in my
   Authorization header".
4. **Confirm** — repeat step 2 with the same token. It now fails, which is the
   point: logout is something you can *see*, not take on faith.

### `TokenStillWorksAsync` does not throw

Step 4 uses `TokenStillWorksAsync(token)` → `TokenProbe(bool IsLive, int? Status)`
rather than `GetCurrentSessionAsync()`. That is deliberate: after logout, a **401
is the correct answer**, so raising on it would make the sample report an error at
the moment everything went right. `Status` is `null` when the request never landed
(unreachable server), which is a third outcome distinct from "rejected".

Everything else keeps the usual house behavior: 401/403 → `AuthException`,
other non-2xx → `ApiException`, `LogoutAsync` is best-effort and returns a `bool`.

### Where the token goes

The token goes in the `Authorization: Bearer <token>` header.

All three calls that need it address the session with the `current`
sentinel, so the request path is the same every time and the header is what
identifies the session. The `{token}`-in-path form is equally valid and is
what the other samples in this repo use.

### The `--insecure` TLS warning: nothing to suppress here

.NET does not print a warning on insecure TLS requests:
`HttpClientHandler.DangerousAcceptAnyServerCertificateValidator` disables
verification silently, so there is nothing here to suppress.

### Tokens expire

`ExpiresInS` is how many seconds you have. Plan on logging in again rather than
assuming a token lives forever. The `POST` body also accepts an optional
`durationS` to request a specific lifetime (capped by the site-wide limit); this
sample leaves it out and takes the site default.

## Prerequisites

- **.NET 10 SDK** (`dotnet --version`).
- Network access to an Nx mediaserver and a **local** server account
  (username/password). Cloud users use a different flow — see the note below.
- The tests need neither a server nor a network.

## Configure

Uses `NX_SERVER_*` variables, from the shared template at the repo root:

```bash
cp ../../.env.example ../../.env   # then edit the NX_SERVER_* lines
```

- `NX_SERVER_HOST` — e.g. `https://192.168.1.10:7001` (include `https://` and the
  port).
- `NX_SERVER_USER`, `NX_SERVER_PASSWORD` — a **local** server account.

Precedence is **CLI flag > environment variable > `.env` file**.

## Run

```bash
cd src

# Local servers almost always use a self-signed cert, so --insecure is normal here:
dotnet run -- --env-file ../../../.env --insecure

# Or fully on the command line:
dotnet run -- \
  --host https://192.168.1.10:7001 \
  --user admin \
  --password 'your-password' \
  --insecure
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--host` | — | Mediaserver URL, including `https://` and port |
| `--user` | — | Local server username |
| `--password` | — | Local server password |
| `--env-file` | `.env` | Path to a `KEY=VALUE` file |
| `--insecure` | off | Skip TLS verification (lab / self-signed certs) |

Note the `--` before the sample's own flags: everything after it goes to the
program rather than to `dotnet`.

## Run the tests

```bash
cd tests
dotnet test
```

> Note: these tests were written but **not executed in the authoring
> environment** (no .NET SDK there). They use standard xUnit + a fake
> `HttpMessageHandler`; run `dotnet test` locally to confirm green.

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Could not reach https://...` with a certificate error | Local server uses a self-signed cert. | Add `--insecure` (expected for local servers). |
| `Could not reach https://...` | Wrong IP/port, server down, or firewall. | Confirm host + port `7001`, and that the server is reachable. |
| `Login unauthorized (HTTP 401/403)` | Wrong password, or this is a **cloud** user. | Use a local account. Cloud users need the cloud OAuth2 flow (see note). |
| `Login response did not contain a token` | Hitting the wrong URL/version. | Confirm the host is a mediaserver; this sample uses `/rest/v4`. |
| Step 4 says the token is *still accepted* | The `DELETE` did not take effect. | Check the account may delete its own session; the token will still expire on its own after `ExpiresInS`. |
| `Unknown argument: --dotenv` | That flag is the Node/TypeScript spelling. | C# uses `--env-file`. |

### Local vs. Cloud users

This sample logs in as a **local** server user. If you only have a **cloud**
account, the server delegates authentication to the cloud: you get a token from
`POST /cdb/oauth2/token` with `scope=cloudSystemId=<id>` and use that against the
server instead. See [`../cdb-get-token`](../cdb-get-token) for the cloud
equivalent, and
[`../rest-list-cameras-cloud-user`](../rest-list-cameras-cloud-user) for using a
cloud token against a site.

### Next: use the token on a real resource

This sample deliberately stops at the session itself. To see the same token do
actual work, read [`../rest-list-cameras`](../rest-list-cameras) — identical
login, then `GET /rest/v4/devices` to list the site's cameras.

## Files

| File | Purpose |
|------|---------|
| `src/NxLoginClient.cs` | The API logic: the four calls, parsing, formatting. |
| `src/Config.cs` | `.env` reader, argument parser, CLI > env > file precedence. |
| `src/Program.cs` | CLI wiring only. |
| `src/NxGetToken.csproj` | net10.0 executable, no package references. |
| `tests/NxLoginClientTests.cs` | Offline xUnit tests (recording `HttpMessageHandler`). |
| `tests/NxGetToken.Tests.csproj` | net10.0 test project. |
