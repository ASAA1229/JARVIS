[CmdletBinding()]
param([string]$ReportDirectory = (Join-Path $env:TEMP "JARVIS-workstation-evidence"))
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
function Find-CommandPath([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}
$checks = [ordered]@{
    git = Find-CommandPath "git"; node = Find-CommandPath "node"; npm = Find-CommandPath "npm"
    java = Find-CommandPath "java"; gradle = Find-CommandPath "gradle"; adb = Find-CommandPath "adb"
    androidStudio = $null; repository = (Get-Location).Path; branch = $null; devices = @()
}
$studioCandidates = @(
    (Join-Path $env:ProgramFiles "Android\Android Studio\bin\studio64.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Android Studio\bin\studio64.exe")
)
$checks.androidStudio = $studioCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($checks.git) {
    $branch = & git branch --show-current 2>$null
    if ($LASTEXITCODE -eq 0) { $checks.branch = ($branch | Out-String).Trim() }
}
if ($checks.node) { $checks.nodeVersion = (& node --version 2>$null | Out-String).Trim() }
if ($checks.npm) { $checks.npmVersion = (& npm --version 2>$null | Out-String).Trim() }
if ($checks.java) { $checks.javaVersion = ((& java -version 2>&1 | Select-Object -First 1) | Out-String).Trim() }
if ($checks.gradle) { $checks.gradleVersion = ((& gradle --version 2>&1 | Select-String "Gradle [0-9]" | Select-Object -First 1) | Out-String).Trim() }
if ($checks.adb) {
    $adbOutput = & adb devices -l 2>&1
    if ($LASTEXITCODE -eq 0) {
        foreach ($line in $adbOutput) {
            if ($line -match "^\S+\s+(device|unauthorized|offline)\b") {
                $checks.devices += [pscustomobject]@{ state = $Matches[1] }
            }
        }
    }
}
$required = @("git", "node", "npm", "java", "gradle", "adb")
$missing = @($required | Where-Object { -not $checks[$_] })
$authorized = @($checks.devices | Where-Object state -eq "device").Count
$unauthorized = @($checks.devices | Where-Object state -eq "unauthorized").Count
$offline = @($checks.devices | Where-Object state -eq "offline").Count
New-Item -ItemType Directory -Force -Path $ReportDirectory | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$jsonPath = Join-Path $ReportDirectory "preflight-$stamp.json"
$mdPath = Join-Path $ReportDirectory "preflight-$stamp.md"
$result = [ordered]@{
    generatedAt = (Get-Date).ToString("o"); machine = $env:COMPUTERNAME; checks = $checks
    missingRequiredTools = $missing; authorizedAndroidDevices = $authorized
    unauthorizedAndroidDevices = $unauthorized; offlineAndroidDevices = $offline
    gradleWrapperPresent = (Test-Path (Join-Path (Get-Location) "android-app\gradlew.bat"))
}
$result | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 $jsonPath
$lines = @("# JARVIS workstation preflight", "", "- Generated: $($result.generatedAt)", "- Machine: $($result.machine)", "- Repository: $($checks.repository)", "- Branch: $($checks.branch)", "", "## Tool availability")
foreach ($name in @("git","node","npm","java","gradle","adb","androidStudio")) {
    $value = $checks[$name]
    if (-not $value) { $value = "NOT FOUND" }
    $lines += "- $($name): $value"
}
$lines += @("", "## Android device readiness", "- Authorized devices: $authorized", "- Unauthorized devices: $unauthorized", "- Offline devices: $offline", "- Device serials are intentionally not stored in this report.", "", "## Assessment", "- Required tools missing: $(if ($missing.Count -eq 0) { 'none' } else { $missing -join ', ' })", "- Android Gradle Wrapper: $(if ($result.gradleWrapperPresent) { 'present' } else { 'not present; system Gradle required' })", "- Preflight only: no build, test, install, pairing, enrollment or device mutation was performed.")
$lines | Set-Content -Encoding UTF8 $mdPath
Write-Host "JARVIS workstation preflight complete."
Write-Host "Authorized Android devices: $authorized (target: 2)"
if ($unauthorized -gt 0) { Write-Warning "$unauthorized device(s) need USB-debugging authorization on the phone." }
if ($missing.Count -gt 0) { Write-Warning "Missing tools: $($missing -join ', ')" }
Write-Host "Markdown report: $mdPath"
Write-Host "JSON report: $jsonPath"
