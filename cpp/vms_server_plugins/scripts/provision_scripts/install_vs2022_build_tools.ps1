## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

<#
.SYNOPSIS
Install Visual Studio 2022 Build Tools with the C++ components needed to build the plugins.

.DESCRIPTION
The plugins need Visual Studio 2022 (MSVC v143): the Nx CI Conan profiles and the prebuilt packages
on the nx remote target `compiler=Visual Studio`, `compiler.version=17`, and Conan 1.66 does not
know newer Visual Studio versions. visualstudio.microsoft.com now offers Visual Studio 2026, but
VS 2022 stays available from Microsoft's permanent link https://aka.ms/vs/17/release/.

Installs the build tools only (no IDE): the "Desktop development with C++" workload with its
recommended components (the latest MSVC v143, Windows SDK, CMake, Ninja), the Windows 11 SDK 22621
used by Nx CI, and the MSVC 14.38 toolset; optionally the Clang toolset. Modifies an existing
VS 2022 Build Tools installation if there is one, so it is safe to re-run. The installer asks for
administrator rights.

Plugins must be built with MSVC 14.38 (`cmake -T version=14.38`): the VMS Server ships the 14.38
C++ runtime, and code built with MSVC 14.40 or later needs a newer runtime (e.g. std::mutex), so
it can crash in the Server. Nx builds use 14.38 as well (see call_vcvars64.bat in the SDK).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\provision_scripts\install_vs2022_build_tools.ps1
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\provision_scripts\install_vs2022_build_tools.ps1 -WithClang
#>
param(
    # Also install Clang/LLVM for MSVC (clang-cl).
    [switch]$WithClang,
    # No installer UI at all (default shows progress without asking anything).
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
# Windows PowerShell 5.1 may not enable TLS 1.2 by default, which the download sites require.
[Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$bootstrapperUrl = "https://aka.ms/vs/17/release/vs_BuildTools.exe"
$components = @(
    "Microsoft.VisualStudio.Workload.VCTools",
    "Microsoft.VisualStudio.Component.Windows11SDK.22621",
    "Microsoft.VisualStudio.Component.VC.14.38.17.8.x86.x64"
)
if ($WithClang) {
    $components += "Microsoft.VisualStudio.Component.VC.Llvm.Clang"
    $components += "Microsoft.VisualStudio.Component.VC.Llvm.ClangToolset"
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$existing = $null
if (Test-Path $vswhere) {
    $existing = & $vswhere -products Microsoft.VisualStudio.Product.BuildTools -version "[17.0,18.0)" `
        -property installationPath | Select-Object -First 1
}

$bootstrapper = Join-Path ([System.IO.Path]::GetTempPath()) "vs_BuildTools_2022.exe"
Write-Host "Downloading $bootstrapperUrl"
Invoke-WebRequest -Uri $bootstrapperUrl -OutFile $bootstrapper -UseBasicParsing

$arguments = @()
if ($existing) {
    Write-Host "Modifying the existing installation at $existing"
    $arguments += @("modify", "--installPath", "`"$existing`"")
}
foreach ($component in $components) { $arguments += @("--add", $component) }
$arguments += "--includeRecommended"
if ($Quiet) { $arguments += "--quiet" } else { $arguments += "--passive" }
$arguments += @("--norestart", "--wait")

Write-Host "Installing: $($components -join ', ')"
$process = Start-Process -FilePath $bootstrapper -ArgumentList $arguments -Wait -PassThru
Remove-Item $bootstrapper -ErrorAction SilentlyContinue

# 3010: success, reboot required; 1641: success, reboot initiated.
switch ($process.ExitCode) {
    0 { Write-Host "Done." }
    3010 { Write-Host "Done. Restart Windows to finish the installation." }
    1641 { Write-Host "Done. Windows is restarting to finish the installation." }
    default { throw "Visual Studio installer failed with exit code $($process.ExitCode)." }
}
Write-Host "Build plugins from ""Developer PowerShell for VS 2022"" (Start menu): it puts cmake and ninja on PATH."
