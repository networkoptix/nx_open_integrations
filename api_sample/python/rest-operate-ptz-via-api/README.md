# REST Server API — Operate PTZ (Python)

Drives a **PTZ (Pan-Tilt-Zoom) camera** on one VMS server/site, local or
cloud-relayed. Reports the camera's PTZ capabilities, then issues the
requested command.

```
Camera: <Camera Name>   
PTZ capabilities: AbsolutePanCapability, ContinuousPanCapability

Executing PTZ command: move...
Done.
```

## What the code does (Nx v4 bearer-token auth)

1. **Log in** —
   - Local: `POST /rest/v4/login/sessions` with `{username, password}` → `{"token": ...}`.
   - Cloud: `POST {cloud}/cdb/oauth2/token` with `scope=cloudSystemId=<site id>` →
     `{"access_token": ...}`, then talk to the relay `https://<site id>.relay.vmsproxy.com`.
2. **Read camera info** — `GET /rest/v4/devices/{id}`, used to report PTZ capabilities.
3. **Issue the PTZ command** — one of `move`, `stop`, `abs_move`, `get_presets`,
   `set_preset`, `go_preset`, `get_tours`, `activate_tour`, `stop_tour`.
4. **Log out** — `DELETE /rest/v4/login/sessions/<token>` (local sessions only;
   done automatically, even if an error occurs).

> **Cloud relay redirects:** the relay answers with an HTTP 307 pointing at the
> node that actually serves the request. `requests` strips the `Authorization`
> header on that kind of cross-host redirect, so every call follows redirects
> manually and re-attaches the bearer header (and repeats the body) on each hop.

## Prerequisites

- Python 3.8+
- Network access to an Nx VMS server (or cloud account) and a PTZ-capable camera.
- The tests need neither a server nor a network.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

No other dependencies are required — the sample is a single self-contained script.

## Configure

Uses the shared `.env` template at the repo root:

```bash
cp ../../.env.example ../../.env   # then edit the values below
```

- `NX_SERVER_HOST` — local server, e.g. `https://192.168.1.10:7001`.
- `NX_SERVER_USER`, `NX_SERVER_PASSWORD` — a local server account.
- `NX_CLOUD_HOST`, `NX_CLOUD_SITE_ID` — use instead of `NX_SERVER_HOST` to go
  through the Cloud relay with a cloud account (reuse `NX_SERVER_USER`/`NX_SERVER_PASSWORD`
  for the cloud credentials, or pass `--user`/`--password` on the command line).
- `NX_DEVICE_ID` — the camera/device id to control.

## Run

```bash
# Local server (self-signed certs are typical, hence --insecure):
python rest_operate_ptz_via_api.py --env-file ../../.env --insecure \
  --ptz move --pan 0.5 --tilt 0.3 --zoom 0.1 --speed 0.5

# Or fully on the command line:
python rest_operate_ptz_via_api.py \
  --host https://192.168.1.10:7001 --user admin --password 'your-password' \
  --device-id {camera_id} --insecure \
  --ptz move --pan 0.5 --tilt 0.3 --zoom 0.1 --speed 0.5

# Cloud-relayed:
python rest_operate_ptz_via_api.py \
  --cloud-host https://nxvms.com --site-id {cloud_system_id} \
  --user {cloud_user_email} --password {cloud_user_password} \
  --device-id {camera_id} \
  --ptz go_preset --preset-id {preset_id}
```

### `--ptz` operations

- `move` — Continuous pan/tilt/zoom (`--pan --tilt --zoom --speed`)
- `stop` — Stop continuous move
- `abs_move` — Absolute positioning (`--pan --tilt --zoom --speed`)
- `get_presets` — List presets
- `set_preset` — Create a preset (`--preset-name` optional)
- `go_preset` — Move to a preset (`--preset-id`, `--speed`)
- `get_tours` — List tours
- `activate_tour` — Start a tour (`--tour-id`)
- `stop_tour` — Stop a tour (implemented by interrupting movement)

## Run the tests

```bash
pytest -v
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|--------|--------------|-----|
| `SSLError` / certificate verify failed | Local server uses a self-signed cert. | Add `--insecure` (expected for local servers). |
| `Could not reach https://...` | Wrong IP/port, server down, or firewall. | Confirm host + port `7001`, and that the server is reachable. |
| `Login unauthorized (HTTP 401/403)` | Wrong password, or wrong login path for this account type. | Local accounts use `--host`; cloud accounts use `--cloud-host`/`--site-id`. |
| `--preset-id is required for go_preset` | No preset id given. | Run `get_presets` first to find the id. |
| Camera reports `none` for PTZ capabilities | Camera has no PTZ support, or the driver hasn't reported it yet. | Confirm the camera supports PTZ in the Nx client before troubleshooting further. |

## Files

| File | Purpose |
|------|---------|
| `rest_operate_ptz_via_api.py` | The sample. Run it directly. |
| `test_rest_operate_ptz_via_api.py` | Offline tests (mocked HTTP). |
| `requirements.txt` | `requests` + `pytest`. |
