# M12 Webcam and Gesture Manual Verification

This guide is a physical acceptance checklist, not evidence that the checks have already passed. Record the exact commit, laptop model, Windows build, Edge version, room lighting, camera distance, sample size, latency procedure, CPU/RAM, and test duration.

## Privacy and lifecycle

1. Open JARVIS from the loopback origin. Confirm **CAMERA OFF** and no camera indicator before interaction. Confirm the microphone state remains governed by the existing mute/push-to-talk controls.
2. Press **ENABLE CAMERA** and grant browser camera permission. Confirm the persistent red **CAMERA ACTIVE — LOCAL PROCESSING** label, visible local preview, and Windows camera privacy indicator. Confirm the preview is mirrored.
3. In Edge DevTools Network, verify the model, WASM, and worker load only from the loopback JARVIS origin. Confirm no request leaves the origin, no raw frame is posted to any `/api/*` route, and no frame is written to disk or audit files.
4. Press **STOP CAMERA**. Confirm the browser indicator turns off, preview clears, and camera is released in Windows Settings. Repeat after switching tabs, navigating away, closing the tab, ending the webcam device, denying permission, and disconnecting the camera.
5. Deny permission and test with no camera attached or the camera already used by another app. Each condition must leave camera status off and keep text/voice controls usable.

## Recognition feasibility

1. After privacy lifecycle checks, hold one unobstructed hand about 50–80 cm from the camera in ordinary indoor lighting. Use a documented range of skin tones, hand sizes, left/right hands, and lighting/distance conditions only with consenting participants.
2. Collect at least 100 deliberate examples each for open palm, point, pinch, swipe left/right, and neutral, plus at least 30 minutes of ordinary motion/rest with no deliberate gesture. Record false recognitions and missed/incorrect targets.
3. Measure capture-to-reticle highlight timestamps using browser performance timestamps. Report median and p95 separately from inference duration. Target median ≤150 ms, p95 ≤300 ms, ≥95% selection precision, and ≤1 false activation per 30-minute session. These thresholds are not currently demonstrated.
4. Watch Task Manager for CPU and memory over a 30-minute active session and after repeated start/stop, tab hiding, and camera disconnect. Confirm there are no stuck camera tracks, growing workers, duplicated events, or continuously running loop while camera is off.

## Security and fallback

- Confirm gestures only move the reticle, highlight allowlisted JARVIS HUD elements, and show preview proposals. They must never trigger an API call, system action, approval, deletion, shell command, or global pointer/keyboard automation.
- Confirm text input and existing push-to-talk transcript review work whether camera permission is granted, denied, or stopped.
- Do not enable gesture-based action integration until exact-target binding, stale/replayed intent rejection, voice arbitration, session expiry/revocation, PolicyGateway, approval, adapter allowlist, verification, and audit have independent tests.
