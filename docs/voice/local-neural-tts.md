# JARVIS local voice output

## Design

JARVIS prefers an optional local Piper neural TTS executable for generated speech. The browser HUD submits text through its existing device-bound signed request mechanism to `POST /api/voice/synthesize`. The server validates the signed session request, caps text at 1,200 characters, runs the configured executable without a shell, validates the returned WAV header, and sends audio with `Cache-Control: no-store`. Text is not written to a voice-specific log. If local TTS is unavailable or returns a provider failure (HTTP 502/503), the HUD falls back to browser speech synthesis and suppresses repeated calls to the failed local provider for the current page session. Reload the HUD after fixing the Piper configuration to retry local TTS.

The voice profile is an original, calm cinematic assistant style: measured pace, clear articulation, restrained pitch, and professional delivery. The supplied clips are references, not a trained model. Do not use a third-party voice clone unless you have the required rights.

## Configure on Windows

1. Install a trusted Piper distribution compatible with your Windows architecture.
2. Download a voice model whose license permits your intended use. Keep its model and companion configuration files together.
3. Copy `.env.example` to `.env` and set absolute paths:
   - `JARVIS_PIPER_EXECUTABLE`: full path to Piper executable.
   - `JARVIS_PIPER_MODEL`: full path to the voice model file.
4. Restart JARVIS and test from the authenticated HUD. If either setting is blank, browser TTS remains the fallback.
5. Keep the executable and model in a user-controlled folder. Do not run as administrator.

## Security and limitations

- This endpoint is only available to an enrolled device with a valid signed session. It does not execute commands or grant planner authority.
- Input is bounded and subprocess execution uses `shell: false`.
- Audio generation can be CPU-intensive; a 20-second timeout is enforced.
- This code path is not yet accepted on the target Windows laptop. Confirm the chosen Piper build's command-line output behavior, WAV playback, browser autoplay permissions, and actual voice quality before marking acceptance complete.
- Wake-word recognition remains a separate concern and may use browser/vendor processing; local TTS does not make recognition offline. If browser recognition returns a network error, hands-free mode is paused instead of restarting repeatedly. Text input remains available; an offline speech-recognition engine is still a separate implementation requirement.
