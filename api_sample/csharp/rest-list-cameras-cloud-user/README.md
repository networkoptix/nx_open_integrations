# REST API — List a site's cameras with a CLOUD account (C#)

Lists the cameras on **one specific site** using your **cloud** login, via a
**site-scoped token** and the Cloud relay. C# port of
[`../../python/rest-list-cameras-cloud-user`](../../python/rest-list-cameras-cloud-user)
and [`../../node_js/rest-list-cameras-cloud-user`](../../node_js/rest-list-cameras-cloud-user).

```
Got site-scoped token for 1111....-5555

NAME          STATUS   MODEL          ID
Lobby Cam     Online   AXIS M3045-V   {a1b2...}
```

## The key idea: token scope

A cloud token comes in two flavours. A **cloud-wide** token (`POST
/cdb/oauth2/token` with no scope) is good for account calls like listing your
Sites, but a **site rejects it**. To call a site's API you must request the
token with `scope=cloudSystemId=<id>` — a **site-scoped** token.

## Flow walkthrough

The whole flow lives in **`src/NxCloudSiteClient.cs`** (`Program.cs` is just CLI
wiring). Three methods, in order:

**1 — `LoginAsync()`: trade cloud credentials for a site-scoped token.**
```csharp
["scope"] = $"cloudSystemId={_siteId}",   // <- what makes the token work on the site
// POST {cloud}/cdb/oauth2/token  ->  { "access_token": "nxcdb-…" }
Token = ExtractAccessToken(json);
```

**2 — `ListCamerasAsync()`: call the site through the relay.**
```csharp
string url = $"{RelayUrl}{Api}/devices";              // https://<siteId>.relay.vmsproxy.com/rest/v4/devices
using var response = await GetFollowingRedirectsAsync(url, ct);
return NormalizeCameras(json);                        // unwraps a bare array OR { "reply": [...] }
```
`GetFollowingRedirectsAsync` is the interesting part: the relay answers with a
**307** to the serving node, and .NET (like browsers) drops the `Authorization`
header across a cross-host redirect. So the client sets
`AllowAutoRedirect = false` and follows the 307 itself, **re-attaching the
bearer on each hop**.

**3 — `LogoutAsync()`: revoke the token (best-effort).**
```csharp
// DELETE {cloud}/cdb/oauth2/token/<token>
```

## Project layout

```
rest-list-cameras-cloud-user/
  src/    NxCloudSiteClient.cs  Config.cs  Program.cs  NxListCamerasCloud.csproj
  tests/  NxCloudSiteClientTests.cs  NxListCamerasCloud.Tests.csproj
```

## Prerequisites

- **.NET SDK 10.0+**
- A cloud account with access to the target site, and that site's **Cloud Site
  ID** (a UUID). Find it in the Nx desktop client.

## Run

```bash
cd src

dotnet run -- --env-file ../../../.env --insecure

# Or fully on the command line:
dotnet run -- \
  --cloud-host https://nxvms.com \
  --user you@example.com --password 'your-password' \
  --site-id 1111....-5555 --insecure
```

Add `--mfa-code 123456` if your cloud account has 2FA.

## Run the tests

```bash
cd tests
dotnet test
```

> Note: these tests were written but **not executed in the authoring
> environment** (no .NET SDK there). They use standard xUnit + a fake
> `HttpMessageHandler`; run `dotnet test` locally to confirm green. The 307
> test proves the bearer is re-attached across the relay hop.

## CLI flags

| Flag | Purpose |
|------|---------|
| `--cloud-host` | Cloud host, e.g. `https://nxvms.com` |
| `--user` / `--password` | Cloud credentials |
| `--site-id` | Cloud Site ID of the target site (UUID) |
| `--mfa-code` | One-time 2FA code |
| `--env-file` | Path to a `.env` file (default `.env`) |
| `--insecure` | Skip TLS verification (lab use only) |

Config precedence: **CLI > env var > `.env`** (`NX_CLOUD_HOST` / `NX_CLOUD_USER`
/ `NX_CLOUD_PASSWORD` / `NX_CLOUD_SITE_ID`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login rejected (HTTP 401/403)` | Bad credentials, wrong site id, or no access. | Re-check all three; add `--mfa-code` for 2FA. |
| `The site rejected the token` | Token not scoped to this site. | Confirm `--site-id`; scope must be `cloudSystemId=<that id>`. |
| `Could not reach https://<id>.relay.vmsproxy.com` | Site offline / not cloud-connected. | Confirm the site is online and cloud-connected. |
| TLS / certificate error | Relay/site TLS trust. | Lab only: add `--insecure`. |

## Files

| File | Purpose |
|------|---------|
| `src/NxCloudSiteClient.cs` | The API logic (login, list, logout, 307 follow, parsing). |
| `src/Config.cs` | `.env` reader, arg parser, CLI>env>.env precedence. |
| `src/Program.cs` | CLI wiring (`Main`); builds the no-auto-redirect HttpClient. |
| `tests/NxCloudSiteClientTests.cs` | Offline xUnit tests (fake `HttpMessageHandler`). |
