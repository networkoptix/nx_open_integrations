# escape=`

## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

# Windows container for building the plugins in cpp/vms_server_plugins/ for the 6.1 Server.
#
# Needs Docker on Windows in Windows containers mode; the image takes about 10 GB. From the
# repository root, build the image, then build a plugin in the container with the repository
# mounted, as cpp/vms_server_plugins/scripts/readme.md shows:
#
#     docker build -t nx-plugin-build-windows -f cpp\vms_server_plugins\scripts\provision_scripts\windows.Dockerfile cpp\vms_server_plugins\scripts\provision_scripts
#     docker run --rm -it -v "${PWD}:C:\src" -w C:\src nx-plugin-build-windows
#
# The container starts a PowerShell with the MSVC 14.38 environment, so plugins can be built with
# the Ninja generator (or with `-G "Visual Studio 17 2022" -A x64 -T version=14.38`). The SDK can be
# downloaded in the container with `python C:\nx_scripts\download_sdk.py 6.1.3`.

FROM mcr.microsoft.com/windows/servercore:ltsc2022

SHELL ["powershell", "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "$ErrorActionPreference = 'Stop';"]

COPY provision_windows.ps1 install_vs2022_build_tools.ps1 setup_conan.ps1 download_sdk.py C:\nx_scripts\
RUN C:\nx_scripts\provision_windows.ps1 -Quiet; `
    [Environment]::SetEnvironmentVariable('Path', $env:Path + ';' + $env:USERPROFILE + '\.local\bin', 'Machine')

# Starts PowerShell in the MSVC 14.38 environment, passing it the arguments of `docker run`, if any.
# A script, because cmd would drop the quotes of a path with spaces given in ENTRYPOINT.
RUN $q = [char]34; `
    Set-Content -Path C:\nx_scripts\dev_shell.cmd -Encoding Ascii -Value ( `
    '@call ' + $q + 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat' + $q + `
    ' -arch=amd64 -vcvars_ver=14.38 && powershell -NoLogo -ExecutionPolicy Bypass %*')

ENTRYPOINT ["cmd", "/C", "C:\\nx_scripts\\dev_shell.cmd"]
