const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { createCanvas, Canvas, Image, ImageData } = require("@napi-rs/canvas");
const tf = require("@tensorflow/tfjs");
require("@tensorflow/tfjs-backend-wasm");
const faceapi = require("@vladmandic/face-api/dist/face-api.node-wasm.js");
const { getDb } = require("./tenantDb");

const MODEL_DIR = path.join(
  __dirname,
  "..",
  "node_modules",
  "@vladmandic",
  "face-api",
  "model"
);
const PUBLIC_MODEL_DIR = path.join(__dirname, "..", "public", "face-models");
const FACE_PROFILES_DIR = path.join(__dirname, "..", "data", "face_profiles");

const REQUIRED_MODEL_MANIFESTS = [
  "ssd_mobilenetv1_model-weights_manifest.json",
  "face_landmark_68_model-weights_manifest.json",
  "face_recognition_model-weights_manifest.json",
];

/** Flexible OR-match threshold (clamped 0.60–0.65). All inference stays on-device. */
const DISTANCE_THRESHOLD = clampNumber(
  Number(process.env.FACE_DISTANCE_THRESHOLD || 0.65),
  0.6,
  0.65
);
/** SSD Mobilenet min confidence — lower bound improves low-light bounding boxes. */
const FACE_DETECTION_MIN_CONFIDENCE = clampNumber(
  Number(process.env.FACE_DETECTION_MIN_CONFIDENCE || 0.4),
  0.2,
  0.9
);
/** Continuous-learning band: adapt gallery when match passes but distance is in this range. */
const ADAPTATION_DISTANCE_MIN = Number(process.env.FACE_ADAPTATION_DISTANCE_MIN || 0.52);
const ADAPTATION_DISTANCE_MAX = Math.min(
  Number(process.env.FACE_ADAPTATION_DISTANCE_MAX || 0.62),
  DISTANCE_THRESHOLD
);
/** Multi-embedding enrollment bounds (Apple-style reference gallery). */
const MIN_FACE_REFERENCES = 1;
const MAX_FACE_REFERENCES = 5;
/** Legacy export; live match decision uses DISTANCE_THRESHOLD (euclidean), not this value. */
const MATCH_SCORE_THRESHOLD = Number(process.env.FACE_MATCH_SCORE_THRESHOLD || 0);
const FACE_PROFILE_NOT_CONFIGURED_MESSAGE =
  "Face profile not configured by administrator.";
const NO_FACE_DETECTED_MESSAGE =
  "No face detected. Center your face in the frame and ensure adequate lighting.";

patchFaceApiCanvasEnvironment();

let modelsReady = false;
let modelsLoading = null;

/**
 * face-api's default node env uses `() => new Canvas()` with no args, which crashes
 * @napi-rs/canvas (undefined width/height → NumberExpected). Always return 1×1 minimum.
 */
