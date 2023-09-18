// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Sample Scripts Usage Guide Configure the system(s) via the mediaserver API (V1/V2)

We offer a sample script to demonstrate the  functionalities realized through leveraging the mediaserver API calls. 
This scripts will serve as a foundational base to understand how to interact with system settings and cloud connectivity through the specified APIs.

# Funtion Highlights

Configuring System Default Settings: Gain insights into setting up the default system configurations efficiently.
Cloud Connectivity: Connect the system seamlessly either for an existing system or a fresh installation with cloud services using API calls.
Nx Witness allows third-party developers to configure the system by using the mediaserver API.
- Connect to Nx Cloud (Ture/False) and attach to a specific Nx Cloud Account
- Enable the Auto Discovery (Ture/False)
- Enable the Camera Optmization (Ture/False)
- Enable the Anonymous statistics collection (Ture/False)
- Name the system
- Set the local admin password.

Here we provide examples and explanations for the new API available in Nx Witness 5.1 (and newer). 
Refer to [Nx Server HTTP REST API](https://support.networkoptix.com/hc/en-us/articles/219573367-Nx-Server-HTTP-REST-API) for more information on APIs and on accessing API documentation.

## Using the Sample Script

To commence with script testing, adhere to the following instructions:

1. Prepare System Information: Collate all the requisite system information.
2. CSV File Setup: Incorporate your details in a CSV file, taking reference from the existing [system.csv] format.
3. Script Initialization: The script is designed to autoload the system information from the mentioned file.
4. Output the result : The summary report will tell if the system has been successfully configured. (also print the result on the console or silently done)

Please find the available options by using python3 [configure_systems.py] --help.

## Utilizing Custom CSV File

For a more tailored experience, you have the liberty to utilize your CSV file. Proceed as follows:
1. Create a Custom CSV File: Insert the necessary information in your personalized CSV file. (Please refer to the format of sample [system.csv])
2. Use -f or --file option to direct the script to read settings from your CSV file and execute corresponding operations.

Notice: True = Connected/Enabled, False = Disconnected/Disabled

#### Authentication

Nx Witness uses HTTP bearer/session token authentication by default. 
We perform the API requests below with credentials of local user accounts. 
Refer to [Nx Meta Authentication](https://support.networkoptix.com/hc/en-us/articles/4410505014423-Nx-Meta-Authentication) for more info.

### How to connect/detach the system to Nx Cloud via API.

The APIs that used to connect a system to the cloud : 
- POST /api/systems/connect
- POST /rest/v2/system/cloudBind

You would need to create the JSON payload for the system which is going to be connected to the cloud.
Then you can call the cloudbind API to trigger the cloud connection opeartion.

Same operation for detaching, you are asked to use the admin(owner) to login the system then detach the system from the cloud.

### How to configure the system default settings via API. 

The APIs that used to configure the system default settings : 
- POST /rest/v2/system/setup
- PATCH /rest/v2/system/settings

You are more than welcome to extend the script to facilitate other system configurations.
The full list of system configuration can be retireve from the following APIs, 
- /rest/v2/system/settings
- /rest/v2/system/settings/*/manifest

### The output of the script

There is a script execution log file, called [system_setup.log]. 
You would be able to find the detail during the execution of this sample script, including the fail/success requests and the final result of the system. (whether it is setup successfully)

There is a output summary.[{timestamp}_result_summary.log]
The summary report will tell if the system has been successfully configured. (For those can be login and configured, if it is failed during login, it won't be in this output file)
Sample output : 
====================
* Start Time                  : 2023-01-01 00:00:00
* System Name                 : Nx_test
* Connect to Cloud            : DISCONNECTED(LOCAL)
* Auto Discovery              : ENABLED
* Anonymous Statistics Report : ENABLED
* Camera Optimization         : DISABLED
* Finish Time                 : 2023-01-01 00:00:10

## Authors

**Network Optix**

## License
This project is licensed under the [Mozilla Public License, v. 2.0](
http://mozilla.org/MPL/2.0/) - see the [LICENSE.md]() file for details.
