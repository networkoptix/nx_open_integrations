// Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# OpenCV-based Analytics Plugin for the VMS Server (opencv_object_detection_analytics_plugin)

For more detail read the guide [How to Create a Video Analytics Plugin](https://meta.nxvms.com/docs/developers/knowledgebase/200-introduction-to-creating-a-video-analytics-plugin)

The plugin is built step by step; each directory is a complete plugin:
- `start`: the code to start the tutorial from (copy it), before Step 1. It is based on the sample
  analytics plugin of the Server Plugin SDK, set up to receive uncompressed video frames, which the
  plugin needs for OpenCV, and has its own `CMakeLists.txt` (the SDK builds its samples together,
  so a sample can't be copied out and built on its own).
- `step1` ... `step5`: the result of each step (chapter) of the guide, to compare with your own
  changes.

## Features

- Detect objects (cats, dogs, people).
- Track detected objects.
- Send object detection events.
- Send Integration diagnostic events.

## Prerequisites

- [Nx Meta VMS](https://meta.nxvms.com/download/releases) 6.1.
- [Server Plugin SDK](https://meta.nxvms.com/download/releases/sdk) 6.1.3.43301 (called Metadata
  SDK before 6.1). Since 6.1 the SDK calls the main plugin object an Integration
  (`nx::sdk::analytics::Integration`, formerly `Plugin`).
- CMake 3.28 or later.
- Conan 1.66.0 (steps 3-5; Conan 2 is not supported).
- Windows: Visual Studio 2022 with the MSVC 14.38 toolset, or clang-cl with it.
- Linux: Ubuntu 24.04 with GCC 13, or Clang 18. A plugin built there runs in a Server on Ubuntu
  24.04 (it needs the glibc of the OS it was built on).

The scripts in [cpp/vms_server_plugins/scripts](../scripts) set these up, on a VM or in a
container (see [scripts/readme.md](../scripts/readme.md)):
- Linux: `provision_ubuntu.sh` (compiler, CMake, Conan), or the Ubuntu 24.04 container of
  `ubuntu.Dockerfile`.
- Windows: `provision_windows.ps1` (Python, Visual Studio 2022 Build Tools with MSVC 14.38, Conan),
  or the container of `windows.Dockerfile`. From the repository root, run it as
  `powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\provision_scripts\provision_windows.ps1`.
- Both: `download_sdk.py` downloads the SDK. From the repository root:
  `python3 cpp/vms_server_plugins/scripts/provision_scripts/download_sdk.py 6.1.3` (on Windows,
  `python cpp\vms_server_plugins\scripts\provision_scripts\download_sdk.py 6.1.3`).

No Conan profile has to be set up by hand.

The plugin has been built and tested on Ubuntu 24.04 (GCC 13.3 and Clang 18.1) and on Windows 10
(Visual Studio 2022 Build Tools 17.14 with MSVC 14.38, and its clang-cl 19.1), with the tests in
[scripts/tests](../scripts/tests), and run in the 6.1.3 Server on Ubuntu 24.04.

With Clang on Linux, the plugin uses libstdc++, like the Server. The CMake option
`-DuseLibcxx=ON` links libc++ statically instead, as the SDK suggests for Clang; it needs a static
libc++ built with `-fPIC`, which Ubuntu's libc++ packages are not.

## Dependencies

Steps 3-5 use OpenCV 4.10.0 (the latest version available for Conan 1), downloaded by CMake via
Conan. The CMake option `opencvFromNx` selects where it comes from:
- Linux (default `-DopencvFromNx=ON`): the Nx Conan remote, which the other plugins in this
  repository use: the OpenCV recipe that Nx uses, with protobuf and only the modules the plugin
  uses (core, imgproc, dnn). The prebuilt OpenCV binaries on the Nx remote are built without
  protobuf, which the `dnn` module needs to load the model, so Conan builds this OpenCV from source
  (a few minutes, as it has only three modules), with protobuf 3.21.12 from ConanCenter. This needs
  no system packages. Once the Nx remote has binaries for these options, Conan downloads them
  instead.
- Windows (default `-DopencvFromNx=OFF`): ConanCenter, with OpenCV's default options, prebuilt with
  Visual Studio 2019; these binaries link fine into a plugin built with Visual Studio 2022. Keep
  this default on Windows: with `-DopencvFromNx=ON`, Conan builds OpenCV from source with the
  newest installed MSVC toolset, not 14.38.

OpenCV is linked statically, so the plugin is a single library file.

`-DopencvFromNx=OFF` on Linux also works, but ConanCenter has no prebuilt OpenCV for GCC 13 or the
Clang of Ubuntu 24.04, so Conan builds all of OpenCV with its default options from source (about 25
minutes). These options need some system packages for OpenCV's video I/O dependencies (the plugin
itself doesn't use them). Conan reports the missing ones; install them with:
```
sudo apt-get install -y libva-dev libvdpau-dev xkb-data libx11-dev libx11-xcb-dev libfontenc-dev \
    libice-dev libsm-dev libxau-dev libxaw7-dev libxcomposite-dev libxcursor-dev libxdamage-dev \
    libxdmcp-dev libxext-dev libxfixes-dev libxi-dev libxinerama-dev libxkbfile-dev libxmu-dev \
    libxmuu-dev libxpm-dev libxrandr-dev libxrender-dev libxres-dev libxss-dev libxt-dev libxtst-dev \
    libxv-dev libxxf86vm-dev libxcb-glx0-dev libxcb-render0-dev libxcb-render-util0-dev \
    libxcb-xkb-dev libxcb-icccm4-dev libxcb-image0-dev libxcb-keysyms1-dev libxcb-randr0-dev \
    libxcb-shape0-dev libxcb-sync-dev libxcb-xfixes0-dev libxcb-xinerama0-dev libxcb-dri3-dev \
    uuid-dev libxcb-cursor-dev libxcb-dri2-0-dev libxcb-present-dev libxcb-composite0-dev \
    libxcb-ewmh-dev libxcb-res0-dev libxcb-util-dev
```
or let Conan install them by adding `tools.system.package_manager:mode=install` and
`tools.system.package_manager:sudo=True` to `~/.conan/global.conf`.

Steps 4 and 5 also use OpenCV Tracking-by-Matching from the OpenCV contrib modules, which neither
OpenCV package includes; it is bundled in [opencv_tbm](opencv_tbm).

## Troubleshooting

- **Don't install the system OpenCV** (`libopencv-dev`): it isn't needed, as CMake uses the OpenCV
  from Conan.
- **With `-DopencvFromNx=OFF`, the `giflib` download fails** (404 from
  `downloads.sourceforge.net/project/giflib/giflib-5.2.1.tar.gz`): this happens only when OpenCV is
  built from ConanCenter's recipe (see Dependencies); the ConanCenter recipe of `giflib/5.2.1` for
  Conan 1 points to a URL that no longer exists. Either use the default `-DopencvFromNx=ON`, or fix
  the URL in the Conan cache and configure again:
  ```
  sed -i 's#project/giflib/giflib-5.2.1.tar.gz#project/giflib/giflib-5.x/giflib-5.2.1.tar.gz#' \
      ~/.conan/data/giflib/5.2.1/_/_/export/conandata.yml
  rm -rf ~/.conan/data/giflib/5.2.1/_/_/source
  ```

## Model files

The plugin uses MIT licensed MobileNet SSD model files from https://github.com/chuanqi305/MobileNet-SSD.
They will be downloaded automatically by CMake.

## Building plugins

### Environment variables

On Linux
```
export SERVER_DIR=/opt/networkoptix-metavms/mediaserver
```

On Windows, in the Command Prompt that you use to activate the plugins (see below)
```
set "SERVER_DIR=C:\Program Files\Network Optix\Nx Meta\MediaServer"
```

### Building

Change to the root directory of the plugin (the directory of this readme.md file).

Build the plugin as an ordinary CMake-based project, supplying the path to the Server Plugin SDK.

For example, here is how to build step 1:
```
mkdir build
cd build
```
On Linux
```
cmake -DnxSdkDir=/PATH_TO_SDK/ -DCMAKE_BUILD_TYPE=Release ../step1
cmake --build . --config Release -- -j
```
On Windows, from "Developer PowerShell for VS 2022"
```
cmake -G "Visual Studio 17 2022" -A x64 -T version=14.38 -DnxSdkDir=/PATH_TO_SDK/ -DCMAKE_BUILD_TYPE=Release ../step1
cmake --build . --config Release
```
Use the MSVC 14.38 toolset (`-T version=14.38`): the VMS Server ships the 14.38 C++ runtime, and a
plugin built with MSVC 14.40 or later can crash in it.

To build with Clang instead, provision it (`provision_ubuntu.sh --clang`,
`provision_windows.ps1 -WithClang`) and select it when configuring a new build directory; see
[Building with Clang](../scripts/readme.md#building-with-clang) for details. Use a build
directory of its own: CMake keeps the compiler that a build directory was first configured with.
From the root directory of the plugin:
```
mkdir build-clang
cd build-clang
```
On Linux
```
CC=clang CXX=clang++ cmake -DnxSdkDir=/PATH_TO_SDK/ -DCMAKE_BUILD_TYPE=Release ../step1
cmake --build . --config Release -- -j
```
On Windows, from "Developer PowerShell for VS 2022"
```
cmake -G "Visual Studio 17 2022" -A x64 -T ClangCL,version=14.38 -DnxSdkDir=/PATH_TO_SDK/ -DCMAKE_BUILD_TYPE=Release ../step1
cmake --build . --config Release
```
CMake prints which compiler it uses: `The CXX compiler identification is Clang ...`.

### Activating plugins

Run these commands in the build directory. On Windows, open Command Prompt as Administrator (it
starts in `C:\Windows\system32`), set `SERVER_DIR` there (see above), and go to the build directory
with `cd /d <build directory>`.

For steps 1 and 2 simply copy the resulting library binary to the VMS "plugins" directory:
On Linux
```
sudo systemctl stop networkoptix-metavms-mediaserver
sudo cp libopencv_object_detection_analytics_plugin.so $SERVER_DIR/bin/plugins/
sudo systemctl start networkoptix-metavms-mediaserver
```

On Windows, in Command Prompt as Administrator (`net stop` waits until the Server has stopped)
```
net stop metavmsMediaServer
copy Release\opencv_object_detection_analytics_plugin.dll "%SERVER_DIR%\plugins\"
net start metavmsMediaServer
```

For further steps, remove the library copied on a previous step, and then create the plugin
directory and copy there the resulting library file along with the model files:

On Linux
```
sudo systemctl stop networkoptix-metavms-mediaserver
sudo rm -f $SERVER_DIR/bin/plugins/libopencv_object_detection_analytics_plugin.so
sudo mkdir -p $SERVER_DIR/bin/plugins/opencv_object_detection_analytics_plugin
sudo cp libopencv_object_detection_analytics_plugin.so MobileNetSSD.caffemodel MobileNetSSD.prototxt \
    $SERVER_DIR/bin/plugins/opencv_object_detection_analytics_plugin/
sudo systemctl start networkoptix-metavms-mediaserver
```

On Windows, in Command Prompt as Administrator
```
net stop metavmsMediaServer
if exist "%SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin.dll" del "%SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin.dll"
if not exist "%SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin\" mkdir "%SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin"
copy Release\opencv_object_detection_analytics_plugin.dll "%SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin\"
copy MobileNetSSD.* "%SERVER_DIR%\plugins\opencv_object_detection_analytics_plugin\"
net start metavmsMediaServer
```
