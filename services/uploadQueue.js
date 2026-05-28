const { getUploadJob, updateUploadJob } = require("./uploadJobs");
const { processDocumentUploadJob, cleanupStagedFile } = require("./documentUploadWorker");

const RETRY_BASE_MS = 2000;
const queue = [];
let draining = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  if (!error) return false;
  if (error.code === "STORAGE_LIMIT_REACHED") return false;
  const message = String(error.message || "").toLowerCase();
  if (message.includes("unsupported file type")) return false;
  if (message.includes("no text")) return false;
  if (message.includes("chunking failed")) return false;
  return true;
}

async function runJobWithRetries(jobId) {
  const job = await getUploadJob(jobId);
  if (!job) {
    console.error("[BG-UPLOAD] Queue skip — job missing:", jobId);
    return;
  }

  const maxRetries = job.max_retries ?? 3;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      await updateUploadJob(jobId, {
        status: "processing",
        phase: attempt > 1 ? "retrying" : "processing",
        message:
          attempt > 1
            ? `Retrying background processing (${attempt}/${maxRetries})…`
            : "Processing document in background…",
        retry_count: attempt - 1,
      });

      await processDocumentUploadJob(jobId);
      return;
    } catch (error) {
      console.error(
        `[BG-UPLOAD] Job ${jobId} attempt ${attempt}/${maxRetries} failed:`,
        error.message
      );

      const canRetry = attempt < maxRetries && isRetryableError(error);
      if (!canRetry) {
        const current = await getUploadJob(jobId);
        await updateUploadJob(jobId, {
          status: "error",
          phase: "error",
          error:
            error.code === "STORAGE_LIMIT_REACHED"
              ? error.message
              : error.message || "Background processing failed.",
          retry_count: attempt,
        });
        cleanupStagedFile(current?.file_path);
        return;
      }

      await updateUploadJob(jobId, {
        status: "processing",
        phase: "retrying",
        message: `Network/processing hiccup — retry ${attempt + 1}/${maxRetries}…`,
        retry_count: attempt,
      });
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
}

async function drainQueue() {
  if (draining) return;
  draining = true;

  while (queue.length > 0) {
    const jobId = queue.shift();
    console.log("[BG-UPLOAD] Dequeue job:", jobId, "| remaining:", queue.length);
    await runJobWithRetries(jobId);
  }

  draining = false;
}

function enqueueUploadJob(jobId) {
  if (!jobId) return;
  if (!queue.includes(jobId)) {
    queue.push(jobId);
    console.log("[BG-UPLOAD] Enqueued:", jobId, "| queue depth:", queue.length);
  }
  setImmediate(() => {
    void drainQueue();
  });
}

module.exports = {
  enqueueUploadJob,
};
