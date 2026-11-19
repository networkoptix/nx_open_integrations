#!/usr/bin/env bash

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Provision an Ubuntu machine (VM, container or WSL) for building the plugins in
# cpp/vms_server_plugins/, e.g. the OpenCV plugin tutorial: GCC 13, CMake 3.28, Git, Python, and
# Conan 1.66.0 (via setup_conan.sh).
#
# For Ubuntu 24.04. Runs apt-get via sudo unless run as root. Safe to re-run.
#
# Usage: provision_ubuntu.sh [--clang]
#     --clang: Also install Clang (18).

set -euo pipefail

withClang=0
for arg in "$@"; do
    case "$arg" in
        --clang) withClang=1 ;;
        -h|--help) sed -n '5,13s/^# \?//p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg (see --help)" >&2; exit 2 ;;
    esac
done

if ! grep -q '^VERSION_ID="24.04"' /etc/os-release 2>/dev/null; then
    echo "Warning: this script is for Ubuntu 24.04; the plugins need CMake 3.28 or later." >&2
fi

packages=(
    build-essential cmake git python3 python3-venv curl ca-certificates pkg-config unzip
    patchelf #< Used by the plugins that package their dependencies, e.g. the OpenVINO plugin.
)

if (( withClang )); then
    packages+=(clang)
fi

sudo=""
if [[ $(id -u) -ne 0 ]]; then
    sudo="sudo"
fi

export DEBIAN_FRONTEND=noninteractive
$sudo apt-get update -q
$sudo apt-get install -y -q --no-install-recommends "${packages[@]}"

"$(dirname "$0")/setup_conan.sh"

echo "Done: $(g++ --version | head -1), $(cmake --version | head -1)."
