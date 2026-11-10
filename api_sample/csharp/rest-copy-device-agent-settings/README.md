# REST API, copy Device Agent settings to another device (C#)

Downloads the settings an analytics Engine (a plugin, e.g. a motion or object
detector) keeps for one device's Device Agent, then applies them to another
device. Handy for rolling out the same analytics configuration across several
cameras that run the same plugin, without re-entering it by hand in the
client for each one.

```
$ dotnet run -- download \
      --device-id {cameraA-id} --engine-id {engine-id} \
      --env-file ../../../.env --insecure
Logged in to https://192.168.1.10:7001 as admin

Downloaded Device Agent settings for device {cameraA-id} (engine {engine-id}) -> nx-device-agent-settings-{cameraA-id}-20260916T031200Z.json

$ dotnet run -- apply \
      nx-device-agent-settings-{cameraA-id}-20260916T031200Z.json \
      --device-id {cameraB-id} --engine-id {engine-id} \
      --env-file ../../../.env --insecure --yes
Logged in to https://192.168.1.10:7001 as admin

Applied Device Agent settings to device {cameraB-id} (engine {engine-id}).
```

To copy the same settings onto more devices, run `apply` again with a
different `--device-id`, one call per target device.

## What the code does

**download**

1. Log in: `POST /rest/v4/login/sessions` with `{username, password}`, which
   returns `{"token": ...}`.
2. Get: `GET /rest/v4/analytics/engines/{engineId}/deviceAgents/{deviceId}/settings`
   with `Authorization: Bearer <token>`. The reply must be a JSON object. It
   is written to a JSON file, unchanged, without ever overwriting a file you
   did not ask to overwrite (see below).
3. Log out: `DELETE /rest/v4/login/sessions/<token>`. This runs on every
   path, after a failure too.

**apply**

1. Check the file before logging in: it must exist, not be a directory,
   parse as JSON, and hold a JSON object at the top level.
2. Log in, as above.
3. Set: `PUT /rest/v4/analytics/engines/{engineId}/deviceAgents/{deviceId}/settings`
   with a body built from the downloaded file, dropping `deviceId`,
   `engineId` and `_error`. Everything else, `values`, `model`,
   `analyzedStream`, `disableStreamSelection`, is forwarded unchanged.
4. Log out, on every path, after a failure too. A logout that fails after a
   successful apply is printed as a `WARNING` and does not change the result.

### Things worth knowing

- **The URL carries the identity, not the body.** `engineId` and `deviceId`
  appear only in the path for both calls, and are not even in the spec's PUT
  request body schema. The response echoes them back for your own reference,
  which is why they are dropped before the settings are re-sent to a
  different device.
- **`_error` is dropped, then checked.** In a downloaded file `_error` is the
  source device's error map from its last settings operation, so it is not
  sent back. In the `PUT` reply, a non-empty `_error` map means the server
  took the settings but the Engine reported errors: the sample prints
  `The server took the settings but the Engine reported errors:` and one
  `name: message` line per error, and exits 1. A `2xx` with an empty body,
  a JSON body without errors, or a body that is not JSON counts as applied.
- **Lost connection, unknown outcome.** If the connection could not be made
  at all (refused, DNS, TLS, connect timeout) the sample says it could not
  reach the server and that the settings were not applied. If it drops, or
  times out, after the `PUT` may have been sent, the sample cannot know
  whether the settings landed, and says
  `Outcome unknown: the connection was lost after the settings were sent. Download the device's settings to check.`
- **Redirects are not followed.** Any `3xx` is a failure, reported as for
  example `HTTP 302 (redirect not followed)`. So is any other non-`2xx`.
- **What a failed `PUT` means.** A `3xx` or `4xx` is reported with
  `The settings were not applied.` (a `4xx` adds that the target device may
  not be running this Engine). A `5xx` may have failed part-way, so it says
  `The server may have applied some of them; download the device's settings to check.`
- **No-clobber download.** The JSON is first written to a side file
  `<out>.<random>.partial` (created new, owner-only), then moved into place.
  Without `--force` the move refuses a file that appeared at that name while
  the download ran, the auto-generated name included; with `--force` the
  old file is replaced atomically. The side file never stays behind.
- **One device per run.** `apply` writes to exactly one target. To roll the
  same settings out to several devices, call it again with a different
  `--device-id` (and `--engine-id`, if that device runs a different Engine
  instance): a small shell loop, not a flag on the sample.
- **The settings are opaque.** `values` is whatever name/value pairs that
  Engine's plugin defines; this sample does not know or validate their shape.
  If the target device is not running the Engine you named, the `PUT` is
  rejected and the sample reports that rather than guessing.

## Project layout

