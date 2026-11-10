# REST API, copy Device Agent settings to another device (Node.js)

Downloads the settings an analytics Engine (a plugin, e.g. a motion or object
detector) keeps for one device's Device Agent, then applies them to another
device. Handy for rolling out the same analytics configuration across several
cameras that run the same plugin, without re-entering it by hand in the
client for each one.

```
$ node rest_copy_device_agent_settings.mjs download \
      --device-id {cameraA-id} --engine-id {engine-id} \
      --dotenv ../../.env --insecure
Logged in to https://192.168.1.10:7001 as admin

Downloaded Device Agent settings for device {cameraA-id} (engine {engine-id}) -> nx-device-agent-settings-{cameraA-id}-20260916T031200Z.json

$ node rest_copy_device_agent_settings.mjs apply \
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
   with `Authorization: Bearer <token>`. The answer must be a JSON object;
   it is written to a JSON file, unchanged.
3. Log out: `DELETE /rest/v4/login/sessions/<token>`, whether or not step 2
   worked.

**apply**

1. Log in, as above.
2. Set: `PUT /rest/v4/analytics/engines/{engineId}/deviceAgents/{deviceId}/settings`
   with a body built from the downloaded file, dropping `deviceId`,
   `engineId` and `_error`. Everything else, `values`, `model`,
   `analyzedStream`, `disableStreamSelection`, is forwarded unchanged.
3. Log out, whether or not step 2 worked. A failed logout after a
   successful apply is printed as a `WARNING`; the run still succeeds.

No request follows a redirect. A `3xx` answer is reported as a failure
(`HTTP 302 (redirect not followed)`), never silently re-sent elsewhere.

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
  rejected and the sample reports that rather than guessing. A `3xx` or
  `4xx` means the settings were not applied; a `5xx` may have failed
  halfway, so the sample says the server may have applied some of them and
  asks you to download the device's settings to check.
- **The file is checked before anything is sent.** `apply` refuses, without
  logging in, a path that is missing or a directory, a file that is not
  valid JSON, and JSON that is not an object (a list, a number, `null`).
- **`_error` is a report, not a setting.** The downloaded file carries the
  source device's `_error` map; it is dropped from the `PUT` body so the
  target is never handed someone else's errors. On the way back, a `2xx`
  whose body has a non-empty `_error` map means the server took the
  settings but the Engine rejected some values. The sample prints
  `The server took the settings but the Engine reported errors:` with one
  `name: message` line each, and exits 1. An empty body, or one without
  errors, is a success.
- **A lost answer is not a failure, or a success.** If the connection could
  not be made at all (refused, unknown host, certificate, connect timeout),
  the settings were not applied and the sample says so. If it drops or times
  out after the `PUT` went out, nobody knows whether they were applied, and
  the sample says exactly that: `Outcome unknown: the connection was lost
  after the settings were sent. Download the device's settings to check.`
- **A download never clobbers.** The settings are written to a side file,
  `<out>.<random>.partial` (owner-only), and moved into place only when
  complete. Without `--force`, a destination that already exists, or that
  appears while the download runs, is kept and the run fails with
  `<out> already exists; use --force`; that holds for the auto-generated
  name too. On a file system without hard links (FAT/exFAT, some network
  shares) the sample checks for the destination and then renames, which
  leaves a small window in which a file created at that very moment is
  replaced. With `--force` the old file is replaced in one step. The side
  file never stays behind, not even on Ctrl-C.

## Prerequisites

- **Node 18+** for the built-in `fetch`. No dependencies to install.
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

Nothing to install. The sample and its tests use only Node built-ins.

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
node rest_copy_device_agent_settings.mjs download \
    --device-id {cameraA-id} --engine-id {engine-id} \
    --dotenv ../../.env --insecure

# Download to a path you choose:
node rest_copy_device_agent_settings.mjs download \
    --device-id {cameraA-id} --engine-id {engine-id} --out settings.json \
    --dotenv ../../.env --insecure

# Apply a downloaded file to another device. This replaces that device's
# existing Device Agent settings, so it will not run without --yes:
node rest_copy_device_agent_settings.mjs apply settings.json \
    --device-id {cameraB-id} --engine-id {engine-id} \
    --dotenv ../../.env --insecure --yes

# Apply to several devices: run it again per device.
for device in {cameraB-id} {cameraC-id}; do
  node rest_copy_device_agent_settings.mjs apply settings.json \
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

A flag that takes a value must be given one (`--out` alone is an error),
and a flag that does not take one refuses it: `--yes=no` is an error, not a
yes.

Exit codes:

