# Scripts

Scripts for setting up a machine (a VM, a container, or WSL) to build the VMS Server plugins in
`cpp/vms_server_plugins/`, e.g. the OpenCV plugin tutorial, for VMS 6.1, and tests of these
instructions.

- [provision_scripts/](provision_scripts): the scripts that set up a machine (below).
- [tests/](tests): the tests (see [Tests](#tests)).

| Script in `provision_scripts/` | Platform | What it does |
|--------------------------------|----------|--------------|
| `provision_ubuntu.sh` | Linux | Installs everything to build the plugins on Ubuntu 24.04: GCC 13 (`--clang` adds Clang 18), CMake 3.28, Git, Python, and Conan (`setup_conan.sh`). |
| `ubuntu.Dockerfile` | Linux | Ubuntu 24.04 container set up by `provision_ubuntu.sh`. |
| `provision_windows.ps1` | Windows | Installs everything to build the plugins: Python, Git (if winget is available), Visual Studio 2022 Build Tools with the MSVC 14.38 toolset (`install_vs2022_build_tools.ps1`; `-WithClang` adds clang-cl), and Conan (`setup_conan.ps1`). |
| `windows.Dockerfile` | Windows | Windows Server Core container set up by `provision_windows.ps1`. |
| `install_vs2022_build_tools.ps1` | Windows | Installs Visual Studio 2022 Build Tools: MSVC v143 including the 14.38 toolset, Windows SDK, CMake, Ninja. |
| `setup_conan.sh`, `setup_conan.ps1` | Linux, Windows | Install Conan 1.66.0, enable Conan revisions, create the default Conan profile, and (Linux) add Clang 18 to Conan's compiler list. |
| `download_sdk.py` | Both | Downloads and unpacks any version of the Server Plugin SDK (Metadata SDK before 6.1) from meta.nxvms.com and prints its path. |

All scripts are safe to re-run. No Conan profile has to be set up by hand: the plugins' CMake
selects the Conan settings or profiles it needs.

Run the commands below from the root of the repository: the directory that contains `cpp/`.

## Linux

On a VM or WSL with Ubuntu 24.04:

```bash
cpp/vms_server_plugins/scripts/provision_scripts/provision_ubuntu.sh
source ~/.profile #< Puts ~/.local/bin, with conan, on PATH (see below).
sdk=$(python3 cpp/vms_server_plugins/scripts/provision_scripts/download_sdk.py 6.1.3)
cmake -B build -S cpp/vms_server_plugins/<plugin> -DCMAKE_BUILD_TYPE=Release -DnxSdkDir="$sdk"
cmake --build build -- -j
```

After `provision_ubuntu.sh`, `conan` is in `~/.local/bin`, which Ubuntu adds to PATH at login if it
exists. In other terminals, log in again (on a desktop, log out and in; a new terminal window is not
enough), or run `source ~/.profile`.

In a container:

```bash
docker build -t nx-plugin-build -f cpp/vms_server_plugins/scripts/provision_scripts/ubuntu.Dockerfile cpp/vms_server_plugins/scripts/provision_scripts
sdk=$(python3 cpp/vms_server_plugins/scripts/provision_scripts/download_sdk.py 6.1.3 -o "$HOME/nx_sdk")
docker run --rm -it -v "$PWD:/src" -v "$sdk:/sdk" -w /src nx-plugin-build
# In the container:
cmake -B build -S cpp/vms_server_plugins/<plugin> -DCMAKE_BUILD_TYPE=Release -DnxSdkDir=/sdk
cmake --build build -- -j
```

## Windows

As Administrator, in PowerShell (it starts in `C:\Windows\system32`, so go to the repository
first):

```powershell
cd <repository>
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\provision_scripts\provision_windows.ps1
```

By default, Windows doesn't run PowerShell scripts ("running scripts is disabled on this system");
`-ExecutionPolicy Bypass` allows it for this command only, without changing the Windows setting.
(If a group policy of your organization sets the execution policy, it overrides `Bypass`; ask your
administrator.) Run it from your own Windows account: Conan is installed for the current user.
Restart Windows if the script says so ("Restart Windows to finish the installation").

Then, from "Developer PowerShell for VS 2022" (Start menu), which puts `cmake` on PATH. If another
Visual Studio 2022 (e.g. Community) is installed too, the Start menu has two of them; use the one of
the Build Tools, where the provisioning installs the components (`$env:VSINSTALLDIR` ends with
`BuildTools\`):

```powershell
cd <repository>
$sdk = python cpp\vms_server_plugins\scripts\provision_scripts\download_sdk.py 6.1.3
cmake -B build -S cpp\vms_server_plugins\<plugin> -G "Visual Studio 17 2022" -A x64 -T version=14.38 -DCMAKE_BUILD_TYPE=Release "-DnxSdkDir=$sdk"
cmake --build build --config Release
```

Keep the quotes around `"-DnxSdkDir=$sdk"`: without them, Windows PowerShell passes the text
`$sdk` to CMake instead of the SDK path.

In a container (Docker on Windows in Windows containers mode; the image takes about 10 GB), which
starts PowerShell with the MSVC 14.38 environment set up, so the Ninja generator works too. The
container has Python, so the SDK is downloaded there, to `sdk\` in the repository:

```powershell
docker build -t nx-plugin-build-windows -f cpp\vms_server_plugins\scripts\provision_scripts\windows.Dockerfile cpp\vms_server_plugins\scripts\provision_scripts
docker run --rm -it -v "${PWD}:C:\src" -w C:\src nx-plugin-build-windows
# In the container:
$sdk = python C:\nx_scripts\download_sdk.py 6.1.3
cmake -B build -S cpp\vms_server_plugins\<plugin> -G Ninja -DCMAKE_BUILD_TYPE=Release "-DnxSdkDir=$sdk"
cmake --build build
```

`<plugin>` is the plugin directory, e.g. `opencv_object_detection_analytics_plugin/step5`. The CMake
variable for the SDK path is `nxSdkDir`, as in the SDK's own samples; the pre-6.1 name
`metadataSdkDir` still works.

## Building with Clang

GCC (Linux) and MSVC (Windows) are the default compilers. Clang is optional: provision it, then
select it when configuring a **new** build directory. CMake stores the compiler in the build
directory when it configures it for the first time, so to switch compilers, use another build
directory (or delete the old one). No Conan profile is needed: on Linux, the plugins' CMake passes
the selected compiler to Conan, so Conan builds dependencies such as OpenCV with it too; on Windows,
OpenCV comes prebuilt with MSVC (see below).

This applies to the OpenCV plugin tutorial. The OpenVINO plugin always builds with the GCC 13
toolchain from the Nx Conan remote on Linux, and with MSVC on Windows.

### Linux: Clang 18

Install Clang along with everything else:

```bash
cpp/vms_server_plugins/scripts/provision_scripts/provision_ubuntu.sh --clang
```

Select it with `CC` and `CXX` when configuring:

```bash
sdk=$(python3 cpp/vms_server_plugins/scripts/provision_scripts/download_sdk.py 6.1.3)
CC=clang CXX=clang++ cmake -B build-clang -S cpp/vms_server_plugins/<plugin> \
    -DCMAKE_BUILD_TYPE=Release -DnxSdkDir="$sdk"
cmake --build build-clang -- -j
```

Check that CMake prints `The CXX compiler identification is Clang 18.1.3`; with `GNU 13.3.0`, the
build directory already existed with GCC. The plugin uses libstdc++, the C++ library of GCC, like
the Server (see "Clang" below).

In a container, build the image with Clang and pass `CC` and `CXX` to the container:

```bash
docker build -t nx-plugin-build-clang --build-arg PROVISION_ARGS=--clang -f cpp/vms_server_plugins/scripts/provision_scripts/ubuntu.Dockerfile cpp/vms_server_plugins/scripts/provision_scripts
docker run --rm -it -v "$PWD:/src" -v "$sdk:/sdk" -w /src -e CC=clang -e CXX=clang++ nx-plugin-build-clang
# In the container:
cmake -B build-clang -S cpp/vms_server_plugins/<plugin> -DCMAKE_BUILD_TYPE=Release -DnxSdkDir=/sdk
cmake --build build-clang -- -j
```

### Windows: clang-cl

Install the Clang components of Visual Studio 2022 Build Tools ("C++ Clang tools for Windows":
clang-cl and the ClangCL toolset) along with everything else, as Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\provision_scripts\provision_windows.ps1 -WithClang
```

Then, from "Developer PowerShell for VS 2022", select the ClangCL toolset with `-T`, keeping
`version=14.38`: clang-cl then compiles with the headers and libraries of MSVC 14.38, matching the
Server's C++ runtime (see "Windows: Visual Studio 2022 with the MSVC 14.38 toolset" below):

```powershell
cd <repository>
$sdk = python cpp\vms_server_plugins\scripts\provision_scripts\download_sdk.py 6.1.3
cmake -B build-clang -S cpp\vms_server_plugins\<plugin> -G "Visual Studio 17 2022" -A x64 -T ClangCL,version=14.38 -DCMAKE_BUILD_TYPE=Release "-DnxSdkDir=$sdk"
cmake --build build-clang --config Release
```

Check that CMake prints `The CXX compiler identification is Clang 19.1.5 with MSVC-like
command-line` (the version depends on the Visual Studio update). OpenCV still comes prebuilt from
ConanCenter, built with MSVC; clang-cl code links with it, as clang-cl is compatible with MSVC.

## Tests

[tests/](tests) has scripts that check the instructions above in a container (Linux) or on a VM
(Windows): provisioning, building the plugins with each compiler, and running the tutorial plugins
on test images; `windows.Dockerfile` isn't tested. Run them after changing the scripts, the
plugins or the instructions; see [tests/readme.md](tests/readme.md).

## Build environment requirements

What the scripts set up, and why.

### Conan 1.66.0

The plugins use Conan 1 via [cmake-conan](https://github.com/conan-io/cmake-conan) 0.18; Conan 2 is
not supported (the CMake stops with an error). 1.66.0 is the last Conan 1 release. Conan revisions
must be enabled for the Nx Conan remote, as in Nx CI.

### Windows: Visual Studio 2022 with the MSVC 14.38 toolset

Build with the MSVC 14.38 toolset (`-T version=14.38`, or `-vcvars_ver=14.38` for the developer
command prompt), not the newest one. The VMS Server ships the 14.38 C++ runtime, and code built with
MSVC 14.40 or later needs a newer one: e.g. its `std::mutex` crashes with the older runtime. So a
plugin built with a newer toolset can crash in the Server. Nx builds use 14.38 too (the SDK's
`call_vcvars64.bat` rejects 14.39 and later). Alternatively, link the C++ runtime statically
(`/MT`), as the SDK documentation describes.

Visual Studio 2022 is needed because Conan 1.66 doesn't know newer Visual Studio versions, and the
Nx CI Conan profiles and the prebuilt packages on the Nx remote target it. The Visual Studio website
now offers Visual Studio 2026; `install_vs2022_build_tools.ps1` uses Microsoft's permanent VS 2022
download link instead.

### Linux: Ubuntu 24.04, GCC 13, CMake 3.28

The scripts set up Ubuntu 24.04 with its GCC 13 and CMake 3.28, the versions the plugins require.
A plugin needs at least the glibc version of the OS it was built on, so a plugin built on Ubuntu
24.04 runs in a Server on Ubuntu 24.04 (or a newer OS). The 6.1 Server brings its own libstdc++
(from GCC 13), so libstdc++ is not a limit.

### Clang

GCC is the default compiler on Linux, and MSVC on Windows. Clang is optional and works for these
plugins; see [Building with Clang](#building-with-clang) for how to install and use it. Nx
builds the VMS itself with Clang on Linux, using GCC's libstdc++, and the plugins built with Clang
use libstdc++ as well. The Server Plugin SDK also suggests linking libc++ statically when building
with Clang (the OpenCV tutorial's CMake option `useLibcxx`), but that needs a static libc++ built
with `-fPIC`, which Ubuntu's libc++ packages are not. Conan 1.66 knows Clang only up to version 17,
so `setup_conan.sh` adds Ubuntu 24.04's Clang 18 to its settings.

### Dependencies (OpenCV)

The OpenCV plugin tutorial uses OpenCV 4.10.0, the latest version available for Conan 1. On Linux
it builds OpenCV from the Nx Conan remote's recipe with protobuf, which the `dnn` module needs to
load the tutorial's model (a few minutes; it will download the binaries once the Nx remote has
them). On Windows it uses ConanCenter's OpenCV prebuilt for Visual Studio 2019 (compatible with
2022). The CMake option `opencvFromNx` switches between the two; see the tutorial's readme.
