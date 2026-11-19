<#
.SYNOPSIS
  Per-user local install of a verified, signed JARVIS bundle (no admin, no SYSTEM service, loopback only).
.DESCRIPTION
  Verifies the bundle (SHA-256, manifest, Ed25519 signature against -PublicKey, clean-room verifier), extracts it to
  %LOCALAPPDATA%\JARVIS\versions\<id>, re-verifies the extracted tree, keeps the previous version for rollback, creates the
  persistent .env on first install (random owner token, loopback port 3917, Ollama-local default, no cloud), copies the
  management scripts to <home>\bin and registers a per-user logon task (falls back to the Startup folder).
  Run by the owner, in the owner's session: a Jenkins-driven install would install for the jenkins-agent account instead.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BundleDir,
  [Parameter(Mandatory = $true)][string]$PublicKey,
  [int]$Port = 0,
  [switch]$NoStart
)
. (Join-Path $PSScriptRoot 'lib.ps1')
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$BundleDir = (Resolve-Path $BundleDir).Path
$PublicKey = (Resolve-Path $PublicKey).Path
function Run([string]$what, [string]$file, [string[]]$a) { & $file @a | Out-Null; if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }
if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Warning 'Running elevated: JARVIS is meant to be installed and run unprivileged. Continuing, but the task still runs at limited level.'
}

$tar = Join-Path $BundleDir 'jarvis-local-build.tar.gz'
$manifest = Join-Path $BundleDir 'jarvis-local-manifest.json'
$sum = "$tar.sha256"
$policy = Join-Path $BundleDir 'jarvis-local-manifest-ignore.json'
$policySum = "$policy.sha256"
$sig = Join-Path $BundleDir 'jarvis-local-manifest-ignore.sig'
foreach ($f in @($tar, $manifest, $sum, $policy, $policySum, $sig)) { if (-not (Test-Path -LiteralPath $f)) { throw "Bundle file missing: $f" } }

Write-Host 'Verifying bundle...'
Set-Location -LiteralPath $repo
Run 'archive checksum' 'node' @('scripts/artifact-integrity.mjs', 'verify-release', $tar, $manifest, $sum)
Run 'signature' 'node' @('scripts/policy-signature.mjs', 'verify', $policy, $sig, $PublicKey)
Run 'clean-room verification' 'node' @('scripts/customer-release-verifier.mjs', 'verify', $policy, $policySum, $manifest, $tar, '-', $sig, $PublicKey)

$p = Get-JarvisPaths
foreach ($d in @($p.Home, $p.Versions, $p.Data, $p.Config, $p.Logs, $p.Bin)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }
$hash = ((Get-Content -LiteralPath $sum -TotalCount 1).Trim() -split '\s+')[0].Substring(0, 12)
$id = "$(Get-Date -Format 'yyyyMMdd-HHmmss')-$hash"
$dir = Join-Path $p.Versions $id
New-Item -ItemType Directory -Force -Path $dir | Out-Null
try {
  Run 'extract' 'tar' @('-xzf', $tar, '-C', $dir)
  Run 'extracted tree verification' 'node' @('scripts/artifact-integrity.mjs', 'verify', $dir, $manifest, $tar)
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'dist\index.js'))) { throw 'Bundle does not contain dist\index.js.' }
} catch { Remove-Item -Recurse -Force -LiteralPath $dir -ErrorAction SilentlyContinue; throw }

# Persistent configuration (created once; never overwritten): loopback port, random owner token, local Ollama, no cloud.
if (-not (Test-Path -LiteralPath $p.EnvFile)) {
  $usePort = if ($Port -gt 0) { $Port } else { $script:DefaultPort }
  $token = & node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
  $lines = @(
    "PORT=$usePort",
    'JARVIS_DEVICE_STATE_PATH=./data/devices.json',
    'JARVIS_AUDIT_PATH=./data/audit.log',
    "JARVIS_OWNER_CONTROL_TOKEN=$token",
    'OLLAMA_URL=http://localhost:11434'
  )
  Set-Content -LiteralPath $p.EnvFile -Value $lines -Encoding ASCII
  # Owner-only ACL on the config (contains the owner token).
  & icacls.exe $p.EnvFile /inheritance:r /grant:r "$($env:USERNAME):(F)" | Out-Null
  Write-Host "Created config $($p.EnvFile) (port $usePort, loopback only, owner token generated locally)."
} elseif ($Port -gt 0) { Write-Warning 'Existing config kept; -Port is ignored. Edit PORT in the config .env to change it.' }

$state = Read-JarvisState
$wasRunning = [bool](Get-JarvisProcess)
if ($wasRunning) { Stop-Jarvis | Out-Null }
$node = (Get-Command node).Source
Set-JarvisCurrent $id
$new = [pscustomobject]@{ current = $id; previous = $state.current; node = $node; port = (Get-JarvisPort) }
Write-JarvisState $new

Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.ps1' | Where-Object { $_.Name -notin @('install.ps1', 'build-local-bundle.ps1') } | Copy-Item -Destination $p.Bin -Force
# Keep only the current and previous versions.
Get-ChildItem -LiteralPath $p.Versions -Directory | Where-Object { $_.Name -notin @($new.current, $new.previous) } | ForEach-Object {
  $link = Join-Path $_.FullName 'data'
  if (Test-Path -LiteralPath $link) { (Get-Item -LiteralPath $link -Force).Delete() }
  Remove-Item -Recurse -Force -LiteralPath $_.FullName
}

$mode = Register-JarvisAutostart
Write-Host "Installed version $id; autostart: $mode; previous: $($new.previous)"
if (-not $NoStart) {
  if (Start-Jarvis) { Write-Host "JARVIS is healthy on http://127.0.0.1:$(Get-JarvisPort)" }
  else { Write-Error "JARVIS did not become healthy; run rollback.ps1 from $($p.Bin) if a previous version exists."; exit 1 }
}
