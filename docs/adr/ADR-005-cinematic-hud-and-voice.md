# ADR-005: Cinematic Windows HUD Architecture and Speech Recognition Integration

## Status
Accepted

## Context
Milestone 7 requires adding:
1. A cinematic futuristic Windows HUD that feels like a premium AI assistant (e.g. Iron Man / JARVIS aesthetic with animated glowing arc-reactor / waveform center, glassmorphism, responsive layout, dark palette with cyan/electric blue accents, clear system status, pending approvals, task activities, and accessibility/reduced-motion options).
2. Push-to-talk voice interaction that captures microphone input only when the user explicitly triggers it (via on-screen button or keyboard shortcut `Space`/`Ctrl+M`), transcribes speech, displays the transcript for review/editing, and submits it to the existing untrusted input pipeline.
3. Strict privacy safeguards:
   - No continuous audio capture.
   - No background wake-word listening.
   - Persistent microphone mute/disable control with prominent visual indicator.
   - Local-first processing; explicit disclosure if cloud speech synthesis/recognition is active.
   - Full keyboard accessibility and working text-input fallback.

## Evaluated Options

### 1. Desktop Shell Options
- **Option A: Heavyweight Electron Shell**:
  - Pros: Native window frame controls.
  - Cons: Requires >150MB bundle size, 120MB+ idle RAM overhead, high dependency vulnerability surface. Violates low-resource laptop requirements.
- **Option B: Integrated High-Performance Browser HUD (`/hud`)**:
  - Pros: Zero additional dependencies, zero packaging overhead, runs directly on Node.js v24 HTTP server, <45MB RAM footprint, full hardware-accelerated CSS/Canvas animations via Intel Iris Xe graphics, instant responsiveness on Windows 11.
  - Decision: **Option B (Integrated HUD)**.

### 2. Speech Recognition Engine Options
- **Option A: Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`)**:
  - Pros: Built into modern browsers (Chromium/Edge on Windows 11). Fast, zero installation, no binary compilation.
  - Cons: May use OS-level or vendor cloud transcription depending on OS configuration.
- **Option B: Local Whisper.cpp / Vosk**:
  - Pros: 100% offline.
  - Cons: Requires downloading multi-hundred MB weight models, C++ binary toolchains, high CPU/RAM spikes during inference on i5-1235U.
- **Decision: Hybrid Push-to-Talk Voice Layer**:
  - Push-to-talk uses the standard browser speech engine when available with clear visual consent.
  - If microphone access is denied, unsupported, or disabled, the HUD seamlessly falls back to the tested text input interface with explicit failure reason reporting.

## Invariants & Design Rules
1. **Audio Isolation**: Speech transcripts are treated as **untrusted user text**. They must flow through the standard pipeline:
   `Capture -> Transcribe -> Confirm/Edit -> Authenticate -> Plan -> Policy Gateway -> Approve (if required) -> Execute -> Verify -> Audit -> Report`
2. **Zero Execution Authority for Speech**: Spoken words cannot bypass the Policy Gateway or grant permissions.
3. **No Automatic Capture**: The microphone is never activated on page load. Capture begins only on explicit user click or keypress, and terminates immediately on stop/cancel or after 15 seconds max duration.
4. **Visual Privacy State**: The HUD presents unambiguous states: `IDLE`, `LISTENING` (bright pulsing red/cyan indicator), `PROCESSING`, `AWAITING_APPROVAL`, `EXECUTING`, and `COMPLETED`/`FAILED`.
