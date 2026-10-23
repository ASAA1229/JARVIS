# ADR-006: Same-Origin Local Hand Tracking Foundation

## Status

Accepted for the M12 camera and visual-tracking foundation. Gesture-to-action integration remains deferred.

## Context

M12 needs an opt-in laptop webcam path that can process hand landmarks locally, retain the existing browser HUD, and never become an authorization or adapter path. The target is a Windows 11 laptop with an Intel Core i5-1235U, 16 GB RAM, and integrated graphics. The target webcam and end-to-end gesture latency have not been physically benchmarked in this environment.

## Decision

- Use `@mediapipe/tasks-vision@1.1.1`, pinned exactly in `package.json` and `package-lock.json`. The installed package reports Apache-2.0, has no runtime package dependencies, and its self-hosted IIFE browser bundle is 156,165 bytes. Its installed WASM alternatives are 13,519,922, 13,519,940, and 12,627,509 bytes; the runtime chooses a compatible local variant. The npm install audit reported zero vulnerabilities.
- Use Google's full Hand Landmarker float16 bundle at `src/companion/models/hand_landmarker.task` (7,819,105 bytes; SHA-256 `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`). Its model card states Apache-2.0. It detects 21 hand landmarks. The model card describes experimental use and limitations under occlusion, blur, and difficult lighting; this implementation therefore provides previews only.
- Self-host the pinned library bundle, WASM files, and model from explicit same-origin routes. No CDN or runtime model download is used. The repository CSP permits only same-origin network connections (`connect-src 'self'`); the narrow `wasm-unsafe-eval` allowance supports the local WebAssembly runtime while JavaScript `eval` remains disallowed.
- Run inference in a classic worker because the MediaPipe Web runtime loads its WebAssembly glue through `importScripts`; this keeps CPU inference off the HUD thread.
- Initialize camera and inference only after the user presses **ENABLE CAMERA**. Request video without audio, show a persistent red active state and local preview, process frames in a worker, and stop media tracks, worker, and render loop on stop, tab hiding, page exit, camera loss, or inference failure.
- Keep inference data in the browser worker. Only normalized landmarks and bounded preview events cross the worker boundary; frames are never written, audited, or sent to JARVIS. The gesture modules import no backend, identity, policy, or adapter code and do not submit requests.
- Use a fixed, strict gesture-intent schema with a one-second age limit, confidence floor, unique UUID, and HUD-only target allowlist. Current geometry scores are heuristic margins, not model probabilities. They do not authorize or execute anything.

## Telemetry and network review

MediaPipe's current online privacy notice describes collection of utilization/performance metrics and asks app developers to obtain informed consent. A Google maintainer response on issue #6306 (June 2026) stated that the then-current Web SDK did not include telemetry and that outgoing requests could be blocked while continuing to use the SDK. Because these upstream statements may vary by package release, JARVIS does not rely on the SDK being silent: same-origin CSP blocks external connections, and the browser smoke test checks that camera startup causes no external requests. Raw camera frames remain local either way. Recheck this behavior when upgrading MediaPipe.

## Alternatives

- **Remote vision API:** rejected because it would transmit camera frames and violate the local-processing requirement.
- **MediaPipe CDN/model URLs:** rejected because they add runtime network dependency and bypass the local-only asset boundary.
- **Hand-rolled image processing:** rejected for this milestone because reliable landmark inference would require implementing and validating a trained vision model.
- **HUD-only without a tracker:** retained as a safe fallback if local model/runtime initialization fails; camera remains off and the HUD reports the failure.

## Consequences and limitations

- A user can use the tracking foundation from the loopback HUD on a browser that supports `getUserMedia`, workers, and WebAssembly. Automated browser coverage uses Microsoft Edge with a fake camera. Physical Windows webcam, hardware performance, gesture precision, false activations, and accessibility acceptance remain outstanding.
- Hand preview, reticle, target highlight, and gesture proposal are visual-only. No gesture can select/approve/execute a task, move the desktop cursor, perform global scrolling, or manipulate arbitrary applications.
- Voice remains its existing push-to-talk lifecycle. Combined voice/gesture arbitration, policy routing, approval binding, action execution, deletion confirmation, and outcome verification are future M12 stages.

## References

- [MediaPipe Hand Landmarker for Web](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker/web_js)
- [Hand Landmarker model details and model card](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
- [MediaPipe Tasks privacy notice](https://developers.google.com/edge/mediapipe/solutions/tasks#mediapipe_tasks_privacy_notice)
- [MediaPipe Web telemetry clarification](https://github.com/google-ai-edge/mediapipe/issues/6306)
- [MediaPipe source license](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE)
