#!/bin/bash
# Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

set -o errexit
set -o pipefail
# set -o xtrace # Uncomment this line for debugging purposes.

declare -r ENTRYPOINT_SCRIPTS_DIR="/opt/mediaserver/entrypoint.d"

# Run user-supplied initialization scripts.
if [[ -d "${ENTRYPOINT_SCRIPTS_DIR}" ]]; then
    echo "Loading user's custom *.sh,*.py scripts from ${ENTRYPOINT_SCRIPTS_DIR}"
    find "${ENTRYPOINT_SCRIPTS_DIR}" -type f -executable -regex ".*\.\(sh\|py\)" | sort | \
    {
        while read script; do
            if ! "${script}"; then
                echo "Failed to execute ${script}" >&2
                return 1
            fi
        done
    }
fi

# No arguments provided, run the VMS Server.
if [[ $# -lt 1 ]]; then
    if [[ -x /opt/${COMPANY}/mediaserver/bin/mediaserver-bin ]]; then
        echo "Launching mediaserver-bin for version < 4.3"
        exec "/opt/${COMPANY}/mediaserver/bin/mediaserver-bin" -e
    else
        echo "Launching mediaserver"
        exec "/opt/${COMPANY}/mediaserver/bin/mediaserver" -e
    fi
fi

# Argument(s) supplied, assume the user wants to run a different process, for example a `bash`
# shell to explore the image.
exec "$@"
