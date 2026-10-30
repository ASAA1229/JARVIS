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
  @{ Url = 'https://raw.githubusercontent.com/voicute/onnx-wakeword/8002ba9a14d80c0f71447920d3f1c8ee986b1432/web/wakeword.js'; Name = 'wakeword.js'; MinBytes = 1000 },
  @{ Url = 'https://raw.githubusercontent.com/voicute/onnx-wakeword/8002ba9a14d80c0f71447920d3f1c8ee986b1432/models/melspectrogram.onnx'; Name = 'melspectrogram.onnx'; MinBytes = 1000 },
  @{ Url = 'https://raw.githubusercontent.com/voicute/onnx-wakeword/8002ba9a14d80c0f71447920d3f1c8ee986b1432/models/en/multi_jarvis_v9.3.zip'; Name = 'multi_jarvis_v9.3.zip'; MinBytes = 1000 }
)
foreach ($item in $downloads) {
  $target = Join-Path $assetRoot $item.Name
  Write-Host "Downloading $($item.Name) from the upstream open-source project..."
  Invoke-WebRequest -Uri $item.Url -OutFile $target
  if (-not (Test-Path $target) -or (Get-Item $target).Length -lt $item.MinBytes) {
    throw "Downloaded asset failed the size check: $($item.Name)"
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
