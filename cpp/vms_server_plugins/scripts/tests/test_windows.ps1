## Copyright 2018-present Network Optix, Inc. Licensed under MPL 2.0: www.mozilla.org/MPL/2.0/

<#
.SYNOPSIS
Test the Windows build environment and the OpenCV plugin tutorial, the way scripts\readme.md
describes them.

.DESCRIPTION
- Provisions the machine with the command that scripts\readme.md gives for provision_windows.ps1
  -WithClang, run as written in Command Prompt (skipped with -SkipProvisioning).
- Downloads the SDK with download_sdk.py.
- In the environment of "Developer PowerShell for VS 2022", builds the OpenCV plugin tutorial
  (start, step1-step5) with MSVC 14.38 (-T version=14.38) and with clang-cl
  (-T ClangCL,version=14.38), and the OpenVINO plugin with MSVC 14.38, each compiler with a fresh
  Conan cache.
- Checks that each build used the intended compiler and the MSVC 14.38 toolset (headers and
  libraries; for MSVC, also the linker).
- Runs each tutorial plugin with run_plugin on test images, and checks that it finds the expected
  objects and events, with the same types of them from MSVC and clang-cl.
- Runs the Windows build commands of scripts\readme.md as written, in a new Windows PowerShell.

Run it as Administrator (provisioning needs it), on a machine that may be changed, e.g. a VM:
    powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\tests\test_windows.ps1
Takes about 20 minutes after provisioning. Prints a summary; exits with 1 if a check failed. Logs
and builds are in the work dir.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File cpp\vms_server_plugins\scripts\tests\test_windows.ps1 -SkipProvisioning
#>
param(
    # Work dir; its previous content is deleted. Keep the path short: Conan 1 packages have long
    # paths.
    [string]$WorkDir = (Join-Path $env:SystemDrive "nx_plugin_tests"),
    # SDK version for download_sdk.py.
    [string]$SdkVersion = "6.1.3",
    # Don't run provision_windows.ps1, e.g. when it has already run.
    [switch]$SkipProvisioning
)

$ErrorActionPreference = "Stop"

$openDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..\..")).Path
$scriptsDir = Join-Path $openDir "cpp\vms_server_plugins\scripts"
$provisionDir = Join-Path $scriptsDir "provision_scripts"
$plugins = Join-Path $openDir "cpp\vms_server_plugins"
$tutorial = Join-Path $plugins "opencv_object_detection_analytics_plugin"

$script:failures = 0
$script:summary = @()

function Report([string]$Result, [string]$Description) {
    $script:summary += "{0,-5} {1}" -f $Result, $Description
    Write-Host "${Result}: $Description"
    if ($Result -eq "FAIL") { $script:failures++ }
}

# Runs a native command with its output in a log file; returns whether it succeeded. Windows
# PowerShell 5.1 turns native stderr into errors, so rely on the exit code.
function Invoke-Logged([string]$Log, [string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = "Continue"
    $global:LASTEXITCODE = 1 #< Stays so if $Exe can't be started.
    & $Exe @Arguments 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message }
        else { "$_" }
    } | Add-Content -Path $Log -Encoding UTF8
    return $LASTEXITCODE -eq 0
}

function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
        [Environment]::GetEnvironmentVariable("Path", "User")
}

if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
New-Item -ItemType Directory $WorkDir | Out-Null

if (-not $SkipProvisioning) {
    # Run the provisioning command of scripts\readme.md ("Building with Clang") as written, in
    # Command Prompt from the repository root. Child processes would inherit the execution policy
    # that this script was started with, so remove it: the command must work on its own.
    $command = Get-Content (Join-Path $scriptsDir "readme.md") |
        Where-Object { $_ -match "^powershell .*provision_windows\.ps1 -WithClang$" } |
        Select-Object -First 1
    if (-not $command) {
        Report "FAIL" "No ""provision_windows.ps1 -WithClang"" command in scripts\readme.md"
        exit 1
    }
    Remove-Item Env:\PSExecutionPolicyPreference -ErrorAction SilentlyContinue
    $log = Join-Path $WorkDir "provision.log"
    Write-Host "Provisioning: $command (log: $log)"
    Push-Location $openDir
    $ok = Invoke-Logged $log "cmd" @("/c", $command)
    Pop-Location
    if ($ok) {
        Report "OK" "Provisioning as in scripts\readme.md: $command"
    } else {
        Report "FAIL" "Provisioning as in scripts\readme.md: $command (see $log)"
        exit 1
    }
}

