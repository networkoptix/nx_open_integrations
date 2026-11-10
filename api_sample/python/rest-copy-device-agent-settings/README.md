# REST API, copy Device Agent settings to another device (Python)

Downloads the settings an analytics Engine (a plugin, e.g. a motion or object
detector) keeps for one device's Device Agent, then applies them to another
device. Handy for rolling out the same analytics configuration across several
cameras that run the same plugin, without re-entering it by hand in the
client for each one.

```
$ python rest_copy_device_agent_settings.py download \
      --device-id {cameraA-id} --engine-id {engine-id} \
      --env-file ../../.env --insecure
Logged in to https://192.168.1.10:7001 as admin

Downloaded Device Agent settings for device {cameraA-id} (engine {engine-id}) -> nx-device-agent-settings-{cameraA-id}-20260916T031200Z.json

$ python rest_copy_device_agent_settings.py apply \
      nx-device-agent-settings-{cameraA-id}-20260916T031200Z.json \
      --device-id {cameraB-id} --engine-id {engine-id} \
      --env-file ../../.env --insecure --yes
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
   is written to a JSON file, unchanged.
3. Log out: `DELETE /rest/v4/login/sessions/<token>`.

**apply**

1. Log in, as above.
2. Set: `PUT /rest/v4/analytics/engines/{engineId}/deviceAgents/{deviceId}/settings`
   with a body built from the downloaded file, dropping `deviceId`, `engineId`
   and `_error`. Everything else, `values`, `model`, `analyzedStream`,
   `disableStreamSelection`, is forwarded unchanged. The file is checked before
   logging in: it must be valid JSON, and a JSON object.
3. Log out.

Both subcommands log out on the way out, whether the call succeeded or not. A
logout that fails after a successful call is only a warning.

### Three things worth knowing

- **The URL carries the identity, not the body.** `engineId` and `deviceId`
  appear only in the path for both calls, and are not even in the spec's PUT
  request body schema. The response echoes them back for your own reference,
  which is why they are marked read-only and are dropped before the settings
  are re-sent to a different device.
- **One device per run.** `apply` writes to exactly one target. To roll the
  same settings out to several devices, call it again with a different
  `--device-id` (and `--engine-id`, if that device runs a different Engine
  instance): a small shell loop, not a flag on the sample.
- **The settings are opaque.** `values` is whatever name/value pairs that
  Engine's plugin defines; this sample does not know or validate their shape.
  If the target device is not running the Engine you named, the `PUT` is
  rejected and the sample reports that rather than guessing.

### How the outcome is reported

- **`_error` is the Engine's verdict.** The downloaded file's `_error` is the
  source Engine's report on its own settings, so it is not sent back. The
  answer to the `PUT` can carry the target Engine's `_error`: when that map is
  not empty, the sample prints `The server took the settings but the Engine
  reported errors:` and one `name: message` line per entry (a message that is
  not a string is shown as JSON), and exits 1. An
  empty answer, or one without errors, counts as applied.
- **A lost connection is not "not applied".** If the connection could not be
  made at all, nothing was sent, and the sample says the settings were not
  applied. If it drops (or times out) after the `PUT` went out, the sample
  cannot know whether the device took them, and says so: `Outcome unknown: the
  connection was lost after the settings were sent. Download the device's
  settings to check.`
- **Redirects are not followed.** Every request is made to the `--host` you
  gave; a 3xx answer is a failure (`HTTP 302 (redirect not followed)`).
- **A download never overwrites by accident.** The settings go to a private
  side file beside `--out` (`<out>.<random>.partial`) and are moved into place
  only when complete. Without `--force`, a file that appears at the
  destination during the download, auto-named or not, is left alone and the
  sample stops with `<out> already exists; use --force`. (On a file system
  without hard links, such as FAT or some network shares, the sample checks
  and then renames. On Windows the rename still refuses a file that appeared
  in that brief gap; elsewhere such a file is not protected.)
  The side file is removed on every failure, and on Ctrl-C.

## Prerequisites

- Python 3.8+
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

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Uses the shared server variables, plus two more. Copy the template at the repo
root:

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

Because `NX_DEVICE_ID` and `NX_ANALYTICS_ENGINE_ID` mean "the device/engine for
*this* run", pass `--device-id` and `--engine-id` explicitly on the command
line for `apply` rather than relying on the `.env` default, so a stale
environment variable can't send settings to the wrong device.

## Run

```bash
# Download settings from a device, to an auto-named file:
python rest_copy_device_agent_settings.py download \
    --device-id {cameraA-id} --engine-id {engine-id} \
    --env-file ../../.env --insecure

# Download to a path you choose:
python rest_copy_device_agent_settings.py download \
    --device-id {cameraA-id} --engine-id {engine-id} --out settings.json \
    --env-file ../../.env --insecure

# Apply a downloaded file to another device. This replaces that device's
# existing Device Agent settings, so it will not run without --yes:
python rest_copy_device_agent_settings.py apply settings.json \
    --device-id {cameraB-id} --engine-id {engine-id} \
    --env-file ../../.env --insecure --yes

# Apply to several devices: run it again per device.
for device in {cameraB-id} {cameraC-id}; do
  python rest_copy_device_agent_settings.py apply settings.json \
      --device-id "$device" --engine-id {engine-id} \
      --env-file ../../.env --insecure --yes
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
| `--env-file` | both | Path to the shared `.env` (default `./.env`). |
| `--insecure` | both | Skip TLS verification (lab use only). |

