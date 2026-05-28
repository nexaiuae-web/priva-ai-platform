const path = require("path");

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
]);

function isImageUpload(file) {
  if (!file) return false;
  const mime = String(file.mimetype || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  const ext = path.extname(String(file.originalname || "")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function isPdfUpload(file) {
  if (!file) return false;
  const mime = String(file.mimetype || "").toLowerCase();
  if (mime === "application/pdf" || mime.includes("pdf")) return true;
  return path.extname(String(file.originalname || "")).toLowerCase() === ".pdf";
}

module.exports = {
  isImageUpload,
  isPdfUpload,
};
