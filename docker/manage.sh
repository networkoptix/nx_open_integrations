#!/bin/bash
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# This is helper script to be installed inside container.
# It can:
#  - wrap some actions from Dockerfile
#  - change cloud host for mediaserver.

display_usage() 
{
	echo "This is helper for building docker image from debian package for mediaserver."
	echo -e "Usage:\n$0 [--cloud cloud_host] [--norestart]\n"
	echo "Possible arguments:"
	echo -e " -c|--cloud cloud_host patches mediaserver to use specified cloud host"
	echo -e " --norestart pending operations will not restart mediaserver through systemd"
}
# Exit on error and using undefined variables causes error and exit
set -eu

MEDIASERVER_CONF=/opt/networkoptix/mediaserver/etc/mediaserver.conf
MEDIASERVER_NETWORK_SO=/opt/networkoptix/mediaserver/lib/libnx_network.so

CLOUD_HOST_NAME_WITH_KEY=$(eval echo \
"this_is_cloud_host_name cloud-test.hdw.mx")

# Should we stop/start systemd networkoptix-mediaserver service while changing cloud host
NORESTART=0

raise_error() 
{
	echo -e "$1. Exiting..." >&2 
	exit 1
}

# If no CLOUD_HOST_KEY, show the current text, otherwise, patch FILE to set the new text.
# [in] NEW_CLOUD_HOST
# Extracted from devtools/utils/patch-cloud-host.sh

POSITIONAL=()

# Parsing arguments
while [[ $# -gt 0 ]] ; do
    key="$1"

    case $key in
        -c|--cloud)
            NEW_CLOUD_HOST="$2"
            shift
            shift
            ;;
        --norestart)
            NORESTART=1
            shift
            ;;
        *)
            POSITIONAL+=( "$1" )
            shift
            ;;
    esac
done

if [[ -n "$NEW_CLOUD_HOST" ]] ; then
    patch_cloud_host
else
    echo "Leaving cloud_host as is"
fi