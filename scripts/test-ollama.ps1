$ErrorActionPreference = 'Stop'

$ConfiguredUrl = if ($env:OLLAMA_URL) { $env:OLLAMA_URL } else { 'http://localhost:11434' }
$ParsedUrl = [uri]$ConfiguredUrl
if ($ParsedUrl.Scheme -notin @('http', 'https') -or
    $ParsedUrl.Host -notin @('localhost', '127.0.0.1', '::1') -or
    $ParsedUrl.UserInfo -or $ParsedUrl.Query -or $ParsedUrl.Fragment -or
    $ParsedUrl.AbsolutePath -ne '/') {
    throw 'Ollama smoke tests are restricted to a loopback URL without credentials or a path.'
}
$BaseUrl = $ParsedUrl.GetLeftPart([System.UriPartial]::Authority)
$Model = if ($env:OLLAMA_MODEL) { $env:OLLAMA_MODEL } else { 'llama3.2:latest' }
$EmbeddingModel = if ($env:JARVIS_EMBED_MODEL) { $env:JARVIS_EMBED_MODEL } else { 'nomic-embed-text' }
$Timeout = if ($env:OLLAMA_TIMEOUT) { [int]$env:OLLAMA_TIMEOUT } else { 120 }

if ($Timeout -lt 1 -or $Timeout -gt 600) {
    throw 'OLLAMA_TIMEOUT must be between 1 and 600 seconds.'
}

Write-Host "[JARVIS] Checking Ollama at $BaseUrl"
$Tags = Invoke-RestMethod -Method Get -Uri "$BaseUrl/api/tags" -TimeoutSec $Timeout
$Installed = @($Tags.models | ForEach-Object { $_.name })
$ChatInstalled = $Installed -contains $Model -or (
    $Model -notmatch ':' -and @($Installed | Where-Object { $_ -like ($Model + ':*') }).Count -gt 0
)
if (-not $ChatInstalled) {
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

$EmbeddingInstalled = $Installed -contains $EmbeddingModel -or (
    $EmbeddingModel -notmatch ':' -and @($Installed | Where-Object { $_ -like ($EmbeddingModel + ':*') }).Count -gt 0
)
if (-not $EmbeddingInstalled) {
    Write-Warning "Optional embedding model $EmbeddingModel is not installed; semantic retrieval will use lexical fallback. Run: ollama pull $EmbeddingModel"
} else {
    $EmbeddingBody = @{
        model = $EmbeddingModel
        input = 'JARVIS local embedding smoke test'
    } | ConvertTo-Json -Depth 4
    $EmbeddingReply = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/embed" -ContentType 'application/json' -Body $EmbeddingBody -TimeoutSec $Timeout
    $Vector = @($EmbeddingReply.embeddings[0])
    if ($Vector.Count -eq 0) {
        throw 'Ollama returned an empty embedding vector.'
    }
    Write-Host "[JARVIS] Native /api/embed test passed ($($Vector.Count) dimensions)."
}
