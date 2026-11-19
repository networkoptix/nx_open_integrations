# OpenVINO Object Detection Analytics Plugin

// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

This is an open-source example plugin for Nx Meta demonstrating people detection and tracking. It
may or may not fulfil the requirements of the particular video management system in terms of
reliability and detection quality - use at your own risk. It is based on OpenVINO technology by
Intel, and runs on Intel processors only.

For general information about building and installing Plugins for Nx Server, see `readme.md` in the
Nx Server Plugin SDK (called Metadata SDK before 6.1).

## License

This software is licensed under Mozilla Public License Version 2.0, and uses third-party libraries
that are distributed under their own terms; see the `notice.md` file.

## Building

This example can be compiled for Linux or for Windows. Run the commands below from the root of the
repository (the directory that contains `cpp/`).

### Configure the build environment

The scripts in [scripts/provision_scripts](../scripts/provision_scripts) install what the build
needs; see [scripts/readme.md](../scripts/readme.md) for details, and for building in a container.

On Linux (Ubuntu 24.04)
```
cpp/vms_server_plugins/scripts/provision_scripts/provision_ubuntu.sh
source ~/.profile
python3 cpp/vms_server_plugins/scripts/provision_scripts/download_sdk.py 6.1.3
```

On Windows, in PowerShell as Administrator
```
cd <repository>
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\provision_scripts\provision_windows.ps1
python cpp\vms_server_plugins\scripts\provision_scripts\download_sdk.py 6.1.3
```

`download_sdk.py` downloads and unpacks the Server Plugin SDK, and prints its directory: that is
`<unpacked_zip_dir>` below.

This sets up:
- Linux: GCC 13, CMake 3.28, Python, patchelf, Conan 1.66.0.
- Windows: Python, Visual Studio 2022 Build Tools with the MSVC 14.38 toolset and CMake, Conan
  1.66.0.

The build downloads the rest: Boost 1.83.0 and OpenCV 4.10.0 with Conan (on Linux, also the GCC 13
toolchain from the Nx Conan remote), and Intel OpenVINO (2020.1.023 on Linux, 2020.1.033 on
Windows) from Nx Artifactory. The plugin is tested with Server Plugin SDK 6.1.3.43301 (it uses the 6.1
Integration API).

### Build steps

`<src_dir>` is the directory of this readme: `cpp/vms_server_plugins/openvino_object_detection_analytics_plugin`.

On Linux
```
cmake -B <build_dir> -S <src_dir> -DCMAKE_BUILD_TYPE=Release -DnxSdkDir=<unpacked_zip_dir>
cmake --build <build_dir> --config Release -- -j
```

On Windows, from "Developer PowerShell for VS 2022"
```
cmake -G "Visual Studio 17 2022" -A x64 -T version=14.38 -B <build_dir> -S <src_dir> -DCMAKE_BUILD_TYPE=Release -DnxSdkDir=<unpacked_zip_dir>
cmake --build <build_dir> --config Release
```

Use the MSVC 14.38 toolset (`-T version=14.38`): the Server ships the 14.38 C++ runtime, and
plugins built with MSVC 14.40 or later can crash in it.

On success, the built plugin appears here:
```
<build_dir>/openvino_object_detection_analytics_plugin.zip
```

To install the Plugin, unpack the above zip to a dedicated directory that you need to create:
`<nx_server_installation_dir>/bin/plugins/openvino_object_detection_analytics_plugin/`.
