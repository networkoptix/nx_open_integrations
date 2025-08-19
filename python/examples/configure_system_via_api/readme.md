// Copyright 2018-present Network Optix, Inc.
Licensed under [MPL 2.0](https://www.mozilla.org/MPL/2.0/)

# Configure System Via APIs

## 1. Abstract

This sample script shows how to use REST APIs for system and cloud setup.  
It helps users understand basic configuration and cloud setup via mediaserver and CDB API calls.

## 2. File strcuture

| File Name               | Description |
| ----------------------- | --------------------------------------------------------------- |
| **cloud_hosts.json**    | Contains cloud host list.                                       |
| **configure_system.py** | The main script to execute the requests.                        |
| **system_setting.conf** | System configuration file template.                             |
| **vms_system.py**       | Handles system-specific logic for VMS setup and initialization. |
| **format_output.py**    | Handles the file and terminal std print out.                    |
| **readme.md**           | This readme file.                                               |

## 3. Function Highlights

* Configuring System Default Settings: Setup the default system configurations.
* Cloud Connectivity: Connect new or existing systems to cloud services seamlessly via the APIs.
* Sample configurations:
    * Connect to the Cloud and/or Organization.
    * Enable/disable Auto Discovery.
    * Enable/disable Camera Optmization.
    * Enable/disable the Anonymous statistics collection.
    * Setup the name the system
    * Set the local admin password.

## 4. Quick Start

To begin testing the script, follow these steps:

1. Prepare system config: Gather all required system configuration values.
2. Set up config file: Add each item as a key=value pair.
3. Run the script: The script will autoload the config file.
4. Check output: A summary report will confirm if the system was configured successfully.

See configure_systems.py for details or run:

```bash
python3 configure_systems.py --help
```

For a custom setup:

1. Add the configuration pair, "key=value" to [system_settings.conf](system_settings.conf).
2. Use the `-f` or `--file` option to load your custom configuration.

## 5. Authentication

The VMS uses an HTTP bearer/session token authentication by default.
We execute the API requests below with credentials of local user accounts.
Please refer to
[Nx Authentication](https://support.networkoptix.com/hc/en-us/articles/4410505014423-Nx-Meta-Authentication)
for more info.

## 6. How to Connect/Disconnect a System to Cloud through The REST API

### 6.1. Connect the system to a personal cloud account

The following API commands are used to connect a system to the Cloud :

* POST /cdb/systems/bind
* POST /rest/v3/system/cloud/bind

Create a JSON payload for the system you want to connect to the Cloud.  
Call the `bind` API to trigger the cloud connection procedure.

### 6.2. Connect the system to an organization

The following API commands are used to connect a system to the Cloud and under an organization :

* POST /partners/api/v3/cloud_systems/
* POST /rest/v3/system/cloud/bind

Create a JSON payload for the system you want to connect to the Cloud under an organization.  
Call the `bind` API to trigger the cloud connection.  

### 6.3. Disconnect the system from the Cloud

The following API command is used to disconnect a system to the Cloud.

* POST /rest/v3//system/cloud/unbind

Create a JSON payload for the system you want to disconnect to the Cloud..  
Call the `unbind` API to trigger the cloud disconnection procedure.

> If it possible to use the same disconenction procedure whether the system is
connected to a personal account or an organization.

## 7. How to configure the system default settings via API

The following API commands are used to configure the system default settings :

* POST /rest/v3/system/setup
* PATCH /rest/v3/system/settings

You can change the script to facilitate other system configurations if reuqired.  
The full list of system configuration options can be retrieved from the following APIs commands:

* GET /rest/v3/system/settings
* GET /rest/v3/system/settings/*/manifest

## 8. The output of the script

The script generates a log file: `configure_system.log` with execution details.  
It shows request results (success/fail) and whether the system was configured properly.  

A summary file is also created: `{system_name}_{timestamp}_configure_result.log`.  
It reports if the system setup completed successfully.  

By default, results show in the terminal.  
Use `-s` or `--silent` to suppress terminal output.

## 9. Multiple systems

To configure multiple systems, create a wrapper script.  
The user can achieve this by feeding different configurations files for each system.

## 10. Extend the script to configure more system configurations

You can configure more settings by using the `VmsSystemSettings` dataclass.  
Add config names to the dataclass and update the script with functions to set them.  
Remember to add key-value pairs in the config files as needed.
