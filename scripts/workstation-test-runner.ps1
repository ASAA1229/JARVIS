[CmdletBinding()]
param(
    [ValidateSet("All", "Preflight", "Windows", "Android")]
    [string]$Mode = "All",
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
function Add-Result([string]$Name, [string]$Command, [int]$ExitCode, [double]$Seconds, [string]$Status, [string]$Note) {
    $results.Add([pscustomobject]@{ name = $Name; command = $Command; exitCode = $ExitCode; durationSeconds = [math]::Round($Seconds, 2); status = $Status; note = $Note })
}
function Invoke-Checked([string]$Name, [string]$Exe, [string[]]$Arguments, [string]$WorkingDirectory) {
    $display = "$Exe $($Arguments -join ' ')"
    $timer = [Diagnostics.Stopwatch]::StartNew()
    Write-Host ""
    Write-Host (">>> " + $display) -ForegroundColor Cyan
    Push-Location $WorkingDirectory
    try { & $Exe @Arguments; $code = $LASTEXITCODE }
    catch { Write-Warning $_; $code = 1 }
    finally { Pop-Location; $timer.Stop() }
    $status = if ($code -eq 0) { "PASS" } else { "FAIL" }
    Add-Result $Name $display $code $timer.Elapsed.TotalSeconds $status "Executed locally; see exit code."
    Write-Host ("{0}: {1} (exit {2})" -f $Name,$status,$code)
}
& $preflightScript -ReportDirectory $ReportDirectory
if ($Mode -eq "Preflight") { return }
$npm = Get-Command npm -ErrorAction SilentlyContinue
$nodeModules = Test-Path (Join-Path $repoRoot "node_modules")
if ($Mode -in @("All","Windows")) {
    if (-not $npm) {
        Add-Result "Node checks" "npm" 127 0 "BLOCKED" "npm was not found on PATH."
    } elseif (-not $nodeModules) {
        Add-Result "Node checks" "npm test / npm run build" 2 0 "BLOCKED" "node_modules is absent. Install dependencies explicitly with npm ci, then rerun."
    } else {
        Invoke-Checked "Node automated tests" "npm" @("test") $repoRoot
        Invoke-Checked "TypeScript build" "npm" @("run","build") $repoRoot
        if (-not $SkipBrowserSmoke) { Invoke-Checked "Browser smoke" "npm" @("run","test:browser") $repoRoot }
    }
}
if ($Mode -in @("All","Android")) {
    $gradle = Get-Command gradle -ErrorAction SilentlyContinue
    if (-not $gradle) {
        Add-Result "Android Gradle tests/build" "gradle -p android-app testDebugUnitTest assembleDebug" 127 0 "BLOCKED" "System Gradle was not found. The repository currently has no Gradle Wrapper."
    } else {
        Invoke-Checked "Android unit tests" "gradle" @("-p","android-app","testDebugUnitTest") $repoRoot
        Invoke-Checked "Android debug APK build" "gradle" @("-p","android-app","assembleDebug") $repoRoot
    }
}
$authorizedDevices = $null
if (Get-Command adb -ErrorAction SilentlyContinue) {
    $deviceLines = & adb devices 2>$null
    if ($LASTEXITCODE -eq 0) { $authorizedDevices = @($deviceLines | Where-Object { $_ -match "^\S+\s+device$" }).Count }
}
$summary = [ordered]@{
    generatedAt = (Get-Date).ToString("o"); machine = $env:COMPUTERNAME; repository = $repoRoot
    branch = ((& git branch --show-current 2>$null) | Out-String).Trim()
    mode = $Mode; authorizedAndroidDeviceCount = $authorizedDevices
    deviceAcceptance = if ($authorizedDevices -ge 2) { "READY_FOR_OWNER_DEVICE_DRILLS" } else { "PENDING_TWO_AUTHORIZED_PHONES" }
    results = @($results)
    note = "No APK installation, app launch, phone setting change, enrollment, revocation, data reset, credential access or remote command execution was performed."
}
$jsonPath = Join-Path $ReportDirectory "test-run-$stamp.json"
$mdPath = Join-Path $ReportDirectory "test-run-$stamp.md"
$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $jsonPath
$lines = @("# JARVIS workstation test report", "", "- Generated: $($summary.generatedAt)", "- Machine: $($summary.machine)", "- Branch: $($summary.branch)", "- Mode: $Mode", "- Authorized Android devices: $(if ($null -eq $authorizedDevices) { 'ADB unavailable' } else { $authorizedDevices })", "- Physical-device acceptance: $($summary.deviceAcceptance)", "", "| Check | Status | Exit | Duration (s) |", "|---|---:|---:|---:|")
foreach ($r in $results) { $lines += "| $($r.name) | $($r.status) | $($r.exitCode) | $($r.durationSeconds) |"; $lines += ""; $lines += "Note: $($r.note)" }
$lines += @("", "## Evidence boundary", "A passing build/test command proves only that command on this machine and this checkout. It does not prove microphone behavior, Android hardware behavior, cross-device enrollment/sync, or owner acceptance.", "", "No APK installation, app launch, phone setting change, enrollment, revocation, data reset, credential access or remote command execution was performed.")
$lines | Set-Content -Encoding UTF8 $mdPath
Write-Host ""
Write-Host "Report files:"
Write-Host $mdPath
Write-Host $jsonPath
$failed = @($results | Where-Object status -eq "FAIL").Count
$blocked = @($results | Where-Object status -eq "BLOCKED").Count
Write-Host ("Summary: {0} passed, {1} failed, {2} blocked." -f @($results | Where-Object status -eq "PASS").Count,$failed,$blocked)
if ($failed -gt 0) { exit 1 }
