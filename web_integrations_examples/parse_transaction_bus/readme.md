// Copyright 2022-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Parsing incoming messages from WebSocket

The HTML sample provided in the repository demonstrates parsing incoming messages from WS with type "broadcastAction".

To test the sample, run it and enter your information at the top (including the camera ID). Then click Connect.

To view the result, you need to open the console.

# Version

The code expects the 5.1 or later version Media Server listening at the endpoint.

### Request Format

Use the following format to create a listener that will listen for events on the camera:

`wss://<login>:<password>@<server_ip>:<server_port>/ec2/transactionBus/websoket`

## License
This project is licensed under the [Mozilla Public License, v. 2.0](
http://mozilla.org/MPL/2.0/) - see the [LICENSE.md]() file for details.