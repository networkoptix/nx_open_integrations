// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Build a mapping of resources and accounts in the system.

Nx Witness allows third-party developers to retrieve a resource(Devices, Webpages, Layouts, Health graphs) from the system database using the mediaserver API.

Here we provide examples and explanations for the new API available in Nx Witness 5.0 (and newer). 
Refer to [Nx Server TTP REST API](https://support.networkoptix.com/hc/en-us/articles/219573367-Nx-Server-HTTP-REST-API) for more information on APIs and on accessing API documentation.

## Using the Sample Scripts

The sample scripts provided in the repository are for basic demonstration of what scripts that use the system API calls could look like. 
For example, you can see how to retrieve the resource infomration from the system databse. 
The scripts also contain the code for authenticating to a System. (refer to the [Authentication](#authentication) section below).
To test a script example, insert your information where applicable and run the script.

#### Authentication

Nx Witness 5.0 uses HTTP bearer/session token authentication by default. 
We perform the API requests below with credentials of local user accounts. 
Refer to [Nx Meta Authentication](https://support.networkoptix.com/hc/en-us/articles/4410505014423-Nx-Meta-Authentication) for more info.

### How to retrieve the resources and users from a System
The API requests used to retrieve the resources from the system are the following:
*  Devices: `GET /rest/v2/devices`
*  Layouts: `GET /rest/v2/layouts`
*  Wepages: `GET /rest/v2/webPages`
*  Servers: `GET /rest/v2/servers`
*  Users:   `GET /rest/v2/users`

The requests return a JSON object that contains the detailed information on each resource. You can retrieve the desired value by parsing the JSON.

### How to create the mapping of a resource and associated accounts
In the response of the `GET /rest/v2/users` API, you retrieve the list of accassible resources for each account. 
The resource could be a device, webpage, layout, or server health monitoring graph.

If it is a device, the Id should match one of the Ids in the response of `GET /rest/v2/devices`
If it is a webpage, the Id should match one of the Ids in the response of  `GET /rest/v2/layouts`
If it is a layout, the Id should match one of the Ids in the response of `GET /rest/v2/webPages`
If it is a server health monitoring graph, the Id should match one of the Ids in the response of  `GET /rest/v2/servers`

Now, we have all the information required for creating the mapping of resources and users.


### The output of the script
You may create your preffered pressenation format of the result. 
In the script, we use JSON as the default output format. 
The sample output can be seen in the [resource_to_user_mapping_by_resource_name.json](resource_to_user_mapping_by_resource_name.json)



## Authors

**Network Optix**

## License
This project is licensed under the [Mozilla Public License, v. 2.0](
http://mozilla.org/MPL/2.0/) - see the [LICENSE.md]() file for details.
