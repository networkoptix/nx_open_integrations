## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

<#
.SYNOPSIS
Set up Conan for building nx_open_integrations plugins (cpp\vms_server_plugins\*) on Windows.

.DESCRIPTION
Installs Conan 1.66.0 (Conan 2 is not supported) with pipx, enables Conan revisions, which the nx
remote requires (same setting as nx_open's CI conan_config\conan.conf), and creates Conan's
default profile from the installed Visual Studio, so that it doesn't have to be set up by hand. The
plugins' CMake brings everything else (remotes, the Nx CI profiles where used, packages). Needs
Python, and Visual Studio 2022 for the default profile (provision_windows.ps1 installs them). Safe
to re-run.
#>
param(
    # Do not add the pipx bin directory to the persistent user PATH.
    [switch]$NoPathUpdate
)

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 turns native stderr (e.g. pip notices) into errors; rely on exit codes.
function Invoke-Native([string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = "Continue"
    # Print stderr lines as text, not as error records.
    & $Exe @Arguments 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message }
        else { "$_" }
    }
    if ($LASTEXITCODE -ne 0) { throw "Command failed ($LASTEXITCODE): $Exe $($Arguments -join ' ')" }
}

Invoke-Native python @("-m", "pip", "install", "--user", "--quiet", "--upgrade", "pipx")
Invoke-Native python @("-m", "pipx", "install", "--force", "conan==1.66.0")
if (-not $NoPathUpdate) { Invoke-Native python @("-m", "pipx", "ensurepath") | Out-Null }

$binDir = if ($env:PIPX_BIN_DIR) { $env:PIPX_BIN_DIR } else { Join-Path $env:USERPROFILE ".local\bin" }
$conan = Join-Path $binDir "conan.exe"

Invoke-Native $conan @("config", "set", "general.revisions_enabled=1")
Invoke-Native $conan @("profile", "new", "default", "--detect", "--force") | Out-Null
Invoke-Native $conan @("--version")
if ($NoPathUpdate) {
    Write-Host "Done. Add $binDir to PATH to use ``conan``."
} else {
    Write-Host "Done. If ``conan`` is not found, open a new terminal (pipx added $binDir to PATH)."
}