```
rest-copy-device-agent-settings/
  src/    NxServerClient.cs  Config.cs  Program.cs  NxCopyDeviceAgentSettings.csproj
  tests/  NxServerClientTests.cs  ProgramTests.cs  NxCopyDeviceAgentSettings.Tests.csproj
```

## Prerequisites

- **.NET SDK 10.0+**
- A server account with **Power User** or better, for both the source and
  target devices.
- The source and target devices must run the Device Agent for the given
  Engine (i.e. that analytics plugin must be enabled on them).

The tests need neither a server nor a network.

## Finding the device and engine ids

- **Device id**: see the support article
  [How to find device IDs](https://support.networkoptix.com/hc/en-us/articles/41797563591447-How-to-find-device-IDs).
- **Engine id**: call `GET /rest/v4/analytics/engines` (any authenticated user).
  It returns every Analytics Engine on the site as `{id, name, integrationId}`;
  match the `name` you see in the client's Analytics Engines list to its `id`.

## Configure

Uses the shared server variables, plus two more. Copy the template at the
repo root:

```bash
cp ../../.env.example ../../.env   # then edit it
```

Fill in:

| Variable | What it means here |
|---|---|
| `NX_SERVER_HOST` | The server both devices live on, with scheme and port, for example `https://192.168.1.10:7001`. |
| `NX_SERVER_USER` | A local account with Power User or better. |
| `NX_SERVER_PASSWORD` | That account's password. |
| `NX_DEVICE_ID` | Default for `--device-id`: the device this invocation concerns (the source for `download`, the target for `apply`). |
| `NX_ANALYTICS_ENGINE_ID` | Default for `--engine-id`: the analytics Engine this invocation concerns. |

Because `NX_DEVICE_ID` and `NX_ANALYTICS_ENGINE_ID` mean "the device/engine
for *this* run", pass `--device-id` and `--engine-id` explicitly on the
command line for `apply` rather than relying on the `.env` default, so a
stale environment variable can't send settings to the wrong device.

## Run

```bash
cd src

# Download settings from a device, to an auto-named file:
dotnet run -- download \
    --device-id {cameraA-id} --engine-id {engine-id} \
    --env-file ../../../.env --insecure

# Download to a path you choose:
dotnet run -- download \
    --device-id {cameraA-id} --engine-id {engine-id} --out settings.json \
    --env-file ../../../.env --insecure

# Apply a downloaded file to another device. This replaces that device's
# existing Device Agent settings, so it will not run without --yes:
dotnet run -- apply settings.json \
    --device-id {cameraB-id} --engine-id {engine-id} \
    --env-file ../../../.env --insecure --yes

# Apply to several devices: run it again per device.
for device in {cameraB-id} {cameraC-id}; do
  dotnet run -- apply settings.json \
      --device-id "$device" --engine-id {engine-id} \
      --env-file ../../../.env --insecure --yes
done
```

`--insecure` is normal against a lab server, whose certificate is self-signed.

## CLI flags

| Flag | Subcommand | Purpose |
|------|------------|---------|
| `download` | | Download a Device Agent's settings to a file. |
| `--out` | download | Where to write it. Default: an auto-named file in the current directory. |
| `--force` | download | Overwrite `--out` if it already exists (or appears during the download). |
| `apply <file>` | | Load a downloaded settings file and send it to one target device. |
| `--yes` | apply | Required. Applying overwrites the target device's existing settings. |
| `--device-id` | both | The device this invocation concerns. Default: `NX_DEVICE_ID`. |
| `--engine-id` | both | The analytics Engine this invocation concerns. Default: `NX_ANALYTICS_ENGINE_ID`. |
| `--host` | both | `https://<server>:7001` |
| `--user` / `--password` | both | A local account with Power User or better. |
| `--env-file` | both | Path to the shared `.env` (default `.env`). |
| `--insecure` | both | Skip TLS verification (lab use only). |

Boolean flags (`--yes`, `--force`, `--insecure`) take no value: `--yes=no` is
a command-line error, not a yes. A value flag with nothing after it (`--out`
at the end, `--out --force`, `--host=`) is a command-line error too.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Success. |
| 1 | The call failed, the outcome is unknown, the Engine reported errors, or a guard refused. |
| 2 | Configuration is missing, or the command line was wrong. |
| 130 | Interrupted with Ctrl-C. The side file is removed and the session logged out first (the logout gets at most 3 s). A second Ctrl-C ends the process at once, without that cleanup. Once the run has a result (the `Downloaded ...` or `Applied ...` line, or the Engine-errors block) a Ctrl-C during the final logout prints `WARNING: could not log out: interrupted.` and the exit code stays what it was: 0 after success, 1 after Engine errors. |

## Run the tests

```bash
cd tests
dotnet test
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login unauthorized (HTTP 401/403). Check the password, ...` | Wrong password, or a cloud account. | Use a local server account. Cloud users need the OAuth2 flow. |
| `Reading settings was refused (HTTP 401/403). This endpoint needs Power User or better.` (or `Applying settings was refused ...`) | The account is below Power User. | Use an account with Power User or better. |
| `Login failed: HTTP <n>.` / `Login failed: the response was not valid JSON.` / `Login failed: the response did not contain a token.` | The host answered, but not as a VMS login endpoint. | Check `--host`: the scheme, address and port number of the server itself. |
| `... HTTP 3xx (redirect not followed).` | The host redirects, for example http to https, or a proxy in front. | Point `--host` at the final URL. |
| `Applying settings failed: HTTP 4xx. The settings were not applied. The target device may not be running this Engine.` | The target device is not running that Engine, or the settings don't match what its plugin expects. | Confirm the target has the same analytics plugin enabled, and that `--engine-id` is right for that device. |
| `Applying settings failed: HTTP 5xx. The server may have applied some of them; download the device's settings to check.` | The server failed while handling the settings. | `download` from the target device and compare; check the server log. |
| `could not use <out>: <reason>.` (for example `No such file or directory` or `Permission denied`) | Saving the download failed here: `--out` is in a missing folder, the folder is not writable, or the disk is full. The side file is removed. | Check the `--out` path and its folder. |
| `could not use <file>: <reason>.` on `apply` | The settings file exists but cannot be read, for example `Permission denied`. Nothing was sent. | Check the file's permissions. |
| `<file> already exists; use --force` | `--out` already exists (a symlink counts, even one whose target is missing), or appeared during the download. | Choose another `--out`, or pass `--force`. |
| `The server took the settings but the Engine reported errors:` | The plugin rejected some values on the target device. | Read the `name: message` lines (a message the server sent as JSON `null` reads `null`); fix those values in the file and apply again. |
| `Outcome unknown: the connection was lost after the settings were sent. Download the device's settings to check.` | The connection dropped or timed out after the `PUT` went out. | `download` from the target device and compare. |
| `could not reach the server: <reason>.` (on `apply` it adds `The settings were not applied.`) | Wrong host or port, server down, DNS. | Check `--host` and that the server is running. |
| `could not reach the server: no connection within 10 s (<host:port>).` | Nothing answered the TCP connect: a firewall dropping packets, or a wrong address. | Check `--host`, including the port; nothing was changed. |
| `could not reach the server: no answer within 30 s.` | The server took the connection but did not answer in time. | Check the server is healthy; on `download`, try again. |
| `<file> is not valid JSON: <reason>.` / `<file> does not hold a JSON object.` | The file given to `apply` is not a downloaded settings file. | Use a file written by `download`. |
| `<path> is a directory. Give --out a file path.` / `<path> is a directory, not a settings file.` | `apply` or `--out` was given a folder. | Give a file path. |
| `Refusing to apply without --yes. This overwrites the target device's existing Device Agent settings.` | The guard did its job. | Re-run with `--yes` once you are sure of the target device. |
| `No such settings file: <file>` | The path given to `apply` does not exist. | Check the path, or run `download` first. |
| `certificate verification failed. Local servers use a self-signed certificate, add --insecure.` | The lab server's self-signed certificate (on `apply` it adds `The settings were not applied.`). | Add `--insecure`. |
| `Reading settings failed: HTTP <n>.` / `Reading settings failed: the server did not return a JSON object.` | The server answered the `GET` with an error, or with something that is not settings. | Check `--host`, `--engine-id` and `--device-id`. |
| `Missing value for --<flag>` / `--<flag> takes no value` (exit 2) | A value flag was given nothing, or a boolean flag was given `=value`. | Give value flags a value; write boolean flags on their own. |
| `WARNING: could not log out: <reason>.` (for example `Logout failed: HTTP <n>`, `no answer within 30 s`, or `interrupted` after Ctrl-C) | The session could not be ended after the run had its result (the success line or the Engine-errors block); the exit code is unaffected. After any other failure the logout stays silent and only the real error is shown. | Nothing to redo; the session expires on its own. |

## Files

| File | Purpose |
|------|---------|
| `src/NxServerClient.cs` | The API logic (login, download/apply settings, logout, the settings <-> PUT body helpers). |
| `src/Config.cs` | `.env` reader, arg parser, CLI>env>.env precedence. |
| `src/Program.cs` | CLI wiring (`Main`); builds the `HttpClient`, dispatches `download`/`apply`. |
| `tests/NxServerClientTests.cs` | Offline xUnit tests of the client and config (fake `HttpMessageHandler`). |
| `tests/ProgramTests.cs` | Offline xUnit tests of the whole CLI: guards, messages, exit codes, logout on every path. |