| Code | Meaning |
|------|---------|
| 0 | Success. |
| 1 | A call failed, a guard refused, the Engine reported errors, or the outcome is unknown. |
| 2 | Configuration is missing, or the command line was wrong. |
| 130 | Interrupted with Ctrl-C before the run printed its result. The session is logged out first (given 3 s at most), and no side file is left behind. Once the result (`Downloaded ...` / `Applied ...`, or the Engine-errors block) is printed, Ctrl-C during the final logout prints `WARNING: could not log out: interrupted.` and the run keeps its own exit code (0, or 1 after Engine errors). |

## Run the tests

```bash
node --test test_rest_copy_device_agent_settings.mjs

# Or via the package script:
npm test
```

Note that plain `node --test` finds nothing here; name the test file, or use
`npm test`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login unauthorized (HTTP 401/403). Check the password, and note that a cloud account cannot log in here. It needs the OAuth2 flow.` | Wrong password, or a cloud account. | Use a local server account. Cloud users need the OAuth2 flow. |
| `Reading settings was refused (HTTP 401/403). This endpoint needs Power User or better.` or `Applying settings was refused (HTTP 401/403). This endpoint needs Power User or better.` | The account is below Power User. | Use an account with Power User or better. |
| `Login failed: HTTP <n>.`, `... not valid JSON.`, `... did not contain a token.` | `--host` points at something that is not an Nx server's REST API, or a proxy in between. | Check `--host`: scheme, address and port of the server. |
| `Applying settings failed: HTTP 4xx. The settings were not applied. The target device may not be running this Engine.` | The target device is not running that Engine, or the settings don't match what its plugin expects. | Confirm the target has the same analytics plugin enabled, and that `--engine-id` is right for that device. |
| `Applying settings failed: HTTP 5xx. The server may have applied some of them; download the device's settings to check.` | The server failed while handling the `PUT`. | Run `download` against the target device and compare, then apply again. |
| `HTTP 3xx (redirect not followed).` | `--host` is behind a redirect (often `http` to `https`, or another port). | Use the address the server really answers on. |
| `The server took the settings but the Engine reported errors:` | The Engine rejected the listed values, for example out of range on this device. | Fix those values in the file, or set them in the client, then apply again. |
| `Outcome unknown: the connection was lost after the settings were sent. Download the device's settings to check.` | The connection dropped or timed out after the `PUT` went out. | Run `download` against the target device and compare. |
| `could not reach the server: <reason>.` (for example `no answer within 30 s.` or `no connection within 10 s.`; on `apply` it adds `The settings were not applied.`) | Wrong host or port, server down, or a firewall. | Check `--host`; nothing was changed. |
| `Reading settings failed: HTTP <n>.` or `... the server did not return a JSON object.` | The server answered something that is not a settings object. | Check `--host` and the ids. |
| `<file> already exists; use --force` | `--out` (or the auto-generated name) already exists, or appeared during the download. | Choose another `--out`, or pass `--force`. |
| `could not use <out>: <reason>.` (for example `No such file or directory.` or `Permission denied.`) | The download could not be saved at `--out` (or the auto-generated name): its folder is missing, not writable, or the disk is full. | Create the folder, or choose another `--out`. |
| `<file> is a directory. Give --out a file path.` / `<file> is a directory, not a settings file.` | `--out`, or the file given to `apply`, is a directory. | Give a file path. |
| `<file> is not valid JSON: <reason>.` / `<file> does not hold a JSON object.` | The file given to `apply` is not a downloaded settings file. | Run `download` and apply what it wrote. |
| `Refusing to apply without --yes. This overwrites the target device's existing Device Agent settings.` | The guard did its job. | Re-run with `--yes` once you are sure of the target device. |
| `ERROR: --yes takes no value` / `ERROR: Missing value for --out` (exit 2) | A boolean flag was given `=value`, or a value flag none. | Write `--yes`, and give value flags a value. |
| `No such settings file: <file>` | The path given to `apply` does not exist. | Check the path, or run `download` first. |
| `certificate verification failed. Local servers use a self-signed certificate, add --insecure.` | The lab server's self-signed certificate (on any request; on `apply` it adds `The settings were not applied.`). | Add `--insecure`. |
| `WARNING: could not log out: <reason>.` (for example `Logout failed: HTTP <n>.`, `no answer within 30 s.`, or `interrupted.` after Ctrl-C) | The session could not be ended after the run printed its result (`Downloaded ...` / `Applied ...`, or the Engine-errors block); the run keeps its exit code. When the run failed for another reason, a failed logout is not reported; only the real error is shown. | Nothing to do; the session expires on its own. |

## Files

| File | Purpose |
|------|---------|
| `rest_copy_device_agent_settings.mjs` | The sample (`NxServerClient` with `downloadSettings`/`applySettings`, plus the CLI). |
| `test_rest_copy_device_agent_settings.mjs` | Offline tests (injected `fetch`). |
| `package.json` | Name, `type: module`, and the `start` and `test` scripts. No dependencies. |
