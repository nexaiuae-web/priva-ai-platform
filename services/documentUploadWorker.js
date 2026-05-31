const fs = require("fs");
const path = require("path");
const { updateUploadJob, getUploadJob } = require("./uploadJobs");
const { mapUploadOverallPercent } = require("./uploadUtils");
const { resolveCompanyRecord } = require("./companyResolver");
const {
  assertStorageLimitForUpload,
  STORAGE_LIMIT_MESSAGE,
  removeDocumentsByCompanyAndFilename,
  saveDocumentForCompany,
} = require("./admin");
const { deleteByDocumentId } = require("./vectorStore");
const { preprocessImage } = require("./imageProcessor");
const { extractTextFromImage } = require("./ocr");
const { extractTextFromPdf } = require("./pdfExtractor");
const { isImageUpload, isPdfUpload } = require("./fileType");
const { OCRCleaner } = require("./ocrCleaner");
const { semanticChunk, detectDocumentType, groupIntoBodyChunks } = require("./chunker");

const ocrCleaner = new OCRCleaner();

let retrieverInstance = null;

function setDocumentUploadRetriever(retriever) {
  retrieverInstance = retriever;
}

function buildSyntheticFile(job, buffer) {
  return {
    buffer,
    originalname: job.filename,
    mimetype: job.mime_type,
    size: job.file_size_bytes || buffer.length,
  };
}

function isPdfFile(file) {
  return isPdfUpload(file);
}

function isImageFile(file) {
  return isImageUpload(file);
}

function cleanupStagedFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log("[BG-UPLOAD] Staged file removed:", filePath);
    }
  } catch (error) {
    console.warn("[BG-UPLOAD] Could not remove staged file:", error.message);
  }
}

async function pushJobProgress(jobId, phase, details = {}) {
  const embedPct =
    details.embedPercent != null
      ? details.embedPercent
      : phase === "extracting"
        ? details.extractPercent || 10
        : 0;
  const percent = mapUploadOverallPercent(phase, embedPct);
  const message = details.message || phase;

  await updateUploadJob(jobId, {
    status:
      phase === "complete" ? "complete" : phase === "error" ? "error" : "processing",
    percent,
    phase,
    current: details.current ?? 0,
    total: details.total ?? 0,
    message,
  });

  console.log(`[BG-UPLOAD] ${jobId} | ${percent}% | ${phase} | ${message}`);
}

/**
 * Heavy document pipeline — runs off the HTTP request thread.
 */
