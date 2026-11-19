. (Join-Path $PSScriptRoot 'lib.ps1')
if (Start-Jarvis) { Write-Host "JARVIS is running on http://127.0.0.1:$(Get-JarvisPort)"; exit 0 }
Write-Error 'JARVIS did not become healthy in time; see logs\jarvis.log and jarvis.log.err.'
exit 1