function patchFaceApiCanvasEnvironment() {
  faceapi.env.monkeyPatch({
    Canvas,
    Image,
    ImageData,
    createCanvasElement: () => createCanvas(1, 1),
    createImageElement: () => new Image(),
  });
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function createFaceProcessingError(message, code = "NO_FACE_DETECTED") {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Dispose TF tensors immediately after inference (biometric privacy + leak prevention). */
function disposeTensorSafe(tensor) {
  try {
    if (tensor && typeof tensor.dispose === "function") {
      tensor.dispose();
    }
  } catch (error) {
    console.warn("[FACE] tensor dispose warning:", error.message);
  }
}

function isFaceProcessingError(error) {
  if (!error) return false;
  return (
    error.code === "NO_FACE_DETECTED" ||
    error.code === "FACE_MODEL_ERROR" ||
    error.code === "FACE_PROCESSING_FAILED"
  );
}

function ensureFaceProfilesDir() {
  fs.mkdirSync(FACE_PROFILES_DIR, { recursive: true });
}

function ensureFaceProfilesTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_face_profiles (
      user_id TEXT PRIMARY KEY,
      descriptors_json TEXT NOT NULL DEFAULT '[]',
      reference_images_json TEXT NOT NULL DEFAULT '[]',
      enrolled_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  migrateLegacyFaceProfilesSchema(db);
}

function migrateLegacyFaceProfilesSchema(db) {
  const columns = db.prepare(`PRAGMA table_info(user_face_profiles)`).all();
  const columnNames = columns.map((col) => col.name);
  if (!columnNames.length) return;

  if (columnNames.includes("descriptors_json")) {
    return;
  }

  if (!columnNames.includes("descriptor_json")) {
    return;
  }

  console.log("[FACE] Migrating user_face_profiles to multi-reference schema…");
  const rows = db.prepare(`SELECT * FROM user_face_profiles`).all();

  db.exec(`
    CREATE TABLE user_face_profiles_migrated (
      user_id TEXT PRIMARY KEY,
      descriptors_json TEXT NOT NULL DEFAULT '[]',
      reference_images_json TEXT NOT NULL DEFAULT '[]',
      enrolled_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const insert = db.prepare(
    `INSERT INTO user_face_profiles_migrated
     (user_id, descriptors_json, reference_images_json, enrolled_at, updated_at)
     VALUES (@user_id, @descriptors_json, @reference_images_json, @enrolled_at, @updated_at)`
  );

  for (const row of rows) {
    let legacyDescriptorRaw = [];
    try {
      legacyDescriptorRaw = JSON.parse(row.descriptor_json || "[]");
    } catch {
      legacyDescriptorRaw = [];
    }
    const descriptors = normalizeDescriptorsPayload(legacyDescriptorRaw);
    const legacyPath = row.reference_image_path || getLegacyReferenceImagePath(row.user_id);
    const imagePaths = legacyPath && fs.existsSync(legacyPath) ? [legacyPath] : [];
    insert.run({
      user_id: row.user_id,
      descriptors_json: JSON.stringify(descriptors),
      reference_images_json: JSON.stringify(imagePaths),
      enrolled_at: row.enrolled_at,
      updated_at: row.updated_at,
    });
  }

  db.exec(`DROP TABLE user_face_profiles`);
  db.exec(`ALTER TABLE user_face_profiles_migrated RENAME TO user_face_profiles`);
  console.log("[FACE] Multi-reference migration complete:", rows.length, "profile(s)");
}

function getLegacyReferenceImagePath(userId) {
  return path.join(FACE_PROFILES_DIR, `${String(userId || "").trim()}.jpg`);
}

function getUserFaceProfileDir(userId) {
  return path.join(FACE_PROFILES_DIR, String(userId || "").trim());
}

function getReferenceImagePath(userId, index = 0) {
  const id = String(userId || "").trim();
  const dirPath = path.join(getUserFaceProfileDir(id), `${index}.jpg`);
  if (fs.existsSync(dirPath) && fs.statSync(dirPath).size > 0) {
    return dirPath;
  }
  if (index === 0) {
    const legacyPath = getLegacyReferenceImagePath(id);
    if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).size > 0) {
      return legacyPath;
    }
  }
  return dirPath;
}

function normalizeDescriptorsPayload(parsed) {
  if (!parsed) return [];
  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    typeof parsed[0] === "number"
  ) {
    return [parsed];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry) => Array.isArray(entry) && entry.length > 0);
}

function parseJsonArray(raw, fallback = []) {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function countStoredReferenceImages(userId) {
  const id = String(userId || "").trim();
  let count = 0;
  for (let index = 0; index < MAX_FACE_REFERENCES; index += 1) {
    const imagePath = getReferenceImagePath(id, index);
    if (fs.existsSync(imagePath) && fs.statSync(imagePath).size > 0) {
      count += 1;
    }
  }
  const legacyPath = getLegacyReferenceImagePath(id);
  if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).size > 0 && count === 0) {
    return 1;
  }
  return count;
}

function referenceImageExists(userId) {
  return countStoredReferenceImages(userId) > 0;
}

function getFaceReferenceCount(userId) {
  const profile = getFaceProfile(userId);
  const descriptorCount = profile?.descriptors?.length || 0;
  const imageCount = countStoredReferenceImages(userId);
  return Math.max(descriptorCount, imageCount);
}

function buildFaceProfileNotConfiguredError() {
  const err = new Error(FACE_PROFILE_NOT_CONFIGURED_MESSAGE);
  err.code = "FACE_PROFILE_NOT_CONFIGURED";
  return err;
}

function getFaceModelsPathDefault() {
  return path.resolve(MODEL_DIR);
}

/**
 * Resolve on-device model weights: FACE_MODEL_DIR → public/face-models → node_modules fallback.
 * No external API calls; weights load from local disk only.
 */
function getFaceModelsPath() {
  const configured = process.env.FACE_MODEL_DIR;
  if (configured) {
    return path.resolve(configured);
  }
  const publicManifest = path.join(PUBLIC_MODEL_DIR, REQUIRED_MODEL_MANIFESTS[0]);
  if (fs.existsSync(publicManifest)) {
    return path.resolve(PUBLIC_MODEL_DIR);
  }
  return getFaceModelsPathDefault();
}

function assertFaceModelWeightsPresent(modelsPath = getFaceModelsPath()) {
  const missing = REQUIRED_MODEL_MANIFESTS.filter(
    (name) => !fs.existsSync(path.join(modelsPath, name))
  );
  if (missing.length) {
    console.error(
      "[FACE] ❌ CRITICAL: Missing manifest files on disk:",
      missing.join(", "),
      "| path:",
      modelsPath
    );
    throw createFaceProcessingError(
      `Face recognition model weights are missing: ${missing.join(", ")}`,
      "FACE_MODEL_ERROR"
    );
  }
}

/** Verify .bin shard files referenced by each manifest exist on disk. */
function verifyWeightBinFilesOnDisk(modelsPath) {
  const missing = [];

  for (const manifestName of REQUIRED_MODEL_MANIFESTS) {
    const manifestPath = path.join(modelsPath, manifestName);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      missing.push(`${manifestName} (unreadable: ${error.message})`);
      continue;
    }

    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    const shardPaths = entry?.paths || [];
    for (const binName of shardPaths) {
      const binPath = path.join(modelsPath, binName);
      if (!fs.existsSync(binPath)) {
        missing.push(binName);
      }
    }
  }

  return missing;
}

/**
 * Log and strictly verify face-api nets are loaded in memory (isLoaded === true).
 */
function logAndVerifyFaceModelsLoaded(modelsPath) {
  console.log("[FACE] Loading face-api models from path:", modelsPath);

  const missingBins = verifyWeightBinFilesOnDisk(modelsPath);
  if (missingBins.length) {
    console.error(
      "[FACE] ❌ CRITICAL: Missing or unreadable weight shard file(s):",
      missingBins.join(", "),
      "| expected under:",
      modelsPath
    );
  }

  console.log("[FACE] ssdMobilenetv1 loaded status:", faceapi.nets.ssdMobilenetv1.isLoaded);
  console.log("[FACE] faceLandmark68Net loaded status:", faceapi.nets.faceLandmark68Net.isLoaded);
  console.log(
    "[FACE] faceRecognitionNet loaded status:",
    faceapi.nets.faceRecognitionNet.isLoaded
  );

  const failedNets = [];
  if (!faceapi.nets.ssdMobilenetv1.isLoaded) {
    failedNets.push("ssdMobilenetv1");
    console.error(
      "[FACE] ❌ CRITICAL: ssdMobilenetv1 FAILED to initialize — detection will always fail. Path:",
      modelsPath
    );
  }
  if (!faceapi.nets.faceLandmark68Net.isLoaded) {
    failedNets.push("faceLandmark68Net");
    console.error(
      "[FACE] ❌ CRITICAL: faceLandmark68Net FAILED to initialize. Path:",
      modelsPath
    );
  }
  if (!faceapi.nets.faceRecognitionNet.isLoaded) {
    failedNets.push("faceRecognitionNet");
    console.error(
      "[FACE] ❌ CRITICAL: faceRecognitionNet FAILED to initialize. Path:",
      modelsPath
    );
  }

  if (failedNets.length || missingBins.length) {
    const detail = [
      failedNets.length ? `nets not loaded: ${failedNets.join(", ")}` : null,
      missingBins.length ? `missing shards: ${missingBins.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");

    throw createFaceProcessingError(
      `Face recognition models failed to initialize (${detail}).`,
      "FACE_MODEL_ERROR"
    );
  }

  console.log("[FACE] ✅ All face-api nets verified loaded in memory");
}

async function loadFaceModels() {
  if (modelsReady) return true;
  if (modelsLoading) return modelsLoading;

  const modelsPath = getFaceModelsPath();

  modelsLoading = (async () => {
    assertFaceModelWeightsPresent(modelsPath);
    console.log("[FACE] Loading face-api models from path:", modelsPath);

    await tf.setBackend("wasm");
    await tf.ready();
    patchFaceApiCanvasEnvironment();

    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelsPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelsPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelsPath);

    console.log(
      "[FACE] Private on-device models loaded | path:",
      modelsPath,
      "| minConfidence:",
      FACE_DETECTION_MIN_CONFIDENCE,
      "| distanceThreshold:",
      DISTANCE_THRESHOLD
    );

    modelsReady = true;
    return true;
  })();

  try {
    await modelsLoading;
    return true;
  } catch (error) {
    modelsLoading = null;
    modelsReady = false;
    console.error("[FACE] Model load failed:", error.message);
    if (error.stack) console.error(error.stack);
    if (isFaceProcessingError(error)) throw error;
    throw createFaceProcessingError(
      "Face recognition models could not be loaded. Please try again later.",
      "FACE_MODEL_ERROR"
    );
  }
}

/** Ensure weights exist on disk and all nets are loaded before detection. */
async function ensureFaceModelsReady() {
  const modelsPath = getFaceModelsPath();
  assertFaceModelWeightsPresent(modelsPath);
  await loadFaceModels();
  logAndVerifyFaceModelsLoaded(modelsPath);
  if (!modelsReady) {
    throw createFaceProcessingError(
      "Face recognition models are not ready.",
      "FACE_MODEL_ERROR"
    );
  }
  return true;
}

function parseBase64Image(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    throw new Error("image is required (base64 data URL or raw base64).");
  }

  const base64 = raw.includes(",") ? raw.split(",")[1] : raw;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) {
    throw new Error("Invalid base64 image payload.");
  }

  return { buffer };
}

