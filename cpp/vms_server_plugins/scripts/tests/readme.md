# Tests of the build environment and the OpenCV plugin tutorial

These scripts check that what [scripts/readme.md](../readme.md) describes works from scratch:
provisioning a machine, downloading the SDK, building the plugins with each supported compiler, and
running the tutorial plugins. Run them after changing the scripts, the plugins, or the build
instructions.

| Script | Where it runs | Takes |
|--------|---------------|-------|
| `test_linux.sh` | Any Linux with Docker and Python 3 (also WSL): everything runs in an Ubuntu 24.04 container. | About 20 min |
| `test_windows.ps1` | A Windows 10 or 11 machine that may be changed, e.g. a VM: it provisions the machine itself. | About 20 min, plus provisioning |

```bash
cpp/vms_server_plugins/scripts/tests/test_linux.sh
```

As Administrator:

```powershell
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\tests\test_windows.ps1
```

Both print one line per check and a summary, and exit with 1 if a check failed. Logs and builds
are in the work dir: `/tmp/nx_plugin_tests` (option `-w`) or `C:\nx_plugin_tests` (option
`-WorkDir`); its previous content is deleted. `test_windows.ps1 -SkipProvisioning` skips the
provisioning, e.g. when running the tests again.

## What they check

| Check | Linux | Windows |
|-------|-------|---------|
| Provisioning, as in the readme | `ubuntu.Dockerfile` with `provision_ubuntu.sh --clang` and `setup_conan.sh` | The `provision_windows.ps1 -WithClang` command of the readme, run as written in Command Prompt |
| Downloading the SDK | `download_sdk.py` | `download_sdk.py` |
| Building `start`, `step1`-`step5` with the default compiler, as in the readme | GCC 13 | MSVC 14.38 (`-T version=14.38`) |
| ... and with Clang, as in "Building with Clang" | Clang 18 (`CC=clang CXX=clang++`) | clang-cl (`-T ClangCL,version=14.38`) |
| Building the OpenVINO plugin | GCC 13 toolchain from the Nx remote | MSVC 14.38 |
| The build commands of the readme, as written | — | The MSVC and clang-cl blocks, in a new Windows PowerShell (step1) |
| The build used the selected compiler | `CMAKE_CXX_COMPILER_ID` | `CMAKE_CXX_COMPILER_ID`; the projects use the MSVC 14.38 toolset; MSVC builds linked by 14.38 (`dumpbin /headers`) |
| The plugins load and work: `run_plugin` | ✓ | ✓ |
| The same types of objects and events from both compilers | ✓ | ✓ |

Each compiler starts with an empty Conan cache (with the configuration of the provisioning), like a
new machine, so the tests also catch packages that have disappeared from the Conan remotes.

`run_plugin` (in [run_plugin/](run_plugin)) loads a plugin library the way the Server does, calls
it as the Server would for one camera, and sends it 40 video frames: 20 of a dog and 20 of a
person (OpenCV's own test images, which [make_frames.py](make_frames.py) downloads). It fails if
the plugin reports an error, or if an expected object or event type is missing:

| Plugin | Expected |
|--------|----------|
| `start`, `step1` | `nx.sample.helloWorld` objects (the SDK sample's) |
| `step2` | `nx.base.Person` objects (the sample's object, renamed) |
| `step3`, `step4` | `nx.base.Dog` and `nx.base.Person` objects |
| `step5` | as `step4`, and the `detection` and `prolongedDetection` events |

The OpenVINO plugin is only built: running it needs the OpenVINO runtime and its model.

## What they don't check

- The plugins in a real Server: install the Server, copy the plugin as the tutorial's readme says,
  and check in the Desktop Client that the objects appear on a camera (e.g. a `testcamera` playing
  a video).
- `windows.Dockerfile`.
- The Developer KB articles of the tutorial.