Exit codes: 0 on success (a logout failure after success is only a warning),
1 when the call failed, the Engine reported errors, the outcome is unknown, or a
guard refused, 2 when configuration is missing or a flag is wrong (a value flag
with no value or an empty one such as `--out=`, or a value given to `--yes`,
`--force` or `--insecure`), 130 on Ctrl-C (the side file is removed and the
session logged out first). Once the `Downloaded ...` or `Applied ...` line is
printed the work is done: a Ctrl-C
during the final logout prints `WARNING: could not log out: interrupted.` and
the run still exits 0. Engine errors are a finished result too: they are
printed first, and a failed or interrupted logout that follows prints the same
`WARNING: could not log out: <reason>.` and the run still exits 1. After any
other failure the logout on the way out is silent: only the real error is shown.

## Run the tests

```bash
pytest -v
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `Login unauthorized (HTTP <n>). Check the password, and note that a cloud account cannot log in here. It needs the OAuth2 flow.` | Wrong password, or a cloud account. | Use a local server account. Cloud users need the OAuth2 flow. |
| `Login failed: HTTP <n>.`, `Login failed: the response was not valid JSON.` or `Login failed: the response did not contain a token.` | The server answered, but not with a login. Often a proxy, or the wrong port. | Check `--host` points at the VMS server itself. |
| `Reading settings was refused (HTTP <n>). This endpoint needs Power User or better.` or `Applying settings was refused (HTTP <n>). This endpoint needs Power User or better.` | The account is below Power User. | Use an account with Power User or better. |
| `Reading settings failed: HTTP <n>.` | The server could not hand out the settings, e.g. a wrong `--device-id` or `--engine-id`. | Check `--device-id` and `--engine-id`. |
| `Applying settings failed: HTTP <4xx>. The settings were not applied. The target device may not be running this Engine.` | The target device is not running that Engine, or the settings don't match what its plugin expects. | Confirm the target has the same analytics plugin enabled, and that `--engine-id` is right for that device. |
| `Applying settings failed: HTTP <5xx>. The server may have applied some of them; download the device's settings to check.` | The server failed while handling the `PUT`; part of the settings may have landed. | Run `download` against the target device to see what it holds now. |
| `... HTTP <3xx> (redirect not followed).` | `--host` answers with a redirect, e.g. http to https. | Use the address the redirect points at as `--host`. |
| `The server took the settings but the Engine reported errors:` | The device took the settings, but its Engine rejected some values. | Read the listed `name: message` lines, fix those values in the file, and apply again. |
| `Outcome unknown: the connection was lost after the settings were sent. Download the device's settings to check.` | The connection dropped or timed out after the `PUT` went out. | Run `download` against the target device to see what it holds now. |
| `could not reach the server: <reason>.` (`apply` adds ` The settings were not applied.`) | Wrong `--host`, server down, or a firewall. Nothing was sent. | Check the address and port, then retry. |
| `could not reach the server: no answer within 30 s.` or `could not reach the server: no connection within 30 s.` | The server did not connect, or did not answer the login or the download, within 30 s. | Check the address and that the server is up, then retry. |
| `Reading settings failed: the server did not return a JSON object.` | The download answer was not settings. | Check `--host`, `--device-id` and `--engine-id`. |
| `<file> already exists; use --force` | `--out` already exists (a symlink counts, even one pointing nowhere), or appeared during the download. | Choose another `--out`, or pass `--force`. |
| `could not use <out>: <reason>.` (e.g. `No such file or directory.` or `Permission denied.`) | Saving the download failed locally: `--out` is in a missing folder, not writable, or the disk is full. `<out>` is the path given (or the generated name). No side file is left behind. | Check the folder exists and is writable, or choose another `--out`. |
| `<path> is a directory. Give --out a file path.` or `<path> is a directory, not a settings file.` | `--out` or the `apply` file is a folder. | Give a file path. |
| `<file> is not valid JSON: <reason>.` or `<file> does not hold a JSON object.` | The `apply` file is not a settings file from `download`. | Use a file written by `download`. |
| `Refusing to apply without --yes. This overwrites the target device's existing Device Agent settings.` | The guard did its job. | Re-run with `--yes` once you are sure of the target device. |
| `No such settings file: <file>` | The path given to `apply` does not exist. | Check the path, or run `download` first. |
| `certificate verification failed. Local servers use a self-signed certificate, add --insecure.` (`apply` adds ` The settings were not applied.`) | The lab server's self-signed certificate. | Add `--insecure`. |
| `missing configuration: <names>. Set it with a flag, an NX_* environment variable, or in <env file>.` (exit 2) | A setting is in none of the flags, the environment or the `.env` file. | Supply it in any of those places. |
| `Missing value for --<flag>` (exit 2) | A value flag was given an empty value, e.g. `--out=`. | Give the flag a value, or leave it out. |
| `WARNING: could not log out: <reason>.` (e.g. `Logout failed: HTTP 500.` or `no answer within 30 s.`) or `WARNING: could not log out: interrupted.` | The run has its result (the `Downloaded ...`/`Applied ...` line, or the Engine's errors), but the last logout failed or Ctrl-C came during it. The exit code stays 0 after success, 1 after Engine errors. | Nothing to redo; the session expires on its own. |

## Files

| File | Purpose |
|------|---------|
| `rest_copy_device_agent_settings.py` | The sample (`NxServerClient` with `download_settings`/`apply_settings`, plus the CLI). |
| `test_rest_copy_device_agent_settings.py` | Offline tests (mocked HTTP). |
| `requirements.txt` | `requests` + `urllib3` 2 + `pytest`. |