# Like opening "Developer PowerShell for VS 2022" from the Start menu after provisioning.
Update-SessionPath
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -products Microsoft.VisualStudio.Product.BuildTools -version "[17.0,18.0)" `
    -property installationPath | Select-Object -First 1
if (-not $vs) { throw "Visual Studio 2022 Build Tools are not installed." }
Import-Module (Join-Path $vs "Common7\Tools\Microsoft.VisualStudio.DevShell.dll")
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=amd64" |
    Out-Null

Write-Host "Downloading SDK $SdkVersion"
$sdk = & python (Join-Path $provisionDir "download_sdk.py") $SdkVersion -o (Join-Path $WorkDir "sdk")
if ($LASTEXITCODE -ne 0) { throw "download_sdk.py failed." }

function Build([string]$Compiler, [string]$Name, [string]$Source, [string]$SdkVariable,
    [string]$ConanHome = (Join-Path $WorkDir "$Compiler\conan_home"))
{
    $buildDir = Join-Path $WorkDir "$Compiler\$Name"
    $log = "$buildDir.log"
    # As in scripts\readme.md: "Windows" and "Building with Clang".
    $toolset = if ($Compiler -eq "clang") { "ClangCL,version=14.38" } else { "version=14.38" }
    $expectedId = if ($Compiler -eq "clang") { "Clang" } else { "MSVC" }

    # A fresh Conan cache for each compiler, shared by its builds, like on a new provisioned
    # machine: with the configuration that setup_conan.ps1 made, and no packages.
    if (-not (Test-Path $ConanHome)) {
        $conanConfig = New-Item -ItemType Directory (Join-Path $ConanHome ".conan")
        foreach ($item in @("conan.conf", "settings.yml", "profiles")) {
            $itemPath = Join-Path $env:USERPROFILE ".conan\$item"
            if (Test-Path $itemPath) { Copy-Item -Recurse $itemPath $conanConfig }
        }
    }
    $env:CONAN_USER_HOME = $ConanHome
    $ok = (Invoke-Logged $log "cmake" @("-B", $buildDir, "-S", $Source,
            "-G", "Visual Studio 17 2022", "-A", "x64", "-T", $toolset,
            "-DCMAKE_BUILD_TYPE=Release", "-D$SdkVariable=$sdk")) -and
        (Invoke-Logged $log "cmake" @("--build", $buildDir, "--config", "Release"))
    Remove-Item Env:\CONAN_USER_HOME
    if (-not $ok) {
        Report "FAIL" "$Compiler ${Name}: build (see $log)"
        return $false
    }

    $match = Select-String -Path (Join-Path $buildDir "CMakeFiles\*\CMakeCXXCompiler.cmake") `
        -Pattern '^set\(CMAKE_CXX_COMPILER_ID "(.*)"\)$' | Select-Object -First 1
    $compilerId = if ($match) { $match.Matches[0].Groups[1].Value } else { "an unknown compiler" }
    if ($compilerId -ne $expectedId) {
        Report "FAIL" "$Compiler ${Name}: built with $compilerId instead of $expectedId"
        return $false
    }
    # With -T version=14.38, the projects use the headers and libraries of MSVC 14.38, whichever
    # compiler.
    foreach ($project in Get-ChildItem (Join-Path $buildDir "*.vcxproj")) {
        if (-not (Select-String -Path $project.FullName -Quiet `
            -Pattern "Microsoft\.VCToolsVersion\.14\.38\."))
        {
            Report "FAIL" "$Compiler ${Name}: $($project.Name) doesn't use the MSVC 14.38 toolset"
            return $false
        }
    }
    if ($Compiler -eq "msvc") {
        # The linker of the toolset writes its version into the DLL.
        foreach ($dll in Get-ChildItem (Join-Path $buildDir "Release\*.dll")) {
            $headers = & dumpbin /headers $dll.FullName
            if (-not ($headers -match "^\s*14\.38 linker version")) {
                Report "FAIL" "$Compiler ${Name}: $($dll.Name) not linked by MSVC 14.38"
                return $false
            }
        }
    }
    Report "OK" "$Compiler ${Name}: build"
    return $true
}

function Run([string]$Compiler, [string]$Name, [string]$Library, [string[]]$Expected) {
    $buildDir = Join-Path $WorkDir "$Compiler\$Name"
    $log = "$buildDir.run.log"
    if (Invoke-Logged $log $runPlugin (@((Join-Path $buildDir "Release\$Library"), $buildDir,
        $frames) + $Expected))
    {
        $types = @(Select-String -Path $log -Pattern "^(object|event) ").Count
        Report "OK" "$Compiler ${Name}: run ($types types)"
    } else {
        Report "FAIL" "$Compiler ${Name}: run (see $log)"
    }
}

$runPluginDir = Join-Path $WorkDir "run_plugin"
$runPlugin = Join-Path $runPluginDir "Release\run_plugin.exe"
$frames = Join-Path $WorkDir "frames.bin"
$log = Join-Path $WorkDir "run_plugin.log"
if ((Invoke-Logged $log "cmake" @("-B", $runPluginDir, "-S", (Join-Path $PSScriptRoot "run_plugin"),
        "-G", "Visual Studio 17 2022", "-A", "x64", "-T", "version=14.38", "-DnxSdkDir=$sdk")) -and
    (Invoke-Logged $log "cmake" @("--build", $runPluginDir, "--config", "Release")) -and
    (Invoke-Logged $log "python" @((Join-Path $PSScriptRoot "make_frames.py"), $frames)))
{
    Report "OK" "run_plugin and test frames"
} else {
    Report "FAIL" "run_plugin and test frames (see $log)"
}

$objects = @("nx.base.Dog", "nx.base.Person")
$events = @("sample.opencv_object_detection.detection",
    "sample.opencv_object_detection.prolongedDetection")
$plugin = "opencv_object_detection_analytics_plugin.dll"

foreach ($compiler in @("msvc", "clang")) {
    New-Item -ItemType Directory -Force (Join-Path $WorkDir $compiler) | Out-Null
    if (Build $compiler "start" (Join-Path $tutorial "start") "nxSdkDir") {
        Run $compiler "start" "sample_analytics_plugin.dll" @("nx.sample.helloWorld")
    }
    foreach ($step in @("step1", "step2", "step3", "step4", "step5")) {
        $expected = switch ($step) {
            "step1" { @("nx.sample.helloWorld") }
            "step2" { @("nx.base.Person") }
            { $_ -in "step3", "step4" } { $objects }
            "step5" { $objects + $events }
        }
        if (Build $compiler $step (Join-Path $tutorial $step) "nxSdkDir") {
            Run $compiler $step $plugin $expected
        }
    }
}

# The Windows build commands of scripts\readme.md (MSVC and clang-cl), as written: a new Windows
# PowerShell parses them as it would for the user. Only the placeholders and the SDK and build
# directories are replaced, to keep the repository clean.
$readmeDir = Join-Path $WorkDir "readme"
New-Item -ItemType Directory -Force $readmeDir | Out-Null
$inBlock = $false
$lines = @()
$blockIndex = 0
foreach ($line in Get-Content (Join-Path $scriptsDir "readme.md")) {
    if (-not $inBlock) {
        $inBlock = $line -eq '```powershell'
        $lines = @()
        continue
    }
    if ($line -ne '```') { $lines += $line; continue }
    $inBlock = $false
    $text = $lines -join "`r`n"
    if ($text -notmatch "cmake -B" -or $text -match "docker") { continue }

    $blockIndex++
    $name = if ($text -match "ClangCL") { "clang-cl" } else { "MSVC" }
    $text = $text.Replace("<repository>", "'$openDir'").
        Replace("<plugin>", "opencv_object_detection_analytics_plugin\step1")
    $text = $text -replace 'download_sdk\.py (\S+)', ('download_sdk.py $1 -o ' + "$readmeDir\sdk")
    $text = $text -replace '(-B|--build) (build[\w-]*)', ('$1 ' + $readmeDir + '\$2')
    $blockScript = Join-Path $readmeDir "block$blockIndex.ps1"
    Set-Content -Path $blockScript -Value ($text + "`r`nexit `$LASTEXITCODE") -Encoding UTF8
    $log = Join-Path $readmeDir "block$blockIndex.log"
    if (Invoke-Logged $log "powershell" @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $blockScript)) {
        Report "OK" "Build commands of scripts\readme.md, as written ($name)"
    } else {
        Report "FAIL" "Build commands of scripts\readme.md, as written ($name; see $log, $blockScript)"
    }
}
if ($blockIndex -eq 0) { Report "FAIL" "No Windows build commands found in scripts\readme.md" }

