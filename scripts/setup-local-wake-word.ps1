$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Optional, one-time setup for the local-only "Hey Jarvis" wake detector.
# Audio inference is performed in the browser on this device; no audio is uploaded.
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeRoot = Join-Path $repoRoot '.jarvis-local-wakeword'
$assetRoot = Join-Path $repoRoot 'src\companion\local-wakeword'
New-Item -ItemType Directory -Force -Path $runtimeRoot, $assetRoot | Out-Null

Write-Host 'Installing pinned local inference runtime (no root package or lockfile changes)...'
npm install --prefix $runtimeRoot --no-save --package-lock=false onnxruntime-web@1.20.1 jszip@3.10.1
if ($LASTEXITCODE -ne 0) { throw 'Local wake-word runtime installation failed.' }

$dist = Join-Path $runtimeRoot 'node_modules\onnxruntime-web\dist'
$jszip = Join-Path $runtimeRoot 'node_modules\jszip\dist\jszip.min.js'
foreach ($required in @((Join-Path $dist 'ort.min.js'), $jszip)) {
  if (-not (Test-Path $required)) { throw "Required runtime file is missing: $required" }
}
Copy-Item (Join-Path $dist 'ort.min.js') $assetRoot -Force
Copy-Item $jszip $assetRoot -Force
Get-ChildItem $dist -Filter 'ort-wasm*' -File | Copy-Item -Destination $assetRoot -Force

$downloads = @(
  @{ Url = 'https://raw.githubusercontent.com/voicute/onnx-wakeword/8002ba9a14d80c0f71447920d3f1c8ee986b1432/web/wakeword.js'; Name = 'wakeword.js'; MinBytes = 1000; GitBlobSha = 'a33f24ebcb89532478f15ba9e3b33bb8aa165a23' },
  @{ Url = 'https://raw.githubusercontent.com/voicute/onnx-wakeword/8002ba9a14d80c0f71447920d3f1c8ee986b1432/models/melspectrogram.onnx'; Name = 'melspectrogram.onnx'; MinBytes = 1000; GitBlobSha = 'a3a60354eebe5fa4c7c9534851e4cb0bd7b0d06c' },
  @{ Url = 'https://raw.githubusercontent.com/voicute/onnx-wakeword/8002ba9a14d80c0f71447920d3f1c8ee986b1432/models/en/multi_jarvis_v9.3.zip'; Name = 'multi_jarvis_v9.3.zip'; MinBytes = 1000; GitBlobSha = '12d92a59869d7a1228761eb7127b930e5f568a6e' }
)
foreach ($item in $downloads) {
  $target = Join-Path $assetRoot $item.Name
  Write-Host "Downloading $($item.Name) from the upstream open-source project..."
  Invoke-WebRequest -Uri $item.Url -OutFile $target
  if (-not (Test-Path $target) -or (Get-Item $target).Length -lt $item.MinBytes) {
    throw "Downloaded asset failed the size check: $($item.Name)"
  }
  # Verify the exact Git blob content pinned in the upstream tree, not only the URL/size.
  $assetBytes = [System.IO.File]::ReadAllBytes($target)
  $gitHeader = [System.Text.Encoding]::ASCII.GetBytes("blob $($assetBytes.Length)`0")
  $gitObject = New-Object byte[] ($gitHeader.Length + $assetBytes.Length)
  [System.Buffer]::BlockCopy($gitHeader, 0, $gitObject, 0, $gitHeader.Length)
  [System.Buffer]::BlockCopy($assetBytes, 0, $gitObject, $gitHeader.Length, $assetBytes.Length)
  $sha1 = [System.Security.Cryptography.SHA1]::Create()
  try { $actualGitBlobSha = [System.BitConverter]::ToString($sha1.ComputeHash($gitObject)).Replace('-', '').ToLowerInvariant() }
  finally { $sha1.Dispose() }
  if ($actualGitBlobSha -ne $item.GitBlobSha) {
    Remove-Item $target -Force
    throw "Downloaded asset failed pinned Git blob integrity verification: $($item.Name)"
  }
}
$zipPath = Join-Path $assetRoot 'multi_jarvis_v9.3.zip'
$bytes = [System.IO.File]::ReadAllBytes($zipPath)
if ($bytes.Length -lt 4 -or $bytes[0] -ne 0x50 -or $bytes[1] -ne 0x4B) {
  throw 'The wake-word model download is not a valid ZIP package.'
}
$hashes = Get-ChildItem $assetRoot -File | Get-FileHash -Algorithm SHA256
Write-Host ''
Write-Host 'Local wake-word assets are installed. SHA-256 inventory:'
$hashes | Format-Table -AutoSize
Write-Host 'Restart JARVIS and open http://127.0.0.1:3000/hud. Enable local wake detection to test.'
Write-Host 'Inference is local after setup. Setup requires a one-time network download; no audio is sent by the wake-word engine.'
