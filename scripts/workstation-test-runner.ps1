[CmdletBinding()]
param(
    [ValidateSet("Preflight", "BuildAll", "BuildWindows", "BuildAndroid", "TestWindows", "TestAndroid", "TestAll")]
    [string]$Mode = "BuildAll",
    [string]$ReportDirectory = (Join-Path $env:TEMP "JARVIS-workstation-evidence"),
    [switch]$SkipBrowserSmoke
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = (Get-Location).Path
$preflightScript = Join-Path $repoRoot "scripts\workstation-preflight.ps1"
if (-not (Test-Path $preflightScript)) { throw "Run this script from the JARVIS repository root." }
New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$results = [System.Collections.Generic.List[object]]::new()
function Add-Result([string]$Name, [string]$Command, [int]$ExitCode, [double]$Seconds, [string]$Status, [string]$Note, [string]$LogPath = "") {
    $results.Add([pscustomobject]@{ name = $Name; command = $Command; exitCode = $ExitCode; durationSeconds = [math]::Round($Seconds, 2); status = $Status; note = $Note; logPath = $LogPath })
}
function Invoke-Checked([string]$Name, [string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory) {
    $display = "$Exe $($Arguments -join ' ')"
    $safeName = $Name -replace '[^A-Za-z0-9-]', '-'
    $logPath = Join-Path $ReportDirectory "$stamp-$safeName.log"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Write-Host ""
    Write-Host (">>> " + $display) -ForegroundColor Cyan
    Push-Location $WorkingDirectory
    try {
        & $Exe @Arguments 2>&1 | Tee-Object -FilePath $logPath
        $code = $LASTEXITCODE
    }
    catch { Write-Warning $_; $code = 1 }
    finally { Pop-Location; $timer.Stop() }
    $status = if ($code -eq 0) { "PASS" } else { "FAIL" }
    Add-Result $Name $display $code $timer.Elapsed.TotalSeconds $status "Full command output saved locally; review/redact before sharing." $logPath
    Write-Host ("{0}: {1} (exit {2})" -f $Name,$status,$code)
}
& $preflightScript -ReportDirectory $ReportDirectory
if ($Mode -eq "Preflight") { return }

$windowsBuild = $Mode -in @("BuildAll","BuildWindows")
$androidBuild = $Mode -in @("BuildAll","BuildAndroid")
$windowsTests = $Mode -in @("TestWindows","TestAll")
$androidTests = $Mode -in @("TestAndroid","TestAll")

if ($windowsBuild -or $windowsTests) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    $nodeModules = Test-Path (Join-Path $repoRoot "node_modules")
    if (-not $npm) {
        Add-Result "Windows Node tasks" "npm" 127 0 "BLOCKED" "npm was not found on PATH."
    } elseif (-not $nodeModules) {
        Add-Result "Windows Node tasks" "npm scripts" 2 0 "BLOCKED" "node_modules is absent. Review the lockfile and local changes, then run npm ci explicitly."
    } elseif ($windowsBuild) {
        Invoke-Checked "Windows TypeScript build" "npm" @("run","build") $repoRoot
    } else {
        Invoke-Checked "Windows automated tests" "npm" @("test") $repoRoot
        if (-not $SkipBrowserSmoke) { Invoke-Checked "Windows browser smoke" "npm" @("run","test:browser") $repoRoot }
    }
}

if ($androidBuild -or $androidTests) {
    $gradle = Get-Command gradle -ErrorAction SilentlyContinue
    if (-not $gradle) {
        Add-Result "Android Gradle task" "gradle -p android-app" 127 0 "BLOCKED" "System Gradle was not found. The repository currently has no Gradle Wrapper."
    } elseif ($androidBuild) {
        Invoke-Checked "Android debug APK build" "gradle" @("-p","android-app","assembleDebug") $repoRoot
    } else {
        Invoke-Checked "Android unit tests" "gradle" @("-p","android-app","testDebugUnitTest") $repoRoot
    }
}

$authorizedDevices = $null
if (Get-Command adb -ErrorAction SilentlyContinue) {
    $deviceLines = & adb devices 2>$null
    if ($LASTEXITCODE -eq 0) { $authorizedDevices = @($deviceLines | Where-Object { $_ -match "^\S+\s+device$" }).Count }
}
$git = Get-Command git -ErrorAction SilentlyContinue
$branch = "unknown"
if ($git) {
    $branchOutput = & git branch --show-current 2>$null
    if ($LASTEXITCODE -eq 0) { $branch = ($branchOutput | Out-String).Trim() }
}
$summary = [ordered]@{
    generatedAt = (Get-Date).ToString("o"); machine = $env:COMPUTERNAME; repository = $repoRoot
    branch = $branch; mode = $Mode; authorizedAndroidDeviceCount = $authorizedDevices
    deviceAcceptance = if ($authorizedDevices -ge 2) { "READY_FOR_OWNER_DEVICE_DRILLS" } else { "PENDING_TWO_AUTHORIZED_PHONES" }
    results = @($results)
    note = "Build and test modes are separate. No APK installation, app launch, phone setting change, enrollment, revocation, data reset, credential access or remote command execution was performed. Review and redact logs before sharing."
}
$jsonPath = Join-Path $ReportDirectory "test-run-$stamp.json"
$mdPath = Join-Path $ReportDirectory "test-run-$stamp.md"
$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $jsonPath
$lines = @("# JARVIS workstation run report", "", "- Generated: $($summary.generatedAt)", "- Machine: $($summary.machine)", "- Branch: $($summary.branch)", "- Mode: $Mode", "- Authorized Android devices: $(if ($null -eq $authorizedDevices) { 'ADB unavailable' } else { $authorizedDevices })", "- Physical-device acceptance: $($summary.deviceAcceptance)", "", "| Check | Status | Exit | Duration (s) |", "|---|---:|---:|---:|")
foreach ($r in $results) {
    $lines += "| $($r.name) | $($r.status) | $($r.exitCode) | $($r.durationSeconds) |"
    if ($r.logPath) { $lines += "Log: $($r.logPath)" }
    $lines += "Note: $($r.note)"
}
$lines += @("", "## Evidence boundary", "A passing build proves compilation/package generation only. A passing automated test proves only that test command on this checkout. Neither proves microphone behavior, Android hardware behavior, cross-device enrollment/sync, or owner acceptance.", "", "No APK installation, app launch, phone setting change, enrollment, revocation, data reset, credential access or remote command execution was performed.")
$lines | Set-Content -Encoding UTF8 $mdPath
Write-Host ""
Write-Host "Report files:"
Write-Host $mdPath
Write-Host $jsonPath
$failed = @($results | Where-Object status -eq "FAIL").Count
$blocked = @($results | Where-Object status -eq "BLOCKED").Count
$passed = @($results | Where-Object status -eq "PASS").Count
Write-Host ("Summary: {0} passed, {1} failed, {2} blocked." -f $passed,$failed,$blocked)
if ($failed -gt 0) { exit 1 }
