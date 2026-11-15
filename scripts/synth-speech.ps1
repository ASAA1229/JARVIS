<#
.SYNOPSIS
  Synthesizes a 16 kHz mono 16-bit PCM WAV (the exact format whisper.cpp and JARVIS expect) with Windows SAPI.
.EXAMPLE
  synth-speech.ps1 -Text "Hey Jarvis, open Notepad" -Out hey-open.wav [-PauseMs 1500 -Text2 "open Notepad"]
#>
param(
  [Parameter(Mandatory = $true)][string]$Text,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Text2 = '',
  [int]$PauseMs = 0,
  [int]$Rate = 0,
  [int]$LeadMs = 0,
  [int]$TailMs = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = $Rate
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($Out, $fmt)
$pb = New-Object System.Speech.Synthesis.PromptBuilder
if ($LeadMs -gt 0) { $pb.AppendBreak([TimeSpan]::FromMilliseconds($LeadMs)) }
$pb.AppendText($Text)
if ($Text2) {
  $pb.AppendBreak([TimeSpan]::FromMilliseconds($PauseMs))
  $pb.AppendText($Text2)
}
if ($TailMs -gt 0) { $pb.AppendBreak([TimeSpan]::FromMilliseconds($TailMs)) }
$s.Speak($pb)
$s.Dispose()