# The OpenVINO plugin gets OpenCV 4.10.0 from the Nx remote, and the tutorial from ConanCenter;
# the Conan 1 cache keeps one of them only, so the OpenVINO plugin needs its own Conan cache.
Build "msvc" "openvino" (Join-Path $plugins "openvino_object_detection_analytics_plugin") `
    "nxSdkDir" (Join-Path $WorkDir "msvc\conan_home_openvino") | Out-Null

# The plugin must find the same types of objects and events whatever compiler built it (types, not
# counts, as in test_linux.sh).
foreach ($name in @("start", "step1", "step2", "step3", "step4", "step5")) {
    $logs = @("msvc", "clang") | ForEach-Object { Join-Path $WorkDir "$_\$name.run.log" }
    if ((Test-Path $logs[0]) -and (Test-Path $logs[1])) {
        $results = $logs | ForEach-Object {
            $types = Select-String -Path $_ -Pattern "^((object|event) [^:]*):" |
                ForEach-Object { $_.Matches[0].Groups[1].Value }
            $types -join "`n"
        }
        if ($results[0] -eq $results[1]) {
            Report "OK" "${name}: same object and event types from MSVC and clang-cl"
        } else {
            Report "FAIL" ("${name}: different object or event types from MSVC and clang-cl " +
                "(see $($logs -join ', '))")
        }
    }
}

Write-Host ""
Write-Host "Summary:"
$script:summary | ForEach-Object { Write-Host $_ }
if ($script:failures) {
    Write-Host "$($script:failures) check(s) failed. Logs are in $WorkDir."
    exit 1
}
Write-Host "All checks passed."
