# Removes autostart and the program files. Data (audit log, devices, config) is kept unless -PurgeData is passed.
param([switch]$PurgeData)
. (Join-Path $PSScriptRoot 'lib.ps1')
$p = Get-JarvisPaths
Stop-Jarvis | Out-Null
Unregister-JarvisAutostart
foreach ($v in (Get-ChildItem -LiteralPath $p.Versions -Directory -ErrorAction SilentlyContinue)) {
  $link = Join-Path $v.FullName 'data'
  if (Test-Path -LiteralPath $link) { (Get-Item -LiteralPath $link -Force).Delete() }   # remove the junction only, never its target
  Remove-Item -Recurse -Force -LiteralPath $v.FullName
}
Remove-Item -Force -LiteralPath $p.State -ErrorAction SilentlyContinue
if ($PurgeData) {
  Get-ChildItem -LiteralPath $p.Home -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'bin' } | Remove-Item -Recurse -Force
  Write-Host 'Data and config purged.'
} else { Write-Host "Kept data and config under $($p.Home) (use -PurgeData to remove)." }
Write-Host 'JARVIS uninstalled; autostart removed.'