async function processDocumentUploadJob(jobId) {
  const job = await getUploadJob(jobId);
  if (!job) {
    throw new Error(`Upload job not found: ${jobId}`);
  }

  if (!job.file_path || !fs.existsSync(job.file_path)) {
    throw new Error("Staged upload file is missing on disk.");
  }

  if (!retrieverInstance) {
    throw new Error("Document upload retriever is not initialized.");
  }

  console.log("\n========== [BG-UPLOAD] PROCESSING START ==========");
  console.log("[BG-UPLOAD] Job:", jobId, "| file:", job.filename);

  await pushJobProgress(jobId, "processing", { message: "Background processing started" });

  const buffer = fs.readFileSync(job.file_path);
  const file = buildSyntheticFile(job, buffer);
  const mimeType = String(file.mimetype || "").toLowerCase();
  const isPdf = isPdfFile(file);
  const isImage = isImageFile(file);

  if (!isPdf && !isImage) {
    throw new Error(
      "Unsupported file type. Upload a PDF or an image (PNG, JPG, JPEG, WEBP, GIF, BMP, TIFF)."
    );
  }

  await pushJobProgress(jobId, "received", { message: "File staged on server" });

  const companyId = String(job.company_id || "").trim();
  const isTrialSandbox = companyId.startsWith("trial_");
  const isTrial = Boolean(job.is_trial) || isTrialSandbox;
  const resolvedCompany = isTrial
    ? null
    : await resolveCompanyRecord(companyId);

  // Allow virtual trial sandbox environments to bypass company DB existence checks.
  if (!resolvedCompany && !isTrialSandbox) {
    throw new Error(`Company not found: ${companyId}`);
  }

  const company =
    resolvedCompany ||
    {
      id: companyId || "trial_unknown",
      company_name: "Free Trial Sandbox",
      name: "Free Trial Sandbox",
    };

  if (!isTrial) {
    try {
      await assertStorageLimitForUpload(company.id, file.size, {
        filename: file.originalname,
        excludeJobId: jobId,
        userId: job.user_id || null,
      });
    } catch (storageError) {
      if (
        storageError.code === "STORAGE_LIMIT_REACHED" ||
        storageError.code === "USER_STORAGE_LIMIT_REACHED"
      ) {
        const err = new Error(storageError.message || STORAGE_LIMIT_MESSAGE);
        err.code = storageError.code;
        throw err;
      }
      throw storageError;
    }
  }

  let rawText;
  let cleanedText;
  let extractionMethod;

  await pushJobProgress(jobId, "extracting", {
    message: isPdf ? "Extracting PDF text…" : "Running OCR…",
    extractPercent: 8,
  });

  if (isPdf) {
    const pdf = await extractTextFromPdf(file.buffer);
    rawText = pdf.rawText;
    cleanedText = pdf.cleanedText;
    extractionMethod = "pdf-parse";
  } else {
    const processedBuffer = await preprocessImage(file.buffer);
    const ocr = await extractTextFromImage(processedBuffer);
    rawText = ocr.rawText;
    cleanedText = ocr.cleanedText;
    extractionMethod = "ocr";
  }

  await pushJobProgress(jobId, "extracting", { message: "Text extraction complete", extractPercent: 18 });

  if (!String(cleanedText || "").trim()) {
    throw new Error(
      isPdf
        ? "No text extracted from PDF (file may be scanned images only)."
        : "No text after OCR cleaning."
    );
  }

  await pushJobProgress(jobId, "chunking", { message: "Chunking document…" });

  const detectedType = detectDocumentType(file.originalname, file.mimetype, cleanedText);
  const rawBodies = groupIntoBodyChunks(rawText, 800, 100);
  const ocrVerification = {
    first_chunk_before_cleaning: rawBodies[0] || "",
    first_chunk_after_cleaning: ocrCleaner.clean(rawBodies[0] || ""),
  };

  const chunks = semanticChunk(cleanedText, 800, 100, {
    filename: file.originalname,
    mime_type: file.mimetype,
    document_type: detectedType,
  });

  if (chunks.length === 0) {
    throw new Error("Chunking failed: no chunks generated.");
  }

  await pushJobProgress(jobId, "saving", { message: "Saving document to database…" });

  let document;
  try {
    const { removedDocumentIds } = await removeDocumentsByCompanyAndFilename(
      company.id,
      file.originalname
    );
    for (const rid of removedDocumentIds) {
      try {
        await deleteByDocumentId(rid);
      } catch (e) {
        console.warn("[BG-UPLOAD] Chroma cleanup:", e.message);
      }
    }

    document = await saveDocumentForCompany({
      company_id: company.id,
      filename: file.originalname,
      mime_type: file.mimetype,
      chunks,
      raw_ocr_text: rawText,
      cleaned_text: cleanedText,
      raw_text_length: rawText.length,
      cleaned_text_length: cleanedText.length,
      detected_document_type: detectedType,
      ocr_verification: ocrVerification,
      file_size_bytes: file.size,
      upload_job_id: jobId,
      uploaded_by_user_id: job.user_id || null,
      folder_id: job.folder_id || null,
    });
  } catch (error) {
    console.error("[BG-UPLOAD] Background processing error:", error.message);
    if (error?.stack) {
      console.error(error.stack);
    }
    throw error;
  }

  let ragStats = { parentsStored: 0, childrenIndexed: 0, totalChunks: 0 };
  try {
    ragStats = await retrieverInstance.indexDocument({
      company,
      document_id: document.id,
      text: cleanedText,
      uploaded_by_user_id: job.user_id || null,
      folder_id: job.folder_id || null,
      onProgress: (p) => {
        void pushJobProgress(jobId, "embedding", {
          current: p.current,
          total: p.total,
          embedPercent: p.percent,
          message: p.message || `Embedding ${p.current}/${p.total}`,
        });
      },
    });
    await pushJobProgress(jobId, "indexing", { message: "Finalizing vector index…" });
  } catch (e) {
    console.error("[BG-UPLOAD] Chroma index FAILED:", e.message);
    ragStats = { parentsStored: 0, childrenIndexed: 0, totalChunks: 0, error: e.message };
  }

  const result = {
    id: document.id,
    filename: document.filename,
    uploadedAt: document.created_at,
    message: "Document processed successfully.",
    document_id: document.id,
    company_id: company.id,
    mime_type: document.mime_type,
    extraction_method: extractionMethod,
    total_chunks: chunks.length,
    rag_index: {
      parents_stored: ragStats.parentsStored ?? 0,
      children_indexed: ragStats.childrenIndexed ?? 0,
      total_embedding_chunks: ragStats.totalChunks ?? ragStats.childrenIndexed ?? 0,
    },
    job_id: jobId,
    upload_id: jobId,
  };

  await updateUploadJob(jobId, {
    status: "complete",
    percent: 100,
    phase: "complete",
    message: "Upload and indexing complete",
    result,
  });

  cleanupStagedFile(job.file_path);
  console.log("========== [BG-UPLOAD] SUCCESS | job:", jobId, "==========\n");
  return result;
}

module.exports = {
  setDocumentUploadRetriever,
  processDocumentUploadJob,
  cleanupStagedFile,
};
