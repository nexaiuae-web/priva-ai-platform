const sharp = require("sharp");

async function preprocessImage(imageBuffer) {
  if (!imageBuffer) {
    throw new Error("Image preprocessing failed: missing file buffer.");
  }

  const baseImage = sharp(imageBuffer, { failOn: "none" });
  const metadata = await baseImage.metadata();

  // Targeting a higher effective resolution improves OCR quality.
  const targetWidth = Math.max(1800, Math.min(3200, (metadata.width || 1200) * 2));

  let pipeline = sharp(imageBuffer, { failOn: "none" })
    .grayscale()
    .resize({ width: targetWidth, fit: "inside", withoutEnlargement: false })
    .normalize();

  if (typeof pipeline.median === "function") {
    pipeline = pipeline.median(1);
  }

  const processedBuffer = await pipeline
    .threshold(170)
    .extend({
      top: 50,
      bottom: 50,
      left: 50,
      right: 50,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .png()
    .toBuffer();

  return processedBuffer;
}

module.exports = {
  preprocessImage,
};
