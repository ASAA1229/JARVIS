# Shared helpers for the per-user local JARVIS install. Dot-sourced by the other scripts. Never needs elevation.
$ErrorActionPreference = 'Stop'
$script:JarvisHome = if ($env:JARVIS_HOME) { $env:JARVIS_HOME } else { Join-Path $env:LOCALAPPDATA 'JARVIS' }
$script:TaskName = if ($env:JARVIS_TASK_NAME) { $env:JARVIS_TASK_NAME } else { 'JARVIS-Local' }
$script:DefaultPort = 3917   # fixed; not in use by Jenkins 8443, 8100-8101, 8200-8201, 8300, 8080

function Get-JarvisPaths {
  [pscustomobject]@{
    Home     = $script:JarvisHome
    Versions = Join-Path $script:JarvisHome 'versions'
    Data     = Join-Path $script:JarvisHome 'data'
    Config   = Join-Path $script:JarvisHome 'config'
    Logs     = Join-Path $script:JarvisHome 'logs'
    Bin      = Join-Path $script:JarvisHome 'bin'
    State    = Join-Path $script:JarvisHome 'state.json'
    Pid      = Join-Path $script:JarvisHome 'jarvis.pid'
    EnvFile  = Join-Path (Join-Path $script:JarvisHome 'config') '.env'
  }
}
function Read-JarvisState {
  $p = Get-JarvisPaths
  if (-not (Test-Path -LiteralPath $p.State)) { return [pscustomobject]@{ current = $null; previous = $null; node = $null; port = $script:DefaultPort } }
  Get-Content -LiteralPath $p.State -Raw | ConvertFrom-Json
}
function Write-JarvisState($state) {
  $p = Get-JarvisPaths
  $tmp = "$($p.State).tmp"
  $state | ConvertTo-Json | Set-Content -LiteralPath $tmp -Encoding UTF8
  Move-Item -Force -LiteralPath $tmp -Destination $p.State
}
function Get-JarvisPort {
  $p = Get-JarvisPaths
  if (Test-Path -LiteralPath $p.EnvFile) {
    $m = Select-String -LiteralPath $p.EnvFile -Pattern '^PORT=(\d+)\s*$' | Select-Object -First 1
    if ($m) { return [int]$m.Matches[0].Groups[1].Value }
  }
  return $script:DefaultPort
}
function Get-JarvisProcess {
  $p = Get-JarvisPaths
  if (-not (Test-Path -LiteralPath $p.Pid)) { return $null }
  $id = [int]((Get-Content -LiteralPath $p.Pid -TotalCount 1).Trim())
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue
  if ($cim -and $cim.CommandLine -notmatch 'dist[\\/]index\.js') { return $null }   # PID reused by something else
  $proc
}
function Test-JarvisHealth([int]$Port, [int]$TimeoutSec = 3) {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec $TimeoutSec
    return ($r.status -eq 'ONLINE')
  } catch { return $false }
}
function Start-Jarvis([int]$WaitSec = 60) {
  $p = Get-JarvisPaths
  if (Get-JarvisProcess) { return $true }
  $runner = Join-Path $p.Bin 'run.ps1'
  if (-not (Test-Path -LiteralPath $runner)) { throw "Not installed: $runner is missing. Run install.ps1 first." }
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $runner) | Out-Null
  $port = Get-JarvisPort
  $deadline = (Get-Date).AddSeconds($WaitSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-JarvisHealth $port 2) { return $true }
    Start-Sleep -Milliseconds 700
  }
  return $false
}
function Stop-Jarvis {
  $proc = Get-JarvisProcess
  if ($proc) {
    & taskkill.exe /PID $proc.Id /T /F | Out-Null
    $proc.WaitForExit(15000) | Out-Null
  }
  Remove-Item -Force -LiteralPath (Get-JarvisPaths).Pid -ErrorAction SilentlyContinue
  return $true
}
function Register-JarvisAutostart {
  $p = Get-JarvisPaths
  $runner = Join-Path $p.Bin 'run.ps1'
  $arg = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`""
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
    $principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $script:TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
    return 'ScheduledTask'
  } catch {
    Write-Warning "Scheduled Task registration failed ($($_.Exception.Message)); using the Startup folder instead."
    $startup = [Environment]::GetFolderPath('Startup')
    $lnk = Join-Path $startup "$($script:TaskName).lnk"
    $sh = New-Object -ComObject WScript.Shell
    $s = $sh.CreateShortcut($lnk)
    $s.TargetPath = 'powershell.exe'; $s.Arguments = $arg; $s.WindowStyle = 7; $s.Save()
    return 'StartupFolder'
  }
}
function Unregister-JarvisAutostart {
  Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Force -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) "$($script:TaskName).lnk") -ErrorAction SilentlyContinue
}
function Get-JarvisAutostart {
  if (Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue) { return 'ScheduledTask' }
  if (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) "$($script:TaskName).lnk")) { return 'StartupFolder' }
  return 'none'
}
function Set-JarvisCurrent([string]$VersionId) {
  # Activates a version: junction its data dir to the shared data dir and copy the persistent .env into it.
  $p = Get-JarvisPaths
  $dir = Join-Path $p.Versions $VersionId
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'dist\index.js'))) { throw "Version $VersionId is not a complete install." }
  $dataLink = Join-Path $dir 'data'
  if (-not (Test-Path -LiteralPath $dataLink)) { New-Item -ItemType Junction -Path $dataLink -Target $p.Data | Out-Null }
  Copy-Item -Force -LiteralPath $p.EnvFile -Destination (Join-Path $dir '.env')
}
