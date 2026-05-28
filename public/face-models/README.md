# On-device FaceID model weights (optional)

Place local face-api.js weight manifests and `.bin` shards here to load from `public/face-models` instead of `node_modules`.

Required files (copy from `node_modules/@vladmandic/face-api/model/`):

- `ssd_mobilenetv1_model-weights_manifest.json` (+ shards)
- `face_landmark_68_model-weights_manifest.json` (+ shards)
- `face_recognition_model-weights_manifest.json` (+ shards)

Or set `FACE_MODEL_DIR` in `.env` to a custom directory. All inference runs locally; no third-party biometric APIs.
