# REST Server API — Log in & list cameras (C#)

Connects **directly to one VMS server/site** and lists its **cameras** (devices).
This is the sample that actually enumerates cameras — something the Cloud CDB
cannot do. C# port of
[`../../python/rest-list-cameras`](../../python/rest-list-cameras) and
[`../../node_js/rest-list-cameras`](../../node_js/rest-list-cameras).

```
Logged in to https://192.168.1.10:7001 as admin

NAME          STATUS   MODEL          ID
Lobby Cam     Online   AXIS M3045-V   {a1b2...}
Parking Cam   Online   Hanwha XNV     {c3d4...}
```

## Flow walkthrough

The whole flow lives in **`src/NxServerClient.cs`** (`Program.cs` is just CLI
wiring). It talks **directly** to a single server using bearer-token auth — no
cloud relay, no scoped cloud token. Three methods, in order:

**1 — `LoginAsync()`: trade local credentials for a bearer token.**
```csharp
// POST {host}/rest/v4/login/sessions  { username, password, setCookie:false }
//   ->  { "token": "..." }
Token = ExtractToken(json);
```

**2 — `ListCamerasAsync()`: GET the devices with the bearer token.**
```csharp
string url = $"{_host}{Api}/devices";                 // {host}/rest/v4/devices
request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", Token);
return NormalizeCameras(json);                         // unwraps a bare array OR { "reply": [...] }
```

**3 — `LogoutAsync()`: release the session (best-effort).**
```csharp
// DELETE {host}/rest/v4/login/sessions/<token>
```

## Project layout

```
rest-list-cameras/
  src/    NxServerClient.cs  Config.cs  Program.cs  NxListCameras.csproj
  tests/  NxServerClientTests.cs  NxListCameras.Tests.csproj
```

## Prerequisites

- **.NET SDK 10.0+**
- Network access to an Nx VMS server and a **local** server account
  (username/password). Cloud users use a different login flow — see the note below.
- The tests need neither a server nor a network.

## Configure

Uses `NX_SERVER_*` variables (separate from the cloud ones). They live in the same
shared template at the repo root:

```bash
cp ../../.env.example ../../.env   # then edit the NX_SERVER_* lines
```

- `NX_SERVER_HOST` — e.g. `https://192.168.1.10:7001` (include `https://` and the
  port), or a relay address `https://<siteId>.relay.vmsproxy.com`.
- `NX_SERVER_USER`, `NX_SERVER_PASSWORD` — a **local** server account.

## Run

```bash
cd src

# Local servers almost always use a self-signed cert, so --insecure is normal here:
dotnet run -- --env-file ../../../.env --insecure

# Or fully on the command line:
dotnet run -- \
  --host https://192.168.1.10:7001 \
  --user admin --password 'your-password' \
  --insecure
```

## Run the tests

```bash
cd tests
dotnet test
```

> Note: these tests were written but **not executed in the authoring
> environment** (no .NET SDK there). They use standard xUnit + a fake
> `HttpMessageHandler`; run `dotnet test` locally to confirm green.

## CLI flags

| Flag | Purpose |
|------|---------|
| `--host` | Server URL, e.g. `https://192.168.1.10:7001` |
| `--user` / `--password` | Local server credentials |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (usually needed for local servers) |

Config precedence: **CLI > env var > `.env`** (`NX_SERVER_HOST` / `NX_SERVER_USER`
/ `NX_SERVER_PASSWORD`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| TLS / certificate error | Local server uses a self-signed cert. | Add `--insecure` (expected for local servers). |
| `Could not reach https://...` | Wrong IP/port, server down, or firewall. | Confirm host + port `7001`, and that the server is reachable. |
| `Login unauthorized (HTTP 401/403)` | Wrong password, or this is a **cloud** user. | Use a local account. Cloud users need the cloud OAuth2 token flow (see note). |
| `Login response did not contain a token` | Hitting the wrong URL/version. | Confirm the host is a VMS server; this sample uses `/rest/v4`. |
| `No cameras found on this site` | The site genuinely has no devices, or the account lacks permission to see them. | Check in the Nx client; use an account that can view the cameras. |
| Raw `http://` refused | Bearer auth requires HTTPS. | Use `https://` (and the secure port). |

### Local vs. Cloud users

This sample logs in as a **local** server user. If you only have a **cloud**
account, the server delegates authentication to the cloud: you obtain a
site-scoped bearer token from the cloud and use it against the site. See the
companion sample
[`../rest-list-cameras-cloud-user`](../rest-list-cameras-cloud-user) for that flow.

## Files

| File | Purpose |
|------|---------|
| `src/NxServerClient.cs` | The API logic (login, list, logout, parsing). |
| `src/Config.cs` | `.env` reader, arg parser, CLI>env>.env precedence. |
| `src/Program.cs` | CLI wiring (`Main`); builds the HttpClient. |
| `tests/NxServerClientTests.cs` | Offline xUnit tests (fake `HttpMessageHandler`). |