/** Coerce to a strict positive integer for napi-rs / face-api (never pass undefined). */
function toPositiveInt(value, label = "dimension") {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) {
    throw createFaceProcessingError(
      `Invalid ${label}: image dimensions could not be determined.`,
      "FACE_PROCESSING_FAILED"
    );
  }
  return n;
}

/**
 * Normalize orientation/size for storage (JPEG on disk).
 */
async function normalizeImageBufferForFace(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer)
      .rotate()
      .resize({
        width: 640,
        height: 640,
        fit: "inside",
        withoutEnlargement: false,
      })
      .jpeg({ quality: 92 })
      .toBuffer({ resolveWithObject: true });

    const width = toPositiveInt(info.width, "width");
    const height = toPositiveInt(info.height, "height");

    if (width < 48 || height < 48) {
      throw createFaceProcessingError(
        "Image is too small or invalid. Please upload a larger, clearer JPG or PNG."
      );
    }

    return data;
  } catch (error) {
    if (isFaceProcessingError(error)) throw error;
    console.error("[FACE] Image normalization failed:", error.message);
    throw createFaceProcessingError(
      "Could not process the uploaded image. Please use a standard JPG or PNG photo.",
      "FACE_PROCESSING_FAILED"
    );
  }
}

/**
 * Canvas-equivalent pre-processing for low light: CLAHE + normalize + mild contrast boost.
 * Runs fully on-device before local face-api inference (no third-party services).
 */
