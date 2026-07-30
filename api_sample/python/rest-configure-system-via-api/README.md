_Copyright 2018-present Network Optix, Inc. Licensed under [MPL 2.0](https://www.mozilla.org/MPL/2.0/)_

# Configure System Via APIs (Python)

First-time setup for **one VMS server/site**: set its name and local admin
password, optionally connect it to the **Cloud** (personal account or an
organization), and apply the usual default toggles (auto-discovery, camera
settings optimization, anonymous statistics).

```
====================
* Start Time                : 2026-07-31 10:00:00
* System Name                : MySystem
* Connect to Cloud           : CONNECTED
* Auto Discovery             : ENABLED
* Anonymous Statistics Report: ENABLED
* Camera Optimization        : ENABLED
* Finish Time               : 2026-07-31 10:00:04
```

## What the code does (Nx v4 REST API)

1. **Init** — `POST /rest/v4/site/setup` with `{name, local: {password}}`.
   Rejected if the site was already set up — that's expected, not fatal.
2. **Log in** — `POST /rest/v4/login/sessions` with `{username, password}` →
   `{"token": ...}`.
3. **Read settings** — `GET /rest/v4/site/settings`, to see what's already
   configured before changing anything.
4. **Cloud**, only if the desired state differs from the current one:
   - Connect, personal account: `POST {cloud}/cdb/systems/bind` →
     `POST /rest/v4/cloud/bind`.
   - Connect, under an organization: `POST {cloud}/partners/api/v4/cloud_systems/`
     → `POST /rest/v4/cloud/bind`.
   - Disconnect: `POST /rest/v4/cloud/unbind`.
5. **Apply settings** — `PATCH /rest/v4/site/settings` with
   `{siteName, autoDiscoveryEnabled, cameraSettingsOptimization, statisticsAllowed}`.
6. **Merge**, only if this server has a `[hive]` section — see
   [Merging several servers into one site](#merging-several-servers-into-one-site).
7. **Log out** — `DELETE /rest/v4/login/sessions/current` (cleanup).

The full list of configurable site settings can be discovered via:

* `GET /rest/v4/site/settings`
* `GET /rest/v4/site/settings/*/manifest`

> **v4 renamed the objects as well as the paths.** In v4 payloads a *System* is a
> *Site*: `siteName` (not `systemName`), `cloudId` (not `cloudSystemID`), and
> `siteId` (not `systemId`) in the cloud bind body. This matters more than it
> looks — a `PATCH /rest/v4/site/settings` carrying the old `systemName` still
> returns `200`, it simply does not change the name. Reads behave the same way:
> the old keys are absent from v4 responses rather than rejected.

## Prerequisites

- Python 3.8+
- Network access to an Nx VMS server, ideally in its **factory-default**
  state (already-configured servers can still be re-run; steps that are
  already satisfied are simply skipped).
- A Cloud account (email/password), only if you want the system bound to the
  Cloud.
- The tests need neither a server nor a network.

## Install

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Copy [`system_setting.conf`](system_setting.conf) (or edit it in place) and
fill in your values:

| Section | Key | Description |
|---|---|---|
| `[server]` | `ip_address` | Address of the target server. |
| `[server]` | `port` | Port of the target server. |
| `[server]` | `system_name` | Desired system name. |
| `[server]` | `local_admin_password` | Local admin password to set (if not already set) and log in with. |
| `[cloud]` | `cloud_account`, `cloud_password` | Cloud account used to bind the system. |
| `[cloud]` | `connect_to_organization` | `True` to bind under an organization instead of the personal account. |
| `[system_settings]` | `product` | Must match an entry in [`cloud_hosts.json`](cloud_hosts.json) (e.g. `Nx Witness`, `Nx EVOS`) — this determines the cloud host and customization used. |
| `[system_settings]` | `organization_id` | Required if `connect_to_organization = True`. |
| `[system_settings]` | `connect_to_cloud` | `True`/`False`. |
| `[system_settings]` | `enable_auto_discovery` | `True`/`False`. |
| `[system_settings]` | `allow_anonymous_statistics_report` | `True`/`False`. |
| `[system_settings]` | `enable_camera_optimization` | `True`/`False`. |
| `[hive]` | `merge` | *Optional.* Comma-separated `host:port` list of other servers to absorb into this one's site. Omit the section entirely for a normal single-server run. |

`cloud_hosts.json` maps each powered-by-Nx product to its cloud host and
customization flag. Add an entry there if your product isn't listed.

## Run

```bash
# Uses system_setting.conf by default:
python3 configure_system.py

# Load a different config file:
python3 configure_system.py --file my_system.conf

# Save the summary to a file as well as printing it:
python3 configure_system.py --output

# Suppress terminal output (e.g. for cron/CI):
python3 configure_system.py --silent
```

```
usage: configure_system.py [-h] [-f FILE] [-o] [-s]

  -f, --file     Specify the file to read system settings from (default: system_setting.conf)
  -o, --output   Save the summary result to a file
  -s, --silent   Silent mode; the result will not be displayed on terminal
```

## Run the tests

Offline, no server or network needed — HTTP is mocked with fake `requests`
sessions:

```bash
pytest -v
```

Test files mirror the source files 1:1:

| Test file | Covers |
|---|---|
| `test_vms_system.py` | `VmsSystem`: config loading, local/cloud login, settings read/update, cloud bind/unbind (personal account and organization), the auto-discovery/camera-optimization/statistics toggles, site merging (`[hive]` parsing, `merge_sites()`, `get_merge_status()`), and full `setup_system()` runs. |
| `test_configure_system.py` | `get_args()` and `main()` (with `VmsSystem` swapped for a fake, so it never touches the network). |
| `test_format_output.py` | The summary string formatting and result-file writing helpers. |

## Output

- **`configure_system.log`** — every run appends execution details here
  (requests made, success/failure, errors). Useful for troubleshooting a
  failed run.
- **`{system_name}_{timestamp}_configure_result.log`** — a one-run summary,
  written only when `--output` is passed.
- By default the same summary also prints to the terminal, unless `--silent`
  is passed.

## Multiple systems

This script configures one system per run. To configure a fleet, write a
small wrapper that loops over several config files, e.g.:

```bash
for conf in configs/*.conf; do
  python3 configure_system.py --file "$conf" --output --silent
done
```

## Merging several servers into one site

The loop above leaves you with N independent sites. To end up with **one** site
spanning several servers, give exactly one of them — the *seed* — a `[hive]`
section listing the others:

```ini
[hive]
merge = 10.0.0.3:7001, 10.0.0.4:7001
```

Every server still gets its own config file and its own run. The followers
(`10.0.0.3`, `10.0.0.4`) have no `[hive]` section, so they configure themselves
and stop. The seed configures itself and then absorbs each follower in turn via
`POST /rest/v4/site/merge`, polling `GET /rest/v4/site/merge` for
`mergeInProgress` before moving on to the next one.

All the servers need the same `local_admin_password`: the seed authenticates to
each follower with it to mint the `remoteSessionToken` that the merge requires.

Order does not matter, so the runs can start in parallel. Before merging a
follower the seed waits for it to accept that shared password, which only
happens once the follower has finished its own setup — so a seed launched first
simply waits.

Notes:

- **Merge from one server, sequentially.** Concurrent merges into the same site
  corrupt it. That is why the seed absorbs followers one at a time, and why only
  one server should carry a `[hive]` section.
- **Best-effort.** A follower that never becomes reachable (~5 min) or whose
  merge fails is logged and skipped; the remaining followers still merge. Check
  `configure_system.log` afterwards to confirm the site is the size you expect.
- The summary a seed prints describes **its own** configuration. Merge outcomes
  go to `configure_system.log`.

## Extending

More settings can be configured by adding fields to the `VmsSystemSettings`
dataclass in `vms_system.py`, wiring up a getter/setter following the pattern
used for auto-discovery/camera optimization/statistics, and adding the
matching key to `system_setting.conf`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `[ERROR] VmsSystem object initialization was not successful` | Missing/misnamed key in `system_setting.conf`, or `cloud_hosts.json` not found. | Check the config against the table above; confirm both files are in the working directory. |
| `[ERROR] Can't get the current system settings for ...` | Login failed, or the server is unreachable. | Confirm `ip_address`/`port`, and that `local_admin_password` is correct for an already-initialized system. |
| Cloud connection stays `UNKNOWN` | Settings couldn't be read from the server at all. | Check `configure_system.log` for the underlying request error. |
| `organizationId is empty` warning, cloud bind fails | `connect_to_organization = True` but `organization_id` wasn't set. | Set `organization_id` in `[system_settings]`, or set `connect_to_organization = False`. |
| Product/cloud host not found | `product` in `system_setting.conf` doesn't match any entry in `cloud_hosts.json`. | Use one of the listed products (`Nx Witness`, `Nx EVOS`), or add your own entry. |
| `follower ... never became reachable; skipping` | The follower never accepted the shared admin password within ~5 min: it isn't up, isn't reachable from the seed, or was configured with a different `local_admin_password`. | Confirm the endpoint in `[hive] merge`, and that every server in the hive uses the same `local_admin_password`. |
| Site ends up smaller than expected | One or more merges were skipped — merging is best-effort by design. | Search `configure_system.log` for `merge`; re-running the seed merges whatever is still separate. |
| Name change reported as successful but the name is unchanged | A v3-era `systemName` reaching a v4 server: the `PATCH` returns `200` and does nothing. | Use `siteName`. See the note in [What the code does](#what-the-code-does-nx-v4-rest-api). |

## Files

| File | Purpose |
|---|---|
| `configure_system.py` | Entry point. Parses CLI args and drives the setup. Run this directly. |
| `vms_system.py` | `VmsSystem` class: all REST/CDB calls and setup logic. |
| `format_output.py` | Formats the summary for the terminal and the result log file. |
| `test_vms_system.py` | Offline tests for `vms_system.py` (mocked HTTP). |
| `test_configure_system.py` | Offline tests for `configure_system.py` (mocked `VmsSystem`). |
| `test_format_output.py` | Offline tests for `format_output.py`. |
| `requirements.txt` | `requests` + `pytest`. |
| `system_setting.conf` | System configuration template — copy and edit this. |
| `cloud_hosts.json` | Maps powered-by-Nx products to their cloud host and customization. |
| `configure_system.log` | Generated at runtime — execution log. |
