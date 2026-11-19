#!/usr/bin/env bash

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Test the Linux build environment and the OpenCV plugin tutorial, the way ../readme.md describes
# them, in a Docker container (see readme.md in this directory):
# - Build the Ubuntu 24.04 image of ../provision_scripts/ubuntu.Dockerfile with Clang
#   (provision_ubuntu.sh --clang, setup_conan.sh).
# - Download the SDK with ../provision_scripts/download_sdk.py.
# - In a container: build the OpenCV plugin tutorial (start, step1-step5) with GCC and with Clang,
#   and the OpenVINO plugin with GCC, each with a fresh Conan cache; check that each build used the
#   intended compiler; run each tutorial plugin with run_plugin on test images, and check that it
#   finds the expected objects and events, with the same types of them from GCC and Clang.
#
# Needs Docker and Python 3. Takes about 20 minutes. Prints a summary; exits with 1 if a check
# failed. Logs and builds are in the work dir.
#
# Usage: test_linux.sh [-w <work dir>] [-s <SDK version>]
#     -w: Work dir (default: /tmp/nx_plugin_tests); its previous content is deleted.
#     -s: SDK version for download_sdk.py (default: 6.1.3).

set -euo pipefail

readonly openDir="$(cd "$(dirname "$0")/../../../.." && pwd)"
readonly provisionDir="$openDir/cpp/vms_server_plugins/scripts/provision_scripts"
readonly image="nx-plugin-test"

if [[ ${1:-} != --in-container ]]; then
    workDir="/tmp/nx_plugin_tests"
    sdkVersion="6.1.3"
    while getopts "w:s:h" option; do
        case "$option" in
            w) workDir="$OPTARG" ;;
            s) sdkVersion="$OPTARG" ;;
            *) sed -n '5,23s/^# \?//p' "$0"; exit 2 ;;
        esac
    done

    mkdir -p "$workDir"
    workDir="$(cd "$workDir" && pwd)"
    if ! rm -rf "${workDir:?}"/* 2>/dev/null; then
        # Files of an interrupted run may belong to root of the container.
        docker run --rm -v "$workDir:/work" ubuntu:24.04 find /work -mindepth 1 -delete
    fi

    echo "Building the Docker image (logs: $workDir/docker_build.log)"
    if ! docker build -t "$image" --build-arg PROVISION_ARGS=--clang \
        -f "$provisionDir/ubuntu.Dockerfile" "$provisionDir" >"$workDir/docker_build.log" 2>&1
    then
        tail -20 "$workDir/docker_build.log"
        echo "FAIL: docker build"
        exit 1
    fi

    echo "Downloading SDK $sdkVersion"
    sdk="$(python3 "$provisionDir/download_sdk.py" "$sdkVersion" -o "$workDir/sdk")"

    docker run --rm -v "$openDir:/src:ro" -v "$sdk:/sdk:ro" -v "$workDir:/work" \
        -e "hostUser=$(id -u):$(id -g)" "$image" /src/cpp/vms_server_plugins/scripts/tests/test_linux.sh --in-container
    exit
fi

# In the container: /src is the open/ dir of the repository, /sdk the SDK, /work the work dir.

# Make the files of the work dir the user's.
trap '[[ -n ${hostUser:-} ]] && chown -R "$hostUser" /work' EXIT

readonly plugins="/src/cpp/vms_server_plugins"
readonly tutorial="$plugins/opencv_object_detection_analytics_plugin"
failures=0
summary=()

function report() #< result description...
{
    local -r result="$1"
    shift
    summary+=("$(printf '%-5s %s' "$result" "$*")")
    echo "$result: $*"
    if [[ $result == FAIL ]]; then
        failures=$((failures + 1))
    fi
}

function build() #< compiler name source_dir sdk_dir_variable
{
    local -r compiler="$1" name="$2" source="$3" sdkVariable="$4"
    local -r buildDir="/work/$compiler/$name"
    local compilerVariables=() expectedId="GNU"
    if [[ $compiler == clang ]]; then
        # As in the scripts readme.md, "Building with Clang".
        compilerVariables=(CC=clang CXX=clang++)
        expectedId="Clang"
    fi

    # A fresh Conan cache for each compiler, shared by its builds, like on a new provisioned
    # machine: with the configuration that setup_conan.sh made, and no packages.
    local -r conanHome="/work/$compiler/conan_home"
    if [[ ! -d $conanHome ]]; then
        mkdir -p "$conanHome/.conan"
        cp -r ~/.conan/conan.conf ~/.conan/settings.yml ~/.conan/profiles "$conanHome/.conan/"
    fi
    if ! env "${compilerVariables[@]}" CONAN_USER_HOME="$conanHome" \
        bash -c 'cmake -B "$1" -S "$2" -DCMAKE_BUILD_TYPE=Release "-D$3=/sdk" \
            && cmake --build "$1"' \
        -- "$buildDir" "$source" "$sdkVariable" >"$buildDir.log" 2>&1
    then
        report FAIL "$compiler $name: build (see $buildDir.log)"
        return 1
    fi

    local -r compilerId="$(sed -n 's/^set(CMAKE_CXX_COMPILER_ID "\(.*\)")$/\1/p' \
        "$buildDir"/CMakeFiles/*/CMakeCXXCompiler.cmake)"
    if [[ $compilerId != "$expectedId" ]]; then
        report FAIL "$compiler $name: built with $compilerId instead of $expectedId"
        return 1
    fi
    report OK "$compiler $name: build"
}

