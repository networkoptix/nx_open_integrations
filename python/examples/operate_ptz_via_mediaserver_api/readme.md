Copyright © 2018–present Network Optix, Inc.  
Licensed under [MPL 2.0](https://www.mozilla.org/MPL/2.0/)

# PTZ Camera Control via API

---

## 1. Abstract

This script demonstrates controlling PTZ (Pan–Tilt–Zoom) cameras through the Nx Media Server API.
It includes a reusable camera wrapper and a CLI that support local server access and Cloud Relay
access, plus common PTZ actions such as continuous move, absolute move, presets, and tours.

---

## 2. Folder Structure

- **`cameras.py`** — Camera abstraction layer wrapping REST endpoints for:
- **`execute_ptz_operations.py`** — CLI for executing PTZ operations against a PTZ camera.
- **`readme.md`** - This readme file.

> Note: The default `API_VERSION` in the script is **"v3"**.
Set it to **"v4"** if your system is Nx Witness or Nx Meta 6.1+ or you want `/rest/v4` endpoints.

---

## 3. Requirements

- Python **3.10+**
- Python package: `requests`
- Nx Witness or Nx Meta:
    - v6.0.X for `/rest/v3`
    - v6.1.0+ for `/rest/v4`

---

## 4. Quick Start

### 4.1 Install dependencies

```bash
pip install requests
```

### 4.2 Local server example

```bash
python execute_ptz_operations.py \ 
--url {mediaserver_ip} \
--port 7001   
--username {local_username} \   
--password {local_password} \   
--camera {camera_id} \
--ptz move   --pan 0.5 --tilt 0.3 --zoom 0.1 --speed 0.5
```

### 4.3 Cloud Relay example

```bash
python execute_ptz_operations.py \
--cloud_system_id {cloud_system_id} \
--username {cloud_user_email} \  
--password {cloud_user_password} \   
--camera {camera_id} \  
--ptz go_preset --id {preset_id}
```

### 4.4 Available parameters (operations) `--ptz` commands

- `move` — Continuous pan/tilt/zoom
- `stop` — Stop continuous move
- `abs_move` — Absolute positioning
- `get_presets` — List presets
- `set_preset` — Create a preset (use `--preset_name` optionally)
- `go_preset` — Move to preset (use `--id {preset_id}`)
- `get_tours` — List tours
- `activate_tour` — Start a tour (use `--id {tour_id}`)
- `stop_tour` — Stop a tour (implemented by interrupting movement)

---

## 5. Authentication

The CLI supports two flows:

- **Local session** — `POST /rest/v{3-4}/login/sessions` with local credentials.

    This flow will use the returned bearer/session token in subsequent calls.

- **Cloud OAuth** — `POST https://{cloud_portal}/cdb/oauth2/token` with Cloud credentials and
the`cloud_system_id`.

    This flow will use the returned token when calling the **Cloud Relay** URL `https://{cloud_system_id}.relay.vmsproxy.com`.

> For conceptual details on Nx auth, please find [Nx Authentication through the REST API](https://support.networkoptix.com/hc/en-us/articles/32895719318935-Authentication-through-the-REST-API).

---

## 6. API Endpoints Used (REST v3/v4)

### 6.1 Authentication

- `POST /rest/{v3-4}/login/sessions` — Create a session (local)
- `POST /cdb/oauth2/token` (Cloud) — Obtain access token for Cloud Relay

### 6.2 Camera info

- `GET /rest/{3-4}/devices/{camera_id}` — Retrieve camera metadata used by this tool

### 6.3 PTZ control

- **Continuous move**
    - Start: `POST /rest/{3-4}/devices/{camera_id}/ptz/move`  
    - Stop: `DELETE /rest/{v3-4}/devices/{camera_id}/ptz/move`  
- **Absolute move**
    - `POST /rest/{v3-4}/devices/{camera_id}/ptz/position`  

### 6.4 Presets

- List: `GET /rest/{v3-4}/devices/{camera_id}/ptz/presets`
- Create: `POST /rest/{v3-4}/devices/{camera_id}/ptz/presets`  
- Activate: `POST /rest/{v3-4}/devices/{camera_id}/ptz/presets/{preset_id}/activate`  

### 6.5 Tours

- List: `GET /rest/{v3-4}/devices/{camera_id}/ptz/tours`
- Activate: `POST /rest/{v3-4}/devices/{camera_id}/ptz/tours/{tour_id}/active`

---

## 7. PTZ Capabilities & Compatibility

- **REST v3**: The camera exposes a **bitmask** (`parameters.ptzCapabilities`).

    The code maps that integer to named capabilities (e.g., `ContinuousPanCapability`,
    `AbsoluteTiltCapability`, etc.).

- **REST v4**: The camera exposes a pipe-separated **capability string** under `ptz.capabilities`

    (e.g., `"ContinuousPanCapability|AbsoluteTiltCapability|..."`).

The support article lists the detail of PTZ capability names and shows examples value against
the parameters. Please use that table for meaning/context even if you’re calling REST v3/v4
endpoints from this script.

---

## 8. Examples

### 8.1 Continuous move then stop

```bash
# start
python execute_ptz_operations.py ... --ptz move --pan 1.0 --tilt 0.0 --zoom 0.0 --speed 0.8
# stop
python execute_ptz_operations.py ... --ptz stop
```

### 8.2 Absolute move

```bash
python execute_ptz_operations.py ... --ptz abs_move --pan 0.5 --tilt 0.5 --zoom 0.1 --speed 0.5
```

### 8.3 Presets

```bash
# list
python execute_ptz_operations.py ... --ptz get_presets

# create (name optional; will default to Preset_{pan}_{tilt}_{zoom})
python execute_ptz_operations.py ... --ptz set_preset --preset_name "my_preset"

# go (requires preset ID)
python execute_ptz_operations.py ... --ptz go_preset --id {uuid/preset} --speed 0.5
```

### 8.4 Tours

```bash
# list tours
python execute_ptz_operations.py ... --ptz get_tours

# activate tour
python execute_ptz_operations.py ... --ptz activate_tour --id {TourA/uuid}

# stop tour (implemented by interrupting movement)
python execute_ptz_operations.py ... --ptz stop_tour
```

---

## 9. Notes & Troubleshooting

- **HTTPS**: All requests are over HTTPS. If using self-signed certs in a lab/dev environment,
the sample code passes `verify=False`.

- **Cloud vs Local**: When `--cloud_system_id` is provided, the tool builds the relay URL
`https://{cloud_system_id}.relay.vmsproxy.com` and authenticates via Cloud OAuth; otherwise it
targets `https://{url}:{port}` and authenticates locally.

- **Capabilities**: The sample does not block unsupported actions. If an operation fails, verify
the camera’s PTZ capabilities first (see [section 7](#7-ptz-capabilities--compatibility) and the
support article’s capability list).

---

## 10. Authors

[Network Optix](https://www.networkoptix.com)
