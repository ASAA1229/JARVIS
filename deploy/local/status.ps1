. (Join-Path $PSScriptRoot 'lib.ps1')
$s = Read-JarvisState
$proc = Get-JarvisProcess
$port = Get-JarvisPort
$healthy = if ($proc) { Test-JarvisHealth $port } else { $false }
[pscustomobject]@{
  home = (Get-JarvisPaths).Home; current = $s.current; previous = $s.previous
  running = [bool]$proc; pid = if ($proc) { $proc.Id } else { $null }
  port = $port; bind = '127.0.0.1'; healthy = $healthy; autostart = (Get-JarvisAutostart)
} | ConvertTo-Json
if ($healthy) { exit 0 } else { exit 1 }
