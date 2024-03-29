# Utility "http_proxy_with_feedback"

// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

## General information

This simple utility can be used for proxying the incoming GET http-requests to other servers and
reporting the unsuccessful results to Nx Server via the mechanism of Generic Events.

## Using the utility

To use this utility, place the following files in the same folder:
- `http_proxy_with_feedback.exe` (utility executable)
- `http_proxy_with_feedback.conf` (configuration file)

When http_proxy_with_feedback.exe (Utility) runs, it serves incoming http-requests on the port
defined in the configuration file (the "port" parameter in the "general" section, default is 8000),
forwards them to the address obtained from the requests and returns the result to the caller. The
requests must be in the form `http://<addres_of_the_server_where_proxy_runs>:<proxy_port>/?request=<target_url>`,
i.e., if you need to call `https://10.0.0.1:8080/some_path?foo=bar`, you should call
`http://<addres_of_the_server_where_proxy_runs>:<proxy_port>/?request=https://10.0.0.1:8080/some_path?foo=bar`.
All the request headers are passed to the target URL as is.

If the target request fails (returns the HTTP status greater of equal to 400), the Utility also
creates a Generic Event on the VMS Server. The address of the Server is assumed to be the same as
the client address of the request to the Utility, or, if the `address` parameter is present in the `vms`
section of the configuration file, is taken from this parameter.

The Utility writes its actions to file `http_proxy_with_feedback.log` located in the same directory
as the Utility executable (the file name can be changed in the configuration file). The log level can be
set by the parameter `log_level` in the section `general` of the configuration file. The allowed
values are `DEBUG`, `INFO` (the default), `WARNING`, `ERROR`, and `CRITICAL`.

The two other important parameters of the configuration file are `user` and `password` in the
section `vms`. These parameters contain credentials of the Server User and are needed to create
Server Events.
