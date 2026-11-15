# Switches back to the previously installed version (keeps data). Swaps current/previous so a second run rolls forward.
. (Join-Path $PSScriptRoot 'lib.ps1')
$s = Read-JarvisState
if (-not $s.previous) { Write-Error 'No previous version to roll back to.'; exit 1 }
$p = Get-JarvisPaths
if (-not (Test-Path -LiteralPath (Join-Path $p.Versions "$($s.previous)\dist\index.js"))) { Write-Error "Previous version $($s.previous) is missing on disk."; exit 1 }
$wasRunning = [bool](Get-JarvisProcess)
Stop-Jarvis | Out-Null
$new = [pscustomobject]@{ current = $s.previous; previous = $s.current; node = $s.node; port = $s.port }
Write-JarvisState $new
Write-Host "Rolled back: current=$($new.current) previous=$($new.previous)"
if ($wasRunning) {
  if (-not (Start-Jarvis)) {
    Write-Warning 'Rolled-back version did not become healthy; restoring the former version.'
    Stop-Jarvis | Out-Null
    Write-JarvisState $s
    Start-Jarvis | Out-Null
    exit 1
  }
}
