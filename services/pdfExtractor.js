const pdfParse = require("pdf-parse");
const { OCRCleaner } = require("./ocrCleaner");

const cleaner = new OCRCleaner();

/**
 * Extract text from a PDF buffer (no image preprocessing).
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ rawText: string, cleanedText: string, numPages: number }>}
 */
async function extractTextFromPdf(pdfBuffer) {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
    throw new Error("PDF extraction failed: missing or empty buffer.");
  }

  let parsed;
  try {
    parsed = await pdfParse(pdfBuffer);
  } catch (e) {
    throw new Error(`PDF extraction failed: ${e.message}`);
  }

  const rawText = String(parsed.text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const cleanedText = cleaner.clean(rawText);
  const numPages = typeof parsed.numpages === "number" ? parsed.numpages : 0;

  console.log(
    "[PDF] Extracted",
    rawText.length,
    "raw chars |",
    cleanedText.length,
    "cleaned | pages:",
    numPages
  );

  return { rawText, cleanedText, numPages };
}

module.exports = {
  extractTextFromPdf,
};
