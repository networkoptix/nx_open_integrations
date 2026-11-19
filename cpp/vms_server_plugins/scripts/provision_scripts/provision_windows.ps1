## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

<#
.SYNOPSIS
Provision a Windows machine (VM or container) for building the plugins in cpp\vms_server_plugins\,
e.g. the OpenCV plugin tutorial.

.DESCRIPTION
Installs what is missing of: Python 3, Git (only where winget is available; it is needed to clone
the repository, not to build), Visual Studio 2022 Build Tools with the MSVC 14.38 toolset
(install_vs2022_build_tools.ps1), and Conan 1.66.0 (setup_conan.ps1). Run it as Administrator,
with -ExecutionPolicy Bypass, as Windows doesn't run PowerShell scripts by default (see .EXAMPLE).
Safe to re-run.

Then build from "Developer PowerShell for VS 2022" (Start menu) with `cmake -T version=14.38`, or
with Ninja after `Enter-VsDevShell ... -DevCmdArguments "-arch=amd64 -vcvars_ver=14.38"`.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\provision_scripts\provision_windows.ps1
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\provision_scripts\provision_windows.ps1 -WithClang
#>
#Requires -RunAsAdministrator
param(
    # Also install Clang/LLVM for MSVC (clang-cl).
    [switch]$WithClang,
    # No installer UI at all, e.g. in a container.
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" #< Invoke-WebRequest is very slow with the progress bar.
# Windows PowerShell 5.1 may not enable TLS 1.2 by default, which the download sites require.
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$pythonUrl = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe"

function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
        [Environment]::GetEnvironmentVariable("Path", "User")
}

function Test-Python {
    # The "python" of the Microsoft Store alias exists but doesn't run Python.
    $python = Get-Command python -ErrorAction SilentlyContinue
    if (-not $python -or $python.Source -like "*\WindowsApps\*") { return $false }
    & python --version *> $null
    return $LASTEXITCODE -eq 0
}

if (Test-Python) {
    Write-Host "Python: $(& python --version)"
} else {
    $installer = Join-Path ([System.IO.Path]::GetTempPath()) "python-installer.exe"
    Write-Host "Downloading $pythonUrl"
    Invoke-WebRequest -Uri $pythonUrl -OutFile $installer -UseBasicParsing
    $process = Start-Process -FilePath $installer -Wait -PassThru -ArgumentList @(
        "/quiet", "InstallAllUsers=1", "PrependPath=1", "Include_test=0", "Include_launcher=1")
    Remove-Item $installer -ErrorAction SilentlyContinue
    if ($process.ExitCode -ne 0) { throw "Python installer failed with exit code $($process.ExitCode)." }
    Update-SessionPath
    if (-not (Test-Python)) { throw "Python was installed but is not on PATH; open a new terminal and re-run." }
    Write-Host "Installed $(& python --version)"
}

if (Get-Command git -ErrorAction SilentlyContinue) {
    Write-Host "Git: $(& git --version)"
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    & winget install --id Git.Git --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget failed to install Git ($LASTEXITCODE)." }
    Update-SessionPath
} else {
    Write-Host "Git is not installed and winget is not available; install Git to clone the repository."
}

& (Join-Path $PSScriptRoot "install_vs2022_build_tools.ps1") -WithClang:$WithClang -Quiet:$Quiet
& (Join-Path $PSScriptRoot "setup_conan.ps1")
