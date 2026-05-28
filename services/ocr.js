const sharp = require("sharp");
const { createWorker, PSM } = require("tesseract.js");
const { OCRCleaner } = require("./ocrCleaner");

const cleaner = new OCRCleaner();

async function cropImageBottom(imageBuffer, fraction = 0.2) {
  const meta = await sharp(imageBuffer, { failOn: "none" }).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const cropHeight = Math.max(1, Math.floor(height * fraction));
  const top = Math.max(0, height - cropHeight);

  return sharp(imageBuffer, { failOn: "none" })
    .extract({ left: 0, top, width, height: cropHeight })
    .png({ density: 300 })
    .toBuffer();
}

async function recognizeBuffer(worker, imageBuffer) {
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
  });

  const {
    data: { text },
  } = await worker.recognize(imageBuffer, {}, { density: 300 });
  return text || "";
}

function postProcessOcrText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/([a-zA-Z])\s+([a-zA-Z])/g, "$1$2")
    .replace(/(Sponsor|Powered by|Presented by|In cooperation with|برعاية)/gi, "\n$1: ")
    .trim();
}

/**
 * OCR: full image + bottom 20% margin (sponsor area).
 * @param {Buffer} imageBuffer
 * @returns {{ rawText: string, cleanedText: string }}
 */
async function extractTextFromImage(imageBuffer) {
  if (!imageBuffer) {
    throw new Error("OCR failed: missing image buffer.");
  }

  const worker = await createWorker("ara+eng", 1);

  try {
    const fullText = await recognizeBuffer(worker, imageBuffer);

    let bottomText = "";
    try {
      const bottomCrop = await cropImageBottom(imageBuffer, 0.2);
      bottomText = await recognizeBuffer(worker, bottomCrop);
      console.log("[OCR] Bottom margin extracted:", bottomText.length, "chars");
    } catch (e) {
      console.warn("[OCR] Bottom margin crop/OCR failed:", e.message);
    }

    const combinedRaw = bottomText
      ? `${fullText}\n\n[هامش سفلي - منطقة الرعاة]\n${bottomText}`
      : fullText;

    const rawText = postProcessOcrText(combinedRaw);
    const cleanedText = cleaner.clean(rawText);

    return { rawText, cleanedText };
  } catch (error) {
    throw new Error(`OCR failed: ${error.message}`);
  } finally {
    await worker.terminate();
  }
}

async function processImage(imageBuffer) {
  return extractTextFromImage(imageBuffer);
}

module.exports = {
  extractTextFromImage,
  processImage,
  cropImageBottom,
};
