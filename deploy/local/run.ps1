# Foreground runner used by the logon task and start.ps1: runs the current version under this user, loopback only.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
$p = Get-JarvisPaths
$state = Read-JarvisState
if (-not $state.current) { throw 'No installed version.' }
if (Get-JarvisProcess) { exit 0 }
$dir = Join-Path $p.Versions $state.current
Set-JarvisCurrent $state.current
New-Item -ItemType Directory -Force -Path $p.Logs | Out-Null
$log = Join-Path $p.Logs 'jarvis.log'
if ((Test-Path -LiteralPath $log) -and (Get-Item -LiteralPath $log).Length -gt 5MB) { Move-Item -Force -LiteralPath $log -Destination "$log.1" }
$node = if ($state.node -and (Test-Path -LiteralPath $state.node)) { $state.node } else { (Get-Command node).Source }
$proc = Start-Process -FilePath $node -ArgumentList @('dist/index.js') -WorkingDirectory $dir -WindowStyle Hidden -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err"
Set-Content -LiteralPath $p.Pid -Value $proc.Id
$proc.WaitForExit()
Remove-Item -Force -LiteralPath $p.Pid -ErrorAction SilentlyContinue
exit $proc.ExitCode
