// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Configure the system(s) via the mediaserver API (V1/V2)

Nx Witness allows third-party developers to configure the system by using the mediaserver API.
- Connect to Nx Cloud (Ture/False) and attach to a specific Nx Cloud Account
- Enable the Auto-discovery (Ture/False)
- Name the system
- Set the local admin password.

Here we provide examples and explanations for the new API available in Nx Witness 5.1 (and newer). 
Refer to [Nx Server HTTP REST API](https://support.networkoptix.com/hc/en-us/articles/219573367-Nx-Server-HTTP-REST-API) for more information on APIs and on accessing API documentation.

## Using the Sample Scripts

The sample scripts provided in the repository are for basic demonstration of what scripts that use the system API calls could look like. 
For example, you can see how to configure the system default settings and how to connect the system to cloud via APIs. 
The scripts also contain the code for authenticating to a System. (refer to the [Authentication](#authentication) section below).
To test a script example, insert your information where applicable and run the script.

#### Authentication

Nx Witness uses HTTP bearer/session token authentication by default. 
We perform the API requests below with credentials of local user accounts. 
Refer to [Nx Meta Authentication](https://support.networkoptix.com/hc/en-us/articles/4410505014423-Nx-Meta-Authentication) for more info.

### How to connect the system to Nx Cloud via API.

The APIs that used to connect a system to the cloud : 
- POST /api/systems/connect
- POST /rest/v1/system/cloudBind       

### How to configure the system default settings via API. 

The APIs that used to configure the system default settings : 
- POST /rest/v1/system/setup
- PATCH /rest/v1/system/settings


### The output of the script

There is a log file, called [system_setup.log]. 
You would be able to find the execution detail of the script, including the fail/success requests and the final result of the system. (whether it is setup successfully)

There is a output summary.[{timestamp}_result_summary.log]
The summary report will tell if the system has been successfully connected to the cloud. 
If yes, then show which Cloud account was the system attached to.
If no, then the system was available by local accounts.(Not connect to the Cloud)
Sample output : 
====================
* Start at                    : 2023-09-13 16:54:31
* System Name                 : Nx_test
* Connect to Cloud            : DISCONNECTED(LOCAL)
* Auto Discovery              : DISABLED
* Anonymous Statistics Report : ENABLED
* Camera Optimization         : ENABLED
* Finish at                   : 2023-09-13 16:54:31

## Authors

**Network Optix**

## License
This project is licensed under the [Mozilla Public License, v. 2.0](
http://mozilla.org/MPL/2.0/) - see the [LICENSE.md]() file for details.
