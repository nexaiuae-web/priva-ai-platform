const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;

const FACE_PROFILES_DIR = path.join(__dirname, "..", "data", "face_profiles");
const FACE_CLOUDINARY_FOLDER_PREFIX =
  String(process.env.CLOUDINARY_FACE_FOLDER || "priva/face_profiles").replace(/^\/+|\/+$/g, "") ||
  "priva/face_profiles";

let cloudinaryConfigured = null;

function isCloudinaryConfigured() {
  if (cloudinaryConfigured !== null) {
    return cloudinaryConfigured;
  }
  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
  cloudinaryConfigured = Boolean(cloudName && apiKey && apiSecret);
  if (cloudinaryConfigured) {
    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
  }
  return cloudinaryConfigured;
}

function buildFaceReferencePublicId(userId, index = 0) {
  const id = String(userId || "").trim();
  const slot = Math.max(0, Number.parseInt(index, 10) || 0);
  return `${FACE_CLOUDINARY_FOLDER_PREFIX}/${id}/${slot}`;
}

function parseJsonArray(raw, fallback = []) {
  if (!raw) return fallback;
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Normalize stored reference (legacy local path, URL string, or { url, public_id }).
 */
function normalizeReferenceEntry(entry) {
  if (!entry) return null;

  if (typeof entry === "object" && !Array.isArray(entry)) {
    const url = String(entry.url || entry.secure_url || "").trim() || null;
    const public_id = String(entry.public_id || "").trim() || null;
    const localPath = String(entry.localPath || entry.local_path || "").trim() || null;
    if (!url && !public_id && !localPath) return null;
    return { url, public_id, localPath };
  }

  const value = String(entry).trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    return { url: value, public_id: extractPublicIdFromCloudinaryUrl(value), localPath: null };
  }

  return { url: null, public_id: null, localPath: value };
}

function extractPublicIdFromCloudinaryUrl(url) {
  try {
    const parsed = new URL(url);
    const marker = "/upload/";
    const uploadIndex = parsed.pathname.indexOf(marker);
    if (uploadIndex === -1) return null;
    let remainder = parsed.pathname.slice(uploadIndex + marker.length);
    remainder = remainder.replace(/^v\d+\//, "");
    remainder = remainder.replace(/\.[a-z0-9]+$/i, "");
    return remainder || null;
  } catch {
    return null;
  }
}

function parseStoredReferences(raw) {
  return parseJsonArray(raw)
    .map(normalizeReferenceEntry)
    .filter(Boolean);
}

function serializeReferencesForStorage(refs) {
  const normalized = (refs || [])
    .map(normalizeReferenceEntry)
    .filter(Boolean)
    .map((ref) => {
      if (ref.public_id && ref.url) {
        return { url: ref.url, public_id: ref.public_id };
      }
      if (ref.url) {
        return { url: ref.url, public_id: ref.public_id || extractPublicIdFromCloudinaryUrl(ref.url) };
      }
      if (ref.localPath) {
        return { localPath: ref.localPath };
      }
      return null;
    })
    .filter(Boolean);
  return JSON.stringify(normalized);
}

function referenceUrlsFromAssets(assets) {
  return (assets || [])
    .map((asset) => asset?.url || asset?.localPath || null)
    .filter(Boolean);
}

function isNotFoundCloudinaryError(error) {
  const message = String(error?.message || error?.error?.message || "").toLowerCase();
  return message.includes("not found") || message.includes("resource not found");
}

async function destroyReferenceAsset(ref) {
  const entry = normalizeReferenceEntry(ref);
  if (!entry) return { destroyed: false, skipped: true };

  if (entry.public_id && isCloudinaryConfigured()) {
    try {
      const result = await cloudinary.uploader.destroy(entry.public_id, {
        resource_type: "image",
        invalidate: true,
      });
      return { destroyed: result.result === "ok" || result.result === "not found", public_id: entry.public_id };
    } catch (error) {
      if (isNotFoundCloudinaryError(error)) {
        return { destroyed: false, skipped: true, public_id: entry.public_id };
      }
      console.warn("[CLOUDINARY] destroy failed:", entry.public_id, error.message);
      return { destroyed: false, error: error.message, public_id: entry.public_id };
    }
  }

  if (entry.localPath) {
    try {
      if (fs.existsSync(entry.localPath)) {
        fs.unlinkSync(entry.localPath);
        return { destroyed: true, localPath: entry.localPath };
      }
    } catch (error) {
      console.warn("[FACE] local unlink failed:", entry.localPath, error.message);
    }
  }

  return { destroyed: false, skipped: true };
}

async function destroyReferenceAssets(refs) {
  const results = [];
  for (const ref of refs || []) {
    results.push(await destroyReferenceAsset(ref));
  }
  return results;
}

function writeLocalReferenceImage(userId, index, imageBuffer) {
  const id = String(userId || "").trim();
  const profileDir = path.join(FACE_PROFILES_DIR, id);
  fs.mkdirSync(profileDir, { recursive: true });
  const localPath = path.join(profileDir, `${index}.jpg`);
  fs.writeFileSync(localPath, imageBuffer);
  return { url: null, public_id: null, localPath };
}

async function uploadReferenceImage(userId, index, imageBuffer) {
  const id = String(userId || "").trim();
  const slot = Math.max(0, Number.parseInt(index, 10) || 0);
  if (!imageBuffer?.length) {
    throw new Error("Reference image buffer is empty.");
  }

  if (!isCloudinaryConfigured()) {
    console.warn(
      "[CLOUDINARY] Credentials missing — storing face reference locally (not durable on Render)."
    );
    return writeLocalReferenceImage(id, slot, imageBuffer);
  }

  const publicId = buildFaceReferencePublicId(id, slot);
  const dataUri = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;

  try {
    const result = await cloudinary.uploader.upload(dataUri, {
      public_id: publicId,
      overwrite: true,
      resource_type: "image",
      format: "jpg",
    });
    return {
      url: result.secure_url || result.url,
      public_id: result.public_id || publicId,
      localPath: null,
    };
  } catch (error) {
    console.error("[CLOUDINARY] upload failed:", publicId, error.message);
    throw error;
  }
}

async function loadReferenceImageBuffer(ref) {
  const entry = normalizeReferenceEntry(ref);
  if (!entry) {
    throw new Error("Invalid face reference entry.");
  }

  if (entry.url && /^https?:\/\//i.test(entry.url)) {
    const response = await fetch(entry.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch reference image (${response.status}).`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  if (entry.localPath && fs.existsSync(entry.localPath) && fs.statSync(entry.localPath).size > 0) {
    return fs.readFileSync(entry.localPath);
  }

  throw new Error("Reference image not found.");
}

function purgeLegacyLocalFaceDirectory(userId) {
  const id = String(userId || "").trim();
  if (!id) return;

  try {
    const profileDir = path.join(FACE_PROFILES_DIR, id);
    if (fs.existsSync(profileDir)) {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
    const legacyFile = path.join(FACE_PROFILES_DIR, `${id}.jpg`);
    if (fs.existsSync(legacyFile)) {
      fs.unlinkSync(legacyFile);
    }
  } catch (error) {
    console.warn("[FACE] legacy local directory cleanup failed:", id, error.message);
  }
}

module.exports = {
  isCloudinaryConfigured,
  buildFaceReferencePublicId,
  normalizeReferenceEntry,
  parseStoredReferences,
  serializeReferencesForStorage,
  referenceUrlsFromAssets,
  uploadReferenceImage,
  loadReferenceImageBuffer,
  destroyReferenceAsset,
  destroyReferenceAssets,
  purgeLegacyLocalFaceDirectory,
};
