# REST API, copy Device Agent settings to another device (TypeScript)

Downloads the settings an analytics Engine (a plugin, e.g. a motion or object
detector) keeps for one device's Device Agent, then applies them to another
device. Handy for rolling out the same analytics configuration across several
cameras that run the same plugin, without re-entering it by hand in the
client for each one.

```
$ node rest_copy_device_agent_settings.ts download \
      --device-id {cameraA-id} --engine-id {engine-id} \
      --dotenv ../../.env --insecure
Logged in to https://192.168.1.10:7001 as admin

Downloaded Device Agent settings for device {cameraA-id} (engine {engine-id}) -> nx-device-agent-settings-{cameraA-id}-20260916T031200Z.json

$ node rest_copy_device_agent_settings.ts apply \
      nx-device-agent-settings-{cameraA-id}-20260916T031200Z.json \
      --device-id {cameraB-id} --engine-id {engine-id} \
      --dotenv ../../.env --insecure --yes
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
   with `Authorization: Bearer <token>`. The answer must be a JSON object; it
   is written to a JSON file, unchanged apart from sorted keys.
3. Log out: `DELETE /rest/v4/login/sessions/<token>`. This runs whether the
   download worked or not.

**apply**

1. Check the file, before anything is sent: it must exist, not be a
   directory, parse as JSON, and hold a JSON object.
2. Log in, as above.
3. Set: `PUT /rest/v4/analytics/engines/{engineId}/deviceAgents/{deviceId}/settings`
   with a body built from the downloaded file, dropping `deviceId`,
   `engineId` and `_error`. Everything else (`values`, `model`,
   `analyzedStream`, `disableStreamSelection`, ...) is forwarded unchanged.
4. Log out, whether the call worked or not.

### Things worth knowing

- **The URL carries the identity, not the body.** `engineId` and `deviceId`
  appear only in the path for both calls, and are not even in the spec's PUT
  request body schema. The response echoes them back for your own reference,
  which is why they are dropped before the settings are re-sent to a
  different device.
- **One device per run.** `apply` writes to exactly one target. To roll the
  same settings out to several devices, call it again with a different
  `--device-id` (and `--engine-id`, if that device runs a different Engine
  instance): a small shell loop, not a flag on the sample.
- **The settings are opaque.** `values` is whatever name/value pairs that
  Engine's plugin defines; this sample does not know or validate their shape.
  If the target device is not running the Engine you named, the `PUT` is
  rejected and the sample reports that rather than guessing.
- **`_error` is the Engine's report, not a setting.** A downloaded file holds
  the source Engine's per-setting errors in `_error`; echoing them to another
  device means nothing, so `apply` drops them. The other way round, a `2xx`
  answer to the `PUT` can itself carry a non-empty `_error` map: the server
  took the settings but the Engine rejected some of them. The sample then
  prints `The server took the settings but the Engine reported errors:` with
  one `name: message` line each, and exits 1. An empty answer, or one without
  errors, is a success.
- **A lost connection after sending is reported as unknown, not as failed.**
  If the connection could not be made at all (refused, DNS, a failed TLS
  handshake), nothing was sent and the sample says the settings were not
  applied. If it drops, or the server stops answering, after the `PUT` went
  out, the server may have applied them, so the sample says `Outcome unknown:
  ... Download the device's settings to check.` Do that before applying again.
  A `5xx` answer is treated the same way: the server may have applied some of
  the settings before failing, so the sample says so instead of "not applied".
- **Redirects are not followed.** A `3xx` answer on any request is reported
  as a failure (`HTTP 302 (redirect not followed)`) rather than re-sent, with
  the bearer token, to wherever it points.
- **`download` never overwrites by accident.** Without `--force`, an existing
  destination (yours or the auto-named one) is refused before logging in, and
  the file is written beside it under a unique `.partial` name, owner-only,
  then linked into place, so a file that appears during the download is not
  clobbered either. On a filesystem without hard links (FAT, exFAT, many
  network shares) the move falls back to "refuse if it exists, else rename",
  which leaves a brief window between the check and the rename. With `--force`
  the move is an atomic replace. The side file is removed on every failure,
  and is never left behind by Ctrl-C.

