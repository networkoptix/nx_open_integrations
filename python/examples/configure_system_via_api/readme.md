// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/ or see the [LICENSE.md](https://github.com/networkoptix/nx_open_integrations/blob/master/license_mpl2.md) file for more details.

# Sample scripts Usage Guide 
## Configure the system(s) through the REST API

We offer a sample script to demonstrate the functionalities realized through leveraging the REST API calls. 
This script will serve as a starting point to understand how to interact with the system settings and cloud connectivity through the specified APIs.

# Function Highlights

Configuring System Default Settings: Gain insights into setting up the default system configurations efficiently.

Cloud Connectivity: Connect the system seamlessly either for an existing system or a fresh installation with cloud services using API calls.

Configure the system configurations and allow third-party developers to change the settings of a VMS by using the REST API calls.
- Connect to the Cloud (True/False) and attach to a specific Cloud Account
- Enable/disable Auto Discovery (True/False)
- Enable/disable Camera Optmization (True/False)
- Enable/disable the Anonymous statistics collection (True/False)
- Set the name the system
- Set the local admin password.

Below we provide examples and explanations for the new API available in the VMS (v5.1 and newer). 
Refer to [Nx Server HTTP REST API](https://support.networkoptix.com/hc/en-us/articles/219573367-Nx-Server-HTTP-REST-API) for more information on APIs and on accessing API documentation.

## Using the sample script

To commence with script testing, adhere to the following instructions:

1. Prepare System Information: Collect all the required system information.
2. Configuration file setup: Incorporate the desired details in the format of "key=value", it is also suggested that refer to the [system_settings.conf](system_settings.conf) in the folder.
3. Script Initialization: The script is designed to autoload the system information from the mentioned file.
4. Output the result : The summary report will tell if a system has been successfully configured. (also print the result on the console or silently done)

Please download the [configure_systems.py](configure_systems.py) file and check the available options by using the following command:

`python3 configure_systems.py --help`.

## Create the required configuration file

For a more tailored experience, you have the ability to create your own configuration file. Proceed as follows:
1. Insert the necessary information in your personalized configuration file in "key=value" format.(Please refer to the format of sample [system_settings.conf](system_settings.conf)).
2. Use `-f` or `--file` option to direct the script to read the settings from your customized file and execute corresponding operations.

**NOTE:** True = Connected/Enabled, False = Disconnected/Disabled

### Authentication

The VMS uses an HTTP bearer/session token authentication by default. 
We execute the API requests below with credentials of local user accounts. 
Please refer to [Nx Meta Authentication](https://support.networkoptix.com/hc/en-us/articles/4410505014423-Nx-Meta-Authentication) for more information.

### How to connect/detach a system to Cloud through the REST API.

The following API commands are used to connect a system to the Cloud : 
- POST /api/systems/connect
- POST /rest/v2/system/cloudBind

You would need to create a JSON payload for the desired system you want to connect to the Cloud.
Then you can call the cloudbind API to trigger the cloud connection.
The same steps can be made for detaching a system from the cloud, you are asked to use the admin(owner) account to login the system to detach the system from the Cloud.

### How to configure the system default settings via API. 

The following API commands are used to configure the system default settings : 
- POST /rest/v2/system/setup
- PATCH /rest/v2/system/settings

You can change the script to facilitate other system configurations.
The full list of system configuration options can be retrieved from the following APIs commands:
- /rest/v2/system/settings
- /rest/v2/system/settings/*/manifest

### The output of the script

There is a script execution log file, called [configure_system.log]. 
You would be able to find the details while executing this sample script, including the failed/successfull requests, and the final result of the system. (whether it is setup successfully or not)

There is a output summary file, called [{system_name}_{timestamp}_configure_result.log].
The summary report will inform you if the system has been configured successfully.

By default, the executed result will be shown on the terminal.
If the user uses the option "-s" or "--silent", the output will not be displayed.


### Multiple systems 

If you have to configure multiple systems at a time, you can create a wrapper by feeding different configurations files.

### Extend the script to configure more system configurations
It is also possible to configure more configurations.

You may put the name of configuration in the dataclass, VmsSystemSettings.
Then modify the script by adding the function to change configurations; also, please remeber to extend or add extra key,value pair in the configuration files.