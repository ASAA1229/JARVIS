<#
.SYNOPSIS
  Builds a self-contained, integrity-verified, Ed25519-signed JARVIS bundle for the per-user local install.
.DESCRIPTION
  Stages dist + the static companion UI + production node_modules, runs the same package-release.ps1 integrity pipeline
  that Jenkins uses, then signs the manifest-ignore policy with a PER-RUN key (there is no production signing key) and runs
  the clean-room customer verification. The private key is deleted after signing; the public key is written next to the
  bundle and must be passed to install.ps1 -PublicKey.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutDir)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $repo
function Run([string]$what, [string]$file, [string[]]$a) { & $file @a; if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$stage = Join-Path $repo '.release-stage\jarvis-local'
Remove-Item -Recurse -Force -LiteralPath (Join-Path $repo '.release-stage') -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $stage | Out-Null

Run 'build' 'npm' @('run', 'build')
Copy-Item -Recurse -Force -LiteralPath (Join-Path $repo 'dist') -Destination (Join-Path $stage 'dist')
New-Item -ItemType Directory -Force -Path (Join-Path $stage 'src') | Out-Null
Copy-Item -Recurse -Force -LiteralPath (Join-Path $repo 'src\companion') -Destination (Join-Path $stage 'src\companion')
Copy-Item -Force -LiteralPath (Join-Path $repo 'package.json') -Destination $stage
$repoLock = Join-Path $repo 'package-lock.json'
if (Test-Path -LiteralPath $repoLock) { Copy-Item -Force -LiteralPath $repoLock -Destination $stage }
Push-Location $stage
try { Run 'production dependency install' 'npm' @('install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') } finally { Pop-Location }

$commit = (& git rev-parse HEAD).Trim()
$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$env:REQUIRE_BUILD_PROVENANCE = 'false'; $env:GIT_COMMIT = $commit; $env:GIT_BRANCH = $branch
$env:JOB_NAME = 'local-owner-build'; $env:BUILD_TAG = "local-$stamp"; $env:BUILD_URL = 'file:///local-owner-build'; $env:BUILD_NUMBER = $stamp
$rel = '.release-stage\jarvis-local'
Run 'package + integrity' 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repo 'ci\jenkins\package-release.ps1'), '-ProjectName', 'JARVIS', '-Prefix', 'jarvis-local', '-OutputDirs', $rel, '-LocalBuild')

# Per-run Ed25519 key (no production key exists). Private key lives only in a temp dir and is deleted.
$keyDir = Join-Path ([IO.Path]::GetTempPath()) ("jarvis-key-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
try {
  $priv = Join-Path $keyDir 'private.pem'; $pub = Join-Path $OutDir 'jarvis-local-signing-public.pem'
  $gen = "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('ed25519');f.writeFileSync(process.argv[1],k.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});f.writeFileSync(process.argv[2],k.publicKey.export({type:'spki',format:'pem'}));"
  Run 'key generation' 'node' @('-e', $gen, $priv, $pub)
  $sig = 'jarvis-local-manifest-ignore.sig'
  Remove-Item -Force -LiteralPath $sig -ErrorAction SilentlyContinue
  Run 'policy signing' 'node' @('scripts/policy-signature.mjs', 'sign', 'jarvis-local-manifest-ignore.json', $sig, $priv)
  Run 'signature verification' 'node' @('scripts/policy-signature.mjs', 'verify', 'jarvis-local-manifest-ignore.json', $sig, $pub)
  Run 'clean-room signed verification' 'node' @('scripts/customer-release-verifier.mjs', 'verify', 'jarvis-local-manifest-ignore.json', 'jarvis-local-manifest-ignore.json.sha256', 'jarvis-local-manifest.json', 'jarvis-local-build.tar.gz', '-', $sig, $pub)
} finally { Remove-Item -Recurse -Force -LiteralPath $keyDir -ErrorAction SilentlyContinue }

foreach ($f in @('jarvis-local-build.tar.gz', 'jarvis-local-manifest.json', 'jarvis-local-build.tar.gz.sha256', 'jarvis-local-manifest-ignore.json', 'jarvis-local-manifest-ignore.json.sha256', 'jarvis-local-manifest-ignore.sig')) {
  Move-Item -Force -LiteralPath (Join-Path $repo $f) -Destination (Join-Path $OutDir $f)
}
Remove-Item -Recurse -Force -LiteralPath (Join-Path $repo '.release-stage')
Write-Host "Signed local bundle written to $OutDir (per-run key; public key: jarvis-local-signing-public.pem)."
