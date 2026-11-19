#!/usr/bin/env bash

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Set up Conan for building nx_open_integrations plugins (cpp/vms_server_plugins/*) on Linux.
#
# Installs Conan 1.66.0 (Conan 2 is not supported) into its own Python virtual environment in
# ~/.local/share/conan1, links it as ~/.local/bin/conan, and enables Conan revisions, which the nx
# remote requires (same setting as nx_open's CI conan_config/conan.conf). Also creates Conan's
# default profile from the installed compiler (with the C++11 ABI of libstdc++), so that it doesn't
# have to be set up by hand; the plugins' CMake brings everything else (remotes, the Nx CI profiles
# where used, packages). Adds Clang 18 (Ubuntu 24.04) to the compilers Conan 1.66 knows, which end
# at Clang 17. Needs python3 with venv and a compiler (provision_ubuntu.sh installs them).
# Safe to re-run.

set -euo pipefail

readonly CONAN_VERSION="1.66.0"
readonly venv="$HOME/.local/share/conan1"
readonly binDir="$HOME/.local/bin"

python3 -m venv "$venv"
"$venv/bin/python" -m pip install --quiet --upgrade pip
"$venv/bin/python" -m pip install --quiet "conan==$CONAN_VERSION"
mkdir -p "$binDir"
ln -sf "$venv/bin/conan" "$binDir/conan"

"$binDir/conan" config set general.revisions_enabled=1
"$binDir/conan" config init >/dev/null 2>&1 #< Creates settings.yml if missing.
readonly settings="$("$binDir/conan" config home)/settings.yml"
sed -i 's/"13", "14", "15", "16", "17"\]/"13", "14", "15", "16", "17", "18"]/' "$settings"
if ! grep -q '"17", "18"' "$settings"; then
    echo "Warning: could not add Clang 18 to $settings (made by another Conan version?);" \
        "building with Clang 18 needs it." >&2
fi
"$binDir/conan" profile new default --detect --force >/dev/null 2>&1
if "$binDir/conan" profile get settings.compiler.libcxx default >/dev/null 2>&1; then
    "$binDir/conan" profile update settings.compiler.libcxx=libstdc++11 default
fi
"$binDir/conan" --version

case ":$PATH:" in
    *":$binDir:"*) ;;
    *) echo "Add $binDir to PATH to use \`conan\` (on Ubuntu, a new login shell does it)." ;;
esac