async function preprocessImageBufferForDetection(imageBuffer) {
  try {
    const pipeline = sharp(imageBuffer)
      .rotate()
      .resize({
        width: 1024,
        height: 1024,
        fit: "inside",
        withoutEnlargement: false,
      });

    let processed = pipeline;
    if (typeof pipeline.clahe === "function") {
      processed = processed.clahe({ width: 8, height: 8 });
    }
    const jpegBuffer = await processed
      .normalize()
      .modulate({ brightness: 1.06, saturation: 1.05 })
      .jpeg({ quality: 92 })
      .toBuffer();

    if (!jpegBuffer?.length) {
      throw createFaceProcessingError(
        "Could not decode the image after pre-processing.",
        "FACE_PROCESSING_FAILED"
      );
    }

    return jpegBuffer;
  } catch (error) {
    if (isFaceProcessingError(error)) throw error;
    console.error("[FACE] preprocessImageBufferForDetection failed:", error.message);
    throw createFaceProcessingError(
      "Could not optimize the image for face detection. Please try again.",
      "FACE_PROCESSING_FAILED"
    );
  }
}

/** @deprecated alias — use preprocessImageBufferForDetection */
async function prepareStandardImageBuffer(imageBuffer) {
  return preprocessImageBufferForDetection(imageBuffer);
}

/** Reject blank raw RGB buffers before tensor conversion. */
function assertRawBufferHasVisualData(raw, width, height) {
  const channels = 3;
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  const sampleSize = Math.min(16, width, height);
  const startX = Math.max(0, centerX - Math.floor(sampleSize / 2));
  const startY = Math.max(0, centerY - Math.floor(sampleSize / 2));

  let luminanceSum = 0;
  for (let y = startY; y < startY + sampleSize && y < height; y++) {
    for (let x = startX; x < startX + sampleSize && x < width; x++) {
      const idx = (y * width + x) * channels;
      luminanceSum += raw[idx] + raw[idx + 1] + raw[idx + 2];
    }
  }

  if (luminanceSum < 24) {
    throw createFaceProcessingError(
      "Image appears blank or corrupted after pixel extraction. Please upload a different JPG or PNG photo.",
      "FACE_PROCESSING_FAILED"
    );
  }
}

/**
 * Build a 3D int32 tensor from Sharp raw RGB — bypasses @napi-rs/canvas for face-api on Node.js.
 */
async function buildFaceDetectionTensor(standardBuffer) {
  const { data: raw, info } = await sharp(standardBuffer).raw().toBuffer({ resolveWithObject: true });

  const height = toPositiveInt(info.height, "height");
  const width = toPositiveInt(info.width, "width");
  let channels = Number(info.channels) || 3;

  if (width < 48 || height < 48) {
    throw createFaceProcessingError(
      "Image is too small or invalid. Please upload a larger, clearer JPG or PNG."
    );
  }

  let rgbBytes = raw;
  if (channels === 4) {
    const rgbLength = height * width * 3;
    rgbBytes = Buffer.alloc(rgbLength);
    for (let i = 0, j = 0; i < raw.length && j < rgbLength; i += 4, j += 3) {
      rgbBytes[j] = raw[i];
      rgbBytes[j + 1] = raw[i + 1];
      rgbBytes[j + 2] = raw[i + 2];
    }
    channels = 3;
  } else if (channels !== 3) {
    throw createFaceProcessingError(
      `Unexpected image channels (${channels}); expected 3 (RGB).`,
      "FACE_PROCESSING_FAILED"
    );
  }

  const expectedBytes = height * width * 3;
  if (rgbBytes.length !== expectedBytes) {
    throw createFaceProcessingError(
      `Pixel buffer size mismatch (got ${rgbBytes.length}, expected ${expectedBytes}).`,
      "FACE_PROCESSING_FAILED"
    );
  }

  assertRawBufferHasVisualData(rgbBytes, width, height);

  const pixelData = new Int32Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i++) {
    pixelData[i] = rgbBytes[i];
  }

  const tensor = faceapi.tf.tensor3d(pixelData, [height, width, 3], "int32");
  console.log(`[FACE] Detection tensor ready: [${height}, ${width}, 3] (int32 RGB)`);
  return tensor;
}

