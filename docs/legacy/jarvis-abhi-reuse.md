# Legacy Jarvis-abhi code review and reuse record

This note records the targeted reuse of the two supplied archives in the current TypeScript JARVIS project.

## Sources reviewed

- `JARVIS_ABHI_v1_reconstructed.zip`: a Python MVP with a SpeechRecognition microphone wrapper, an Ollama HTTP client, a `pyttsx3` speaker, a small allowlisted Windows command router, and basic tests.
- `JARVIS_ABHI_v10.zip`: mostly scaffolding. Several advertised components are placeholders, including the Whisper transcription stub (returns a fixed string) and authentication stub (always returns true).

## Reuse decision

The current JARVIS is a TypeScript modular monolith with an existing browser HUD, push-to-talk lifecycle, local Piper TTS adapter, device-bound security, and audit controls. We are adapting behavior, not copying the legacy Python app as a second runtime.

The first targeted adaptation is more actionable speech-recognition failure feedback in `src/companion/hud.js`. The legacy v1 code explicitly separated unrecognized speech from speech-service errors; the current HUD now distinguishes no speech, unavailable microphone, network/service failure, aborted capture, and unsupported language. This makes it easier to diagnose why voice input did not produce a directive.

## Deliberately not reused

- The legacy v10 `verify_user()` stub: always returns true and is not authentication.
- The legacy v10 Whisper stub: returns fixed placeholder text instead of transcribing audio.
- The legacy v10 in-memory device list and unauthenticated command endpoint.
- The legacy Python runtime as a parallel service: that would duplicate responsibilities and bypass the current policy gateway if wired incorrectly.
- The legacy `pyttsx3` voice as the primary TTS: the current project already has a local Piper adapter.

## Next integration candidates

1. Add automated browser/HUD tests for permission denial, silence, device failure, and network failure.
2. Test voice capture on the actual target browser and Windows microphone, since browser speech recognition may use a remote provider.
3. Evaluate local STT as a replaceable provider behind a dedicated interface, with no execution authority.
4. Keep command routing, device authorization, audit, and approval decisions in the current JARVIS core.
