// Copyright 2018-present Network Optix, Inc.
Licensed under [Mozilla Public License, v. 2.0](http://mozilla.org/MPL/2.0/)

# Nx Open Integrations – Python Examples #

## 1. Abstract ##

A collection of **ready-to-run Python scripts** that illustrate how to automate or extend
the **Network Optix Products** through the Mediaserver HTTP REST API, Cloud DB API,
and WebSocket Event API, and OAuth 2.0 Cloud services.

*Tips: You may refer to these samples as the starting point for your own tools or integrations*.

---

## 2. Folder Structure and Files Overview ##

This section provides an overview of the main folders within the examples.

|Folder |What it Covers |Functions Highlight |
|- |- |- |
|`authentication` |Authentication scheme |This folder contains 4 example scripts for references. |
|`configure_system_via_api` |System configuration |Initialize and configure sites via APIs. |
|`system_backup_and_restore/` |Database backup/restore |Backup and restore of a site via APIs. |
|`common/` |Shared helper module| This module provides common functions. |
|`Stand-alone Scripts` |Individual how-tos for common tasks |See the list below for details. |

---

### Stand-alone Scripts ###

This table lists individual scripts that demonstrate specific common tasks.

|Script Name |Purpose |
|- |- |
|`add_camera_digest.py` |Add ONVIF cameras/RTSP streams manually via HTTP Digest authentication. |
|`generic_event.py` |Send custom Generic Events to systems for use in event rules and analytics. |
|`import_to_virtual_camera.py` |Import mp4 files into a Virtual Camera for backfilling video. |
|`setup_rule_schedule.py` |Build or apply a **weekly rule schedule bit-mask** via APIs. |

---

## 3. Quick Start ##

Follow these steps to get started with the Python examples.

1. **Install Python and required libraries**. Ensure you have **Python 3.8+**.

    ```bash
    python --version # Check your version
    # Ensure you have Python 3.8 or higher
    ```

2. **Install the `requests` library using pip**:

    ```bash
    pip install requests
    ```

3. **Clone the python examples from the repo**.

    ```bash
    git clone --depth 1 https://github.com/networkoptix/nx_open_integrations.git
    cd nx_open_integrations/python/examples
    ```

4. **Run an example**. Remember to edit variables inside the script or pass flags via the CLI.

    ```bash
    cd authentication
    # Ex: Run the authentication sample
    python cloud_bearer.py
    ```

*Tips: Some scripts accept "**--help**" for more detail on runtime options, ex: URL or system ID*.

---

## 4. Authors ##

**[Network Optix](https://www.networkoptix.com)**