/**
 * Run SSD Mobilenet on a pure Tensor3D (no canvas) — native Node.js path for face-api + TF.js.
 */
async function runFaceDetection(standardBuffer) {
  let tensor = null;
  const options = new faceapi.SsdMobilenetv1Options({
    minConfidence: FACE_DETECTION_MIN_CONFIDENCE,
  });

  try {
    tensor = await buildFaceDetectionTensor(standardBuffer);

    let detection = await faceapi
      .detectSingleFace(tensor, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    if (!detection) {
      const detections = await faceapi
        .detectAllFaces(tensor, options)
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (detections?.length) {
        detection = detections.reduce((best, current) =>
          (current.detection?.score || 0) > (best.detection?.score || 0) ? current : best
        );
        console.log(
          `[FACE] detectSingleFace empty; using best of ${detections.length} face(s), score=${(
            detection.detection?.score || 0
          ).toFixed(3)} | minConfidence=${FACE_DETECTION_MIN_CONFIDENCE}`
        );
      }
    } else {
      console.log(
        `[FACE] detectSingleFace score=${(detection.detection?.score || 0).toFixed(3)} minConfidence=${FACE_DETECTION_MIN_CONFIDENCE} (local tensor)`
      );
    }

    if (!detection?.descriptor?.length) {
      throw createFaceProcessingError(NO_FACE_DETECTED_MESSAGE, "NO_FACE_DETECTED");
    }

    return detection;
  } catch (error) {
    console.error("[FACE] tensor detection error:", error.message);
    if (error.stack) console.error(error.stack);
    if (isFaceProcessingError(error)) throw error;
    throw createFaceProcessingError(NO_FACE_DETECTED_MESSAGE, "NO_FACE_DETECTED");
  } finally {
    disposeTensorSafe(tensor);
    tensor = null;
  }
}

/**
 * Local inference pipeline: preprocess → SSD detect → 128-D Float32 descriptor.
 * Returns descriptor array and preprocessed buffer (for optional gallery storage).
 */
async function extractFaceDescriptorFromBuffer(imageBuffer) {
  try {
    await ensureFaceModelsReady();

    const preprocessedBuffer = await preprocessImageBufferForDetection(imageBuffer);
    const detection = await runFaceDetection(preprocessedBuffer);

    if (!detection?.descriptor?.length) {
      throw createFaceProcessingError(NO_FACE_DETECTED_MESSAGE, "NO_FACE_DETECTED");
    }

    const descriptor = Array.from(detection.descriptor);
    return {
      descriptor,
      preprocessedBuffer,
    };
  } catch (error) {
    if (isFaceProcessingError(error)) throw error;
    console.error("[FACE] extractFaceDescriptorFromBuffer failed:", error.message);
    throw createFaceProcessingError(
      "Could not process the face image locally. Please try another capture.",
      "FACE_PROCESSING_FAILED"
    );
  }
}

function descriptorToFloat32(descriptor) {
  return new Float32Array(descriptor);
}

/**
 * Compare one reference vs live descriptor using euclidean distance.
 * Match when distance < DISTANCE_THRESHOLD (default 0.65).
 */
function evaluateFaceMatch(referenceDescriptor, probeDescriptor) {
  const maxDistance = DISTANCE_THRESHOLD;
  const distance = faceapi.euclideanDistance(
    descriptorToFloat32(referenceDescriptor),
    descriptorToFloat32(probeDescriptor)
  );
  const isMatch = distance < maxDistance;
  const similarity = Math.max(0, Math.min(100, (1 - distance / maxDistance) * 100));

  return {
    distance,
    similarity,
    match: isMatch,
    maxDistance,
  };
}

/**
 * Logical OR match: success if ANY stored reference is below threshold.
 */
function evaluateFaceMatchAgainstReferences(referenceDescriptors, probeDescriptor) {
  const references = (referenceDescriptors || []).filter(
    (descriptor) => Array.isArray(descriptor) && descriptor.length > 0
  );
  const maxDistance = DISTANCE_THRESHOLD;

  if (!references.length) {
    return {
      distance: Infinity,
      similarity: 0,
      match: false,
      maxDistance,
      references_compared: 0,
      matched_reference_index: null,
      best_reference_index: null,
    };
  }

  let bestDistance = Infinity;
  let bestIndex = 0;
  let bestSimilarity = 0;

  for (let index = 0; index < references.length; index += 1) {
    const result = evaluateFaceMatch(references[index], probeDescriptor);
    if (result.distance < bestDistance) {
      bestDistance = result.distance;
      bestSimilarity = result.similarity;
      bestIndex = index;
    }
    if (result.match) {
      return {
        distance: result.distance,
        similarity: result.similarity,
        match: true,
        maxDistance,
        references_compared: references.length,
        matched_reference_index: index,
        best_reference_index: index,
      };
    }
  }

  return {
    distance: bestDistance,
    similarity: bestSimilarity,
    match: false,
    maxDistance,
    references_compared: references.length,
    matched_reference_index: null,
    best_reference_index: bestIndex,
  };
}

/** True when verification passed but lighting/pose/clothing likely shifted (adaptive learning band). */
function shouldAdaptGalleryFromVerification(distance) {
  if (!Number.isFinite(distance)) return false;
  return distance >= ADAPTATION_DISTANCE_MIN && distance < ADAPTATION_DISTANCE_MAX;
}

/**
 * FaceID continuous learning: append live embedding or cycle out oldest slot at gallery capacity.
 */
async function integrateLiveFaceEmbedding(userId, descriptor, imageBuffer) {
  const id = String(userId || "").trim();
  if (!id || !Array.isArray(descriptor) || !descriptor.length) {
    throw new Error("user_id and descriptor are required for gallery adaptation.");
  }
  if (!imageBuffer?.length) {
    throw new Error("image buffer is required for gallery adaptation.");
  }

  const profile = getFaceProfile(id);
  const descriptors = [...(profile?.descriptors || [])];
  const imagePaths = [...(profile?.reference_image_paths || [])];
  const jpegBuffer = await normalizeImageBufferForFace(imageBuffer);

  let action = "appended";

  if (descriptors.length >= MAX_FACE_REFERENCES) {
    const oldestPath = imagePaths.shift();
    descriptors.shift();
    if (oldestPath) {
      try {
        if (fs.existsSync(oldestPath)) {
          fs.unlinkSync(oldestPath);
        }
      } catch {
        /* ignore */
      }
    }
    action = "cycled_oldest";
  }

  const slotIndex = descriptors.length;
  const imagePath = writeReferenceImageFile(id, slotIndex, jpegBuffer);
  descriptors.push(descriptor);
  imagePaths.push(imagePath);

  const record = persistFaceProfileRecord(
    id,
    descriptors,
    imagePaths,
    profile?.enrolled_at
  );

  console.log(
    `[FACE] Continuous learning ${action} | user=${id} | slot=${slotIndex} | gallery=${record.reference_count}/${MAX_FACE_REFERENCES}`
  );

  return {
    action,
    slot_index: slotIndex,
    reference_count: record.reference_count,
    reference_image_path: imagePath,
  };
}

function getFaceProfile(userId) {
  ensureFaceProfilesTable();
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM user_face_profiles WHERE user_id = ?`)
    .get(String(userId || ""));
  if (!row) return null;

  const descriptors = normalizeDescriptorsPayload(parseJsonArray(row.descriptors_json));
  const reference_image_paths = parseJsonArray(row.reference_images_json).filter(Boolean);

  return {
    user_id: row.user_id,
    descriptors,
    descriptor: descriptors[0] || [],
    reference_image_paths,
    reference_image_path: reference_image_paths[0] || null,
    reference_count: descriptors.length,
    enrolled_at: row.enrolled_at,
    updated_at: row.updated_at,
  };
}

function persistFaceProfileRecord(userId, descriptors, imagePaths, enrolledAt) {
  ensureFaceProfilesTable();
  const id = String(userId || "").trim();
  const now = new Date().toISOString();
  const db = getDb();
  const record = {
    user_id: id,
    descriptors_json: JSON.stringify(descriptors),
    reference_images_json: JSON.stringify(imagePaths),
    enrolled_at: enrolledAt || now,
    updated_at: now,
  };

  const existing = getFaceProfile(id);
  if (existing) {
    db.prepare(
      `UPDATE user_face_profiles
       SET descriptors_json = @descriptors_json,
           reference_images_json = @reference_images_json,
           updated_at = @updated_at
       WHERE user_id = @user_id`
    ).run(record);
  } else {
    db.prepare(
      `INSERT INTO user_face_profiles (user_id, descriptors_json, reference_images_json, enrolled_at, updated_at)
       VALUES (@user_id, @descriptors_json, @reference_images_json, @enrolled_at, @updated_at)`
    ).run(record);
  }

  return {
    ...record,
    descriptors,
    reference_image_paths: imagePaths,
    reference_count: descriptors.length,
  };
}

function writeReferenceImageFile(userId, index, imageBuffer) {
  ensureFaceProfilesDir();
  const profileDir = getUserFaceProfileDir(userId);
  fs.mkdirSync(profileDir, { recursive: true });
  const imagePath = path.join(profileDir, `${index}.jpg`);
  fs.writeFileSync(imagePath, imageBuffer);
  return imagePath;
}

async function appendFaceReference(userId, imageBuffer) {
  const id = String(userId || "").trim();
  const profile = getFaceProfile(id);
  const descriptors = [...(profile?.descriptors || [])];
  const imagePaths = [...(profile?.reference_image_paths || [])];

  if (descriptors.length >= MAX_FACE_REFERENCES) {
    throw new Error(
      `Maximum of ${MAX_FACE_REFERENCES} reference face images allowed per user. Remove or replace references before adding more.`
    );
  }

  await ensureFaceModelsReady();
  const { descriptor, preprocessedBuffer } = await extractFaceDescriptorFromBuffer(imageBuffer);
  const jpegBuffer = await normalizeImageBufferForFace(preprocessedBuffer || imageBuffer);
  const slotIndex = descriptors.length;
  const imagePath = writeReferenceImageFile(id, slotIndex, jpegBuffer);

  descriptors.push(descriptor);
  imagePaths.push(imagePath);

  const record = persistFaceProfileRecord(
    id,
    descriptors,
    imagePaths,
    profile?.enrolled_at
  );

  return {
    user_id: id,
    slot_index: slotIndex,
    reference_image_path: imagePath,
    reference_image_paths: imagePaths,
    reference_count: record.reference_count,
    has_face_profile: record.reference_count >= MIN_FACE_REFERENCES,
  };
}

async function registerAdminFaceProfiles(userId, imageBuffers, { replace = false } = {}) {
  const id = String(userId || "").trim();
  if (!id) {
    throw new Error("user_id is required.");
  }

  const buffers = (imageBuffers || []).filter((buffer) => buffer?.length);
  if (!buffers.length) {
    throw new Error("At least one face image file is required.");
  }

  if (replace) {
    removeFaceProfileForUser(id);
  }

  const existingCount = getFaceProfile(id)?.descriptors?.length || 0;
  if (existingCount + buffers.length > MAX_FACE_REFERENCES) {
    throw new Error(
      `Cannot store more than ${MAX_FACE_REFERENCES} reference images per user (current: ${existingCount}, uploading: ${buffers.length}).`
    );
  }

  const results = [];
  for (const buffer of buffers) {
    results.push(await appendFaceReference(id, buffer));
  }

  const profile = getFaceProfile(id);
  console.log(
    "[FACE] Admin registered",
    buffers.length,
    "reference embedding(s) for user:",
    id,
    "| total:",
    profile?.reference_count || 0
  );

  return {
    user_id: id,
    reference_count: profile?.reference_count || 0,
    reference_image_paths: profile?.reference_image_paths || [],
    has_face_profile: (profile?.reference_count || 0) >= MIN_FACE_REFERENCES,
    slots: results,
  };
}

/**
 * Admin uploads one or more reference faces (JPG/PNG) under data/face_profiles/{userId}/{index}.jpg
 */
async function registerAdminFaceProfile(userId, imageBuffer, options = {}) {
  if (Array.isArray(imageBuffer)) {
    return registerAdminFaceProfiles(userId, imageBuffer, options);
  }

  try {
    if (options.replace) {
      return registerAdminFaceProfiles(userId, [imageBuffer], { replace: true });
    }
    return appendFaceReference(userId, imageBuffer);
  } catch (error) {
    if (isFaceProcessingError(error)) throw error;
    console.error("[FACE] registerAdminFaceProfile failed:", error.message);
    throw createFaceProcessingError(
      "Could not register the reference face image. Please try another photo.",
      "FACE_PROCESSING_FAILED"
    );
  }
}

async function rebuildMissingDescriptorsFromImages(userId) {
  const id = String(userId || "").trim();
  const imagePaths = [];
  const descriptors = [];

  for (let index = 0; index < MAX_FACE_REFERENCES; index += 1) {
    const imagePath = getReferenceImagePath(id, index);
    if (!fs.existsSync(imagePath) || fs.statSync(imagePath).size === 0) {
      continue;
    }
    const jpegBuffer = fs.readFileSync(imagePath);
    const { descriptor } = await extractFaceDescriptorFromBuffer(jpegBuffer);
    descriptors.push(descriptor);
    imagePaths.push(imagePath);
  }

  if (!descriptors.length) {
    const legacyPath = getLegacyReferenceImagePath(id);
    if (fs.existsSync(legacyPath) && fs.statSync(legacyPath).size > 0) {
      const jpegBuffer = fs.readFileSync(legacyPath);
      const { descriptor } = await extractFaceDescriptorFromBuffer(jpegBuffer);
      descriptors.push(descriptor);
      imagePaths.push(legacyPath);
    }
  }

  if (descriptors.length) {
    const profile = getFaceProfile(id);
    persistFaceProfileRecord(id, descriptors, imagePaths, profile?.enrolled_at);
  }

  return descriptors;
}

async function getReferenceDescriptors(userId) {
  const id = String(userId || "").trim();
  if (!referenceImageExists(id)) {
    throw buildFaceProfileNotConfiguredError();
  }

  let profile = getFaceProfile(id);
  if (profile?.descriptors?.length) {
    return profile.descriptors;
  }

  await ensureFaceModelsReady();
  const descriptors = await rebuildMissingDescriptorsFromImages(id);
  if (!descriptors.length) {
    throw buildFaceProfileNotConfiguredError();
  }
  return descriptors;
}

/**
 * Verify webcam capture against all administrator-provided references (logical OR match).
 * On-device only: preprocess → local SSD + embedding → OR gallery match → optional adaptation.
 */
async function verifyUserFace(userId, imageInput) {
  const id = String(userId || "").trim();
  if (!id) {
    throw new Error("user_id is required for face verification.");
  }

  if (!referenceImageExists(id)) {
    throw buildFaceProfileNotConfiguredError();
  }

  try {
    await ensureFaceModelsReady();

    const referenceDescriptors = await getReferenceDescriptors(id);

    const probeBuffer = parseBase64Image(imageInput).buffer;
    const { descriptor: probeDescriptor, preprocessedBuffer } =
      await extractFaceDescriptorFromBuffer(probeBuffer);

    const {
      distance,
      similarity,
      match,
      maxDistance,
      references_compared,
      matched_reference_index,
      best_reference_index,
    } = evaluateFaceMatchAgainstReferences(referenceDescriptors, probeDescriptor);

    let gallery_adapted = false;
    let adaptation = null;

    if (match && shouldAdaptGalleryFromVerification(distance)) {
      try {
        adaptation = await integrateLiveFaceEmbedding(
          id,
          probeDescriptor,
          preprocessedBuffer || probeBuffer
        );
        gallery_adapted = true;
        console.log(
          `[FACE] Environment shift detected (distance=${distance.toFixed(4)}); gallery updated via ${adaptation.action}`
        );
      } catch (adaptError) {
        console.warn(
          "[FACE] Continuous learning skipped (verification still successful):",
          adaptError.message
        );
      }
    }

    console.log(
      `[FACE] Verify user=${id} | refs=${references_compared} | distance=${Number.isFinite(distance) ? distance.toFixed(4) : "n/a"} | maxDistance=${maxDistance} | adaptBand=[${ADAPTATION_DISTANCE_MIN},${ADAPTATION_DISTANCE_MAX}) | similarity=${similarity.toFixed(1)}% | match=${match} | adapted=${gallery_adapted} | matchedRef=${matched_reference_index ?? "none"} (local-only)`
    );

    return {
      match,
      match_score: Math.round(similarity * 10) / 10,
      distance,
      threshold: maxDistance,
      max_distance: maxDistance,
      references_compared,
      matched_reference_index,
      best_reference_index,
      gallery_adapted,
      adaptation,
      private_local_inference: true,
    };
  } catch (error) {
    if (isFaceProcessingError(error)) throw error;
    console.error("[FACE] verifyUserFace failed:", error.message);
    throw createFaceProcessingError(
      "Face verification could not be completed. Please try again.",
      "FACE_PROCESSING_FAILED"
    );
  }
}

function removeFaceProfileForUser(userId) {
  const id = String(userId || "").trim();
  if (!id) return;

  ensureFaceProfilesTable();

  const profile = getFaceProfile(id);
  const paths = new Set([
    ...(profile?.reference_image_paths || []),
    getLegacyReferenceImagePath(id),
  ]);

  for (let index = 0; index < MAX_FACE_REFERENCES; index += 1) {
    paths.add(getReferenceImagePath(id, index));
  }

  for (const imagePath of paths) {
    try {
      if (imagePath && fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    } catch {
      /* ignore missing or locked files */
    }
  }

  try {
    const profileDir = getUserFaceProfileDir(id);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }

  const db = getDb();
  db.prepare(`DELETE FROM user_face_profiles WHERE user_id = ?`).run(id);
}

module.exports = {
  verifyUserFace,
  registerAdminFaceProfile,
  registerAdminFaceProfiles,
  removeFaceProfileForUser,
  loadFaceModels,
  ensureFaceModelsReady,
  getFaceProfile,
  getFaceReferenceCount,
  getReferenceImagePath,
  getReferenceDescriptors,
  referenceImageExists,
  evaluateFaceMatch,
  evaluateFaceMatchAgainstReferences,
  isFaceProcessingError,
  createFaceProcessingError,
  MATCH_SCORE_THRESHOLD,
  DISTANCE_THRESHOLD,
  FACE_DETECTION_MIN_CONFIDENCE,
  ADAPTATION_DISTANCE_MIN,
  ADAPTATION_DISTANCE_MAX,
  MIN_FACE_REFERENCES,
  MAX_FACE_REFERENCES,
  FACE_PROFILE_NOT_CONFIGURED_MESSAGE,
  NO_FACE_DETECTED_MESSAGE,
  preprocessImageBufferForDetection,
  integrateLiveFaceEmbedding,
  shouldAdaptGalleryFromVerification,
};