## Prerequisites

- **Node 22.6+**, which runs `.ts` directly via native type stripping. No build
  step and no runtime dependencies.
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

## Install

Nothing to install to run or test this sample. The house's dev dependencies
(`typescript` and `@types/node`) are only needed for `npm run typecheck`:

```bash
cd ..            # the typescript/ folder
npm install
```

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
# Download settings from a device, to an auto-named file:
node rest_copy_device_agent_settings.ts download \
    --device-id {cameraA-id} --engine-id {engine-id} \
    --dotenv ../../.env --insecure

# Download to a path you choose:
node rest_copy_device_agent_settings.ts download \
    --device-id {cameraA-id} --engine-id {engine-id} --out settings.json \
    --dotenv ../../.env --insecure

# Apply a downloaded file to another device. This replaces that device's
# existing Device Agent settings, so it will not run without --yes:
node rest_copy_device_agent_settings.ts apply settings.json \
    --device-id {cameraB-id} --engine-id {engine-id} \
    --dotenv ../../.env --insecure --yes

# Apply to several devices: run it again per device.
for device in {cameraB-id} {cameraC-id}; do
  node rest_copy_device_agent_settings.ts apply settings.json \
      --device-id "$device" --engine-id {engine-id} \
      --dotenv ../../.env --insecure --yes
done
```

`--insecure` is normal against a lab server, whose certificate is self-signed.

## CLI flags

| Flag | Subcommand | Purpose |
|------|------------|---------|
| `download` | | Download a Device Agent's settings to a file. |
| `--out` | download | Where to write it. Default: an auto-named file in the current directory. |
| `--force` | download | Overwrite `--out` if it already exists. |
| `apply <file>` | | Load a downloaded settings file and send it to one target device. |
| `--yes` | apply | Required. Applying overwrites the target device's existing settings. |
| `--device-id` | both | The device this invocation concerns. Default: `NX_DEVICE_ID`. |
| `--engine-id` | both | The analytics Engine this invocation concerns. Default: `NX_ANALYTICS_ENGINE_ID`. |
| `--host` | both | `https://<server>:7001` |
| `--user` / `--password` | both | A local account with Power User or better. |
| `--dotenv` | both | Path to the shared `.env` (default `./.env`). Note the name: `--env-file` is a Node built-in flag, so this house uses `--dotenv`. |
| `--insecure` | both | Skip TLS verification (lab use only). |
| `--help` / `-h` | | Print the usage and exit 0. Only as a flag of its own: in `--password -h`, `-h` is the password. |

`--help` (or `-h`) prints the usage. Boolean flags take no value: `--yes=no` is an error, not a yes. A value flag
with nothing after it is an error too, and so is an empty one (`--out=`) or
one that is really the next flag (`--out --force`).

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Success (or `--help` / `-h`). A logout that fails afterwards is only a warning. |
| 1 | The call failed, the outcome is unknown, the Engine reported errors, or a guard refused. |
| 2 | Configuration is missing, or the command line was wrong (only the `ERROR: ...` line is printed; `--help` prints the usage). |
| 130 | Interrupted with Ctrl-C. The session is logged out first, and no side file is left behind. If the call finishes while that logout runs, its own result and exit code stand. Once the result (`Downloaded ...` / `Applied ...`, or the Engine-errors block) is printed the work is done: Ctrl-C during the final logout prints `WARNING: could not log out: interrupted.` and the run keeps its own exit code (0, or 1 after Engine errors). |

## Run the tests

```bash
node --test test_rest_copy_device_agent_settings.ts

# Or the whole TypeScript house, plus type-checking:
cd .. && npm test && npm run typecheck
```