function run() #< compiler name library expected_type...
{
    local -r compiler="$1" name="$2" library="$3"
    shift 3
    local -r buildDir="/work/$compiler/$name"
    if /work/run_plugin/run_plugin "$buildDir/$library" "$buildDir" /work/frames.bin "$@" \
        >"$buildDir.run.log" 2>&1
    then
        report OK "$compiler $name: run ($(grep -c '^object\|^event' "$buildDir.run.log") types)"
    else
        report FAIL "$compiler $name: run (see $buildDir.run.log)"
    fi
}

cp -r /src/cpp/vms_server_plugins/scripts/tests/run_plugin /work/run_plugin_src
if cmake -B /work/run_plugin -S /work/run_plugin_src -DnxSdkDir=/sdk >/work/run_plugin.log 2>&1 \
    && cmake --build /work/run_plugin >>/work/run_plugin.log 2>&1 \
    && python3 /src/cpp/vms_server_plugins/scripts/tests/make_frames.py /work/frames.bin >>/work/run_plugin.log 2>&1
then
    report OK "run_plugin and test frames"
else
    report FAIL "run_plugin and test frames (see /work/run_plugin.log)"
fi

readonly objects=(nx.base.Dog nx.base.Person)
readonly events=(sample.opencv_object_detection.detection
    sample.opencv_object_detection.prolongedDetection)

for compiler in gcc clang; do
    mkdir -p "/work/$compiler"
    build "$compiler" start "$tutorial/start" nxSdkDir \
        && run "$compiler" start libsample_analytics_plugin.so nx.sample.helloWorld
    for step in step1 step2 step3 step4 step5; do
        expected=()
        case "$step" in
            step1) expected=(nx.sample.helloWorld) ;;
            step2) expected=(nx.base.Person) ;;
            step3|step4) expected=("${objects[@]}") ;;
            step5) expected=("${objects[@]}" "${events[@]}") ;;
        esac
        build "$compiler" "$step" "$tutorial/$step" nxSdkDir \
            && run "$compiler" "$step" libopencv_object_detection_analytics_plugin.so \
                "${expected[@]}"
    done
done

# The OpenVINO plugin builds with the GCC toolchain of the Nx Conan remote, whatever CC and CXX say.
build gcc openvino "$plugins/openvino_object_detection_analytics_plugin" nxSdkDir || true

# The plugin must find the same types of objects and events whatever compiler built it (the counts
# may differ slightly, as each compiler builds its own OpenCV).
for name in start step1 step2 step3 step4 step5; do
    if [[ -f /work/gcc/$name.run.log && -f /work/clang/$name.run.log ]]; then
        if diff <(grep -o '^\(object\|event\) [^:]*' "/work/gcc/$name.run.log") \
            <(grep -o '^\(object\|event\) [^:]*' "/work/clang/$name.run.log") >/dev/null
        then
            report OK "$name: same object and event types from GCC and Clang"
        else
            report FAIL "$name: different object or event types from GCC and Clang" \
                "(see /work/*/$name.run.log)"
        fi
    fi
done

echo
echo "Summary:"
printf '%s\n' "${summary[@]}"
if (( failures )); then
    echo "$failures check(s) failed. Logs are in the work dir (/work in the container)."
    exit 1
fi
echo "All checks passed."
