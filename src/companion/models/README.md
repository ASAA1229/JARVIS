# Hand Landmarker Model

JARVIS uses Google's MediaPipe Hand Landmarker full float16 task bundle, version `1`, for on-device landmark inference.

- Source: <https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task>
- Model card: <https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20%28Lite_Full%29%20with%20Fairness%20Oct%202021.pdf>
- License: Apache License 2.0, as stated in the model card.
- File: `hand_landmarker.task` (7,819,105 bytes)
- SHA-256: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`

The bundle is served by the local JARVIS server. It is not downloaded from a CDN at runtime. If replacing it, verify the source, license, hash, model compatibility, and performance before updating the digest and acceptance evidence.

The upstream model card describes this model as experimental, says it is not evaluated for difficult real-world camera conditions, and lists gloves/occlusion among out-of-scope conditions. Do not use the model output as an authorization signal or for consequential actions.
