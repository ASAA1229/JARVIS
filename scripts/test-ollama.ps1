$ErrorActionPreference = 'Stop'

$BaseUrl = if ($env:OLLAMA_URL) { $env:OLLAMA_URL.TrimEnd('/') } else { 'http://localhost:11434' }
$Model = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'llama3.2:latest' }
$Timeout = if ($env:OLLAMA_TIMEOUT) { [int]$env:OLLAMA_TIMEOUT } else { 120 }

if ($Timeout -lt 1 -or $Timeout -gt 600) {
    throw 'OLLAMA_TIMEOUT must be between 1 and 600 seconds.'
}

Write-Host "[JARVIS] Checking Ollama at $BaseUrl"
$Tags = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/tags" -TimeoutSec $Timeout
$Installed = @($Tags.models | ForEach-Object { $_.name })
if ($Installed -notcontains $Model) {
    throw "Model $Model is not installed. Run: ollama pull $Model"
}
Write-Host "[JARVIS] Ollama is reachable and $Model is installed."

$Body = @{
    model = $Model
    messages = @(@{ role = 'user'; content = 'Reply with exactly: OLLAMA_OK' })
    stream = $false
    options = @{ temperature = 0 }
} | ConvertTo-Json -Depth 8

$Reply = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/chat" -ContentType 'application/json' -Body $Body -TimeoutSec $Timeout
if (-not $Reply.message.content) {
    throw 'Ollama returned an empty or invalid chat response.'
}
Write-Host '[JARVIS] Native /api/chat test passed.'
Write-Host "Model: $Model"
Write-Host "Response: $($Reply.message.content)"