Note that plain `node --test` finds nothing here; name the test file, or run
the house's `npm test`, which globs `test_*.ts`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login unauthorized (HTTP 401/403). Check the password, ...` | Wrong password, or a cloud account. | Use a local server account. Cloud users need the OAuth2 flow. |
| `Reading settings was refused (HTTP 401/403). This endpoint needs Power User or better.` (or `Applying settings was refused ...`) | The account is below Power User. | Use an account with Power User or better. |
| `Applying settings failed: HTTP 4xx. The settings were not applied. The target device may not be running this Engine.` | The target device is not running that Engine, or the settings don't match what its plugin expects. | Confirm the target has the same analytics plugin enabled, and that `--engine-id` is right for that device. |
| `Applying settings failed: HTTP 5xx. The server may have applied some of them; download the device's settings to check.` | The server failed while handling the `PUT`. | Run `download` against the target device to see what it has now. |
| `The server took the settings but the Engine reported errors:` | The Engine rejected some values, listed one per line as `<name>: <error>`. | Fix those values in the file (or on the source device) and apply again. |
| `Outcome unknown: the connection was lost after the settings were sent. Download the device's settings to check.` | The connection dropped, or the server stopped answering, after the `PUT` went out. | Run `download` against the target device to see what it has now. |
| `... HTTP 3xx (redirect not followed).` | `--host` points at something that redirects, such as a proxy or the wrong port. | Use the server's own `https://<server>:7001` address. |
| `Login failed: HTTP <n>.` / `Login failed: the response was not valid JSON.` / `Login failed: the response did not contain a token.` | `--host` is not an Nx server's REST API. | Check `--host`, including the port. |
| `<file> already exists; use --force` | The destination exists, or appeared during the download. | Choose another `--out`, or pass `--force`. |
| `could not use <out>: <reason>.` (for example `No such file or directory.` or `Permission denied.`) | The download could not be saved at `--out` (or the auto-generated name): its folder is missing, not writable, or the disk is full. | Create the folder, or choose another `--out`. |
| `<path> is a directory. Give --out a file path.` / `<path> is a directory, not a settings file.` | `--out`, or the file given to `apply`, is a folder. | Give a file path. |
| `Reading settings failed: HTTP <n>.` / `Reading settings failed: the server did not return a JSON object.` | The answer to the `GET` was an error, or not settings. | Check `--engine-id` and `--device-id`. |
| `<file> is not valid JSON: <reason>.` / `<file> does not hold a JSON object.` | The file given to `apply` is not a downloaded settings file. | Run `download` again, or fix the hand edit. |
| `Refusing to apply without --yes. This overwrites the target device's existing Device Agent settings.` | The guard did its job. | Re-run with `--yes` once you are sure of the target device. |
| `No such settings file: <file>` | The path given to `apply` does not exist. | Check the path, or run `download` first. |
| `--yes takes no value` (exit 2) | A boolean flag was given `=value`. | Pass the flag on its own. |
| `certificate verification failed. Local servers use a self-signed certificate, add --insecure.` | The lab server's self-signed certificate. On `apply`, followed by `The settings were not applied.` | Add `--insecure`. |
| `could not reach the server: <reason>.` (for example `no answer within 30 s.`, or `no connection within 10 s.` when the connection could not be made in time) | Wrong `--host` or port, the server is down, or DNS fails. On `apply`, nothing was sent: `The settings were not applied.` | Check `--host`, and that the server is running. |
| `Missing value for --out` (exit 2) | A value flag was given nothing, `=` with nothing, or another flag as its value. | Give the flag its value. |
| `WARNING: could not log out: <reason>.` (for example `Logout failed: HTTP <n>.`, `no answer within 30 s.`, or `interrupted.` after Ctrl-C) | The run printed its result (`Downloaded ...` / `Applied ...`, or the Engine-errors block), but the session could not be ended; the run keeps its exit code. When the run failed for another reason, a failed logout is not reported; only the real error is shown. | Nothing to redo; the session expires on its own. |

## Files

| File | Purpose |
|------|---------|
| `rest_copy_device_agent_settings.ts` | The sample (`NxServerClient` with `downloadSettings`/`applySettings`, plus the CLI). |
| `test_rest_copy_device_agent_settings.ts` | Offline tests (injected `fetch`). |

Types come from the shared `../nx-types.ts`, imported type-only, and the house
`package.json` and `tsconfig.json` are one level up. This sample declares no
dependencies of its own, which is deliberate rather than an omission.
