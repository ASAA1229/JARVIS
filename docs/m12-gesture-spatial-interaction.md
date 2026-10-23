# M12 — Gesture & Spatial Interaction

**Status:** PARTIAL — local camera and landmark preview foundation implemented; physical acceptance and action integration are not complete. Overall JARVIS acceptance remains BLOCKED.

## Implemented in this branch

- Camera starts only after explicit **ENABLE CAMERA** input. Camera defaults off. Capture requests video only (`audio: false`) and shows a persistent active indicator and mirrored preview.
- Permission denial, missing device, device loss, inference failure, tab visibility change, page shutdown, and explicit stop report an off/error state. Stop closes the worker, stops every media track, detaches the video stream, clears overlays, and cancels the frame loop.
- MediaPipe Tasks Vision 1.1.1 and the Apache-2.0 full Hand Landmarker float16 model are locally served. Inference runs in a dedicated worker using CPU delegate; the HUD sends at most one downscaled-source `ImageBitmap` frame at a time and closes it after inference. No frame recording, persistence, application-server upload, or cloud AI transmission is implemented.
- Supported visual recognizers: open palm, point/hover, pinch, horizontal swipe, and neutral. They use normalized landmarks, mirrored cursor mapping, smoothing, dwell, cooldown, a neutral rearm state, and duplicate suppression. These are heuristic preview recognizers, not calibrated production gestures.
- The cursor can only highlight fixed JARVIS HUD targets. A versioned intent validator accepts only known gesture names, confidence 0.80–1.0, recent timestamps, UUIDs, and a short target allowlist.
- The preview identifies a proposed gesture/action and the current HUD target. No gesture invokes `/api/request`, identity, PolicyGateway, approvals, adapters, shell commands, desktop automation, or file operations. No gesture-based approval or deletion exists.
- Existing text and push-to-talk voice remain available and separate from video permission. No voice arbitration or combined voice/gesture execution path is implemented.

## Runtime and dependency evidence

- Tracking library: `@mediapipe/tasks-vision@1.1.1` (exact pinned version, Apache-2.0, no package runtime dependencies). The self-hosted IIFE browser bundle is 156,165 bytes. Three WASM alternatives total approximately 39.7 MB on disk; the runtime requests a compatible local variant.
- Model: full float16 hand landmark bundle, 7,819,105 bytes, SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`. The model card identifies Apache-2.0, experimental use, and limitations under occlusion, blur, and challenging lighting.
- All runtime files are same-origin and the server CSP restricts `connect-src` to `'self'`. The SDK's upstream privacy notice describes performance/utilization metrics; this implementation blocks external requests and the browser E2E test checks for any request leaving the loopback origin during camera operation. The CSP has a narrow `wasm-unsafe-eval` exception for WebAssembly compilation.
- MediaPipe's own benchmark reports 17.12 ms CPU / 12.27 ms GPU on a Pixel 6. Those are not JARVIS laptop measurements and are not used as acceptance evidence.

## Evidence classification

| Evidence | Status | Boundary |
|---|---|---|
| Strict intent schema, stale/unknown rejection, dwell/debounce/rearm, bounded geometry rules | PASS — 7/7 unit tests | Synthetic landmark coordinates; not a representative human accuracy sample |
| HTTP asset routes and restrictive CSP | PASS — local Edge browser smoke | CSP only allows the approved same-origin runtime assets |
| Camera off by default, video-only stream, stop/release, permission denial and device-loss handling | PASS — fake camera and simulated denial/loss | Not physical webcam or Windows camera privacy-setting acceptance |
| Worker inference and no third-party network requests | PASS — fake-camera CPU inference and request monitor | No physical hand tracking or hardware performance result |
| Gesture-to-policy authorization, task approval, adapter and outcome verification | Not implemented | Gesture proposals are preview-only, intentionally isolated from backend actions |
| Voice/gesture arbitration, deletion confirmation, target-change and session-revocation invalidation | Not implemented | No pending executable gesture task exists in this stage |

## Unmet acceptance criteria

- No measured laptop camera latency, median/p95 gesture-to-highlight latency, precision, false-activation rate, CPU/RAM, or sustained-operation growth. The required representative sample and 30-minute test have not been performed.
- No physical webcam acceptance on the target MSI/Windows 11. Browser fake-device checks are not physical acceptance.
- Gestures do not yet navigate panels, scroll/zoom supported content, select/confirm controls, arbitrate with voice, or route a typed proposal through authenticated PolicyGateway flow.
- No approval-bound gesture actions, deletion adapter/confirmation flow, or gesture-audit event exists.
- Multiple simultaneous hands pause the recognizer as ambiguous; calibration, handedness-specific testing, occlusion recovery, and demographic/lighting evaluation remain outstanding.
- Formal browser compatibility beyond the Edge smoke test remains unverified.

## Manual acceptance

Follow [M12 webcam and gesture verification](m12-gesture-manual-verification.md) before enabling this interface for any action integration. Keep all actions preview-only until accuracy/false-activation thresholds and end-to-end security gates have evidence.
