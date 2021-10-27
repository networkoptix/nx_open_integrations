// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Create/Restore System Backup via API

Nx Witness allows third-party developers to back up and restore their system database using the API.

We provide examples and explanations for both the new API available in Nx Witness 5.0 (and newer) and the deprecated API available in Nx Witness 4.2 (and older). Refer to [Nx Server HTTP REST API](https://support.networkoptix.com/hc/en-us/articles/219573367-Nx-Server-HTTP-REST-API) for more information on our APIs and on accessing our API documentation.

## Using the Sample Scripts

The sample scripts provided in the repository are a basic demonstration of what scripts that use the system backup and restore API calls could look like. They also contain code used for authentication (refer to the section below).

To test the examples, input your information where applicable and run it.

#### Authentication

Nx Witness 5.0 uses HTTP bearer/session token authentication, while Nx Witness 4.2 uses HTTP Basic and Digest authentication. We perform the API requests below as local users. Refer to [Nx Meta Authentication](https://support.networkoptix.com/hc/en-us/articles/4410505014423-Nx-Meta-Authentication) for more info.

### How to Create a System backup
The API requests used to create a system backup are the following:
*  New API: `GET​/rest​/v1​/system​/database`
*  Deprecated API: `GET/ec2/dumpDatabase`

The requests accomplish this by creating a binary dump of your system database, which you would need to capture into a file.

The backup scripts are designed to create a backup of your Nx system in the form of a binary file, which will be named as `systembackup_{backup_time}.bin`, where the {backup_time} portion will reflect the time at which the script was run.

### How to Restore a System Backup
The API requests used to restore a system backup are the following:
*  New API: `POST​/rest​/v1​/system​/database`
*  Deprecated API: `POST/ec2/restoreDatabase`

The requests accomplish this by loading the system database from the binary dump that was provided in the backup request.

The system restore scripts assume your system backup is in binary file format. To use them, replace `‘FILENAME’` with the name of the backup file you want to restore your system database with.

## Authors

**Network Optix**

## License
This project is licensed under the [Mozilla Public License, v. 2.0](
http://mozilla.org/MPL/2.0/) - see the [LICENSE.md]() file for details.
