/**
 * Private Priva document storage (isolated from FaceID CLOUDINARY_* credentials).
 * Uses PRIVA_CLOUDINARY_* env vars. Uploads are type=private, resource_type=raw.
 */
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const cloudinary = require("cloudinary").v2;

const DOCUMENT_FOLDER_PREFIX =
  String(process.env.PRIVA_CLOUDINARY_FOLDER || "priva/documents").replace(/^\/+|\/+$/g, "") ||
  "priva/documents";

const PRIVATE_DELIVERY_TYPE = "private";
const RAW_RESOURCE_TYPE = "raw";
const SIGNED_URL_TTL_SECONDS = Math.max(
  60,
  Number.parseInt(process.env.PRIVA_CLOUDINARY_SIGNED_URL_TTL_SECONDS || "600", 10) || 600
);

let privaCredentialsCache = null;

function getPrivaCredentials() {
  if (privaCredentialsCache) {
    return privaCredentialsCache;
  }
  const cloud_name = String(process.env.PRIVA_CLOUDINARY_CLOUD_NAME || "").trim();
  const api_key = String(process.env.PRIVA_CLOUDINARY_API_KEY || "").trim();
  const api_secret = String(process.env.PRIVA_CLOUDINARY_API_SECRET || "").trim();
  privaCredentialsCache = { cloud_name, api_key, api_secret };
  return privaCredentialsCache;
}

function isPrivaCloudinaryConfigured() {
  const { cloud_name, api_key, api_secret } = getPrivaCredentials();
  return Boolean(cloud_name && api_key && api_secret);
}

function sanitizePathSegment(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 96);
  return cleaned || fallback;
}

function buildDocumentPublicId(companyId, uploadId) {
  const companySegment = sanitizePathSegment(companyId, "company");
  const uploadSegment = sanitizePathSegment(uploadId, "upload");
  return `${DOCUMENT_FOLDER_PREFIX}/${companySegment}/${uploadSegment}`;
}

function runWithPrivaCloudinary(fn) {
  if (!isPrivaCloudinaryConfigured()) {
    throw new Error("PRIVA Cloudinary credentials are not configured.");
  }
  const creds = getPrivaCredentials();
  const previous = cloudinary.config();
  cloudinary.config({
    cloud_name: creds.cloud_name,
    api_key: creds.api_key,
    api_secret: creds.api_secret,
    secure: true,
  });
  try {
    return fn(cloudinary);
  } finally {
    if (previous?.cloud_name) {
      cloudinary.config(previous);
    }
  }
}

function inferRawFormat(filename, mimeType) {
  const ext = path.extname(String(filename || "")).toLowerCase().replace(/^\./, "");
  if (ext) return ext;
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("tiff")) return "tiff";
  if (mime.includes("bmp")) return "bmp";
  return "";
}

function buildSignedPrivateDownloadUrl(publicId, { format = "" } = {}) {
  return runWithPrivaCloudinary((cld) =>
    cld.utils.private_download_url(publicId, format || "", {
      resource_type: RAW_RESOURCE_TYPE,
      type: PRIVATE_DELIVERY_TYPE,
      expires_at: Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS,
    })
  );
}

/**
 * Upload staged file to private Cloudinary raw storage.
 */
async function uploadDocumentFile({
  filePath,
  companyId,
  uploadId,
  filename,
  mimeType,
}) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Upload file path is missing on disk.");
  }

  const publicId = buildDocumentPublicId(companyId, uploadId);
  const format = inferRawFormat(filename, mimeType);

  const result = await runWithPrivaCloudinary((cld) =>
    cld.uploader.upload(filePath, {
      public_id: publicId,
      resource_type: RAW_RESOURCE_TYPE,
      type: PRIVATE_DELIVERY_TYPE,
      overwrite: true,
      invalidate: true,
      ...(format ? { format } : {}),
      context: {
        original_filename: String(filename || "").slice(0, 180),
        company_id: String(companyId || "").slice(0, 96),
        upload_id: String(uploadId || "").slice(0, 96),
      },
    })
  );

  console.log("[PRIVA-CLOUDINARY] Private document uploaded", {
    public_id: result.public_id,
    bytes: result.bytes,
    type: result.type || PRIVATE_DELIVERY_TYPE,
  });

  return {
    public_id: result.public_id || publicId,
    secure_url: result.secure_url || null,
    bytes: result.bytes || 0,
    resource_type: result.resource_type || RAW_RESOURCE_TYPE,
    delivery_type: result.type || PRIVATE_DELIVERY_TYPE,
    storage_provider: "cloudinary",
  };
}

async function fetchBufferFromSignedUrl(signedUrl) {
  const response = await fetch(signedUrl);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Private Cloudinary download failed (${response.status}): ${body.slice(0, 200)}`
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fetch document bytes for background OCR/PDF processing (signed private URL).
 */
async function loadPrivateDocumentBuffer(publicId, { filename, mimeType } = {}) {
  const id = String(publicId || "").trim();
  if (!id) {
    throw new Error("cloudinary_public_id is required to load a private document.");
  }

  const format = inferRawFormat(filename, mimeType);
  const signedUrl = buildSignedPrivateDownloadUrl(id, { format });
  console.log("[PRIVA-CLOUDINARY] Fetching private document for processing:", id);
  return fetchBufferFromSignedUrl(signedUrl);
}

async function loadDocumentBufferForJob(job) {
  if (!job) {
    throw new Error("Upload job is required.");
  }

  const publicId = String(job.cloudinary_public_id || "").trim();
  if (publicId && (job.storage_provider === "cloudinary" || isPrivaCloudinaryConfigured())) {
    return loadPrivateDocumentBuffer(publicId, {
      filename: job.filename,
      mimeType: job.mime_type,
    });
  }

  const filePath = job.file_path;
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath);
  }

  throw new Error("Document source is missing (no private Cloudinary id or staged file path).");
}

async function destroyPrivateDocument(publicId) {
  const id = String(publicId || "").trim();
  if (!id || !isPrivaCloudinaryConfigured()) {
    return { destroyed: false, skipped: true, public_id: id || null };
  }

  try {
    const result = await runWithPrivaCloudinary((cld) =>
      cld.uploader.destroy(id, {
        resource_type: RAW_RESOURCE_TYPE,
        type: PRIVATE_DELIVERY_TYPE,
        invalidate: true,
      })
    );
    return {
      destroyed: result.result === "ok" || result.result === "not found",
      public_id: id,
      result: result.result,
    };
  } catch (error) {
    const message = String(error?.message || error).toLowerCase();
    if (message.includes("not found")) {
      return { destroyed: false, skipped: true, public_id: id };
    }
    console.warn("[PRIVA-CLOUDINARY] destroy failed:", id, error.message);
    return { destroyed: false, error: error.message, public_id: id };
  }
}

async function destroyDocumentStorageRecord(doc) {
  if (!doc) return { destroyed: false, skipped: true };
  const publicId = String(doc.cloudinary_public_id || "").trim();
  if (!publicId) {
    return { destroyed: false, skipped: true };
  }
  return destroyPrivateDocument(publicId);
}

module.exports = {
  DOCUMENT_FOLDER_PREFIX,
  PRIVATE_DELIVERY_TYPE,
  RAW_RESOURCE_TYPE,
  isPrivaCloudinaryConfigured,
  buildDocumentPublicId,
  uploadDocumentFile,
  loadPrivateDocumentBuffer,
  loadDocumentBufferForJob,
  buildSignedPrivateDownloadUrl,
  destroyPrivateDocument,
  destroyDocumentStorageRecord,
};
