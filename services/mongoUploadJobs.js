const crypto = require("crypto");
const UploadJob = require("../models/UploadJob");

const MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = ["pending", "processing", "queued", "running"];

function docToJob(doc) {
  if (!doc) return null;
  return {
    id: doc.id,
    upload_id: doc.id,
    user_id: doc.user_id,
    folder_id: doc.folder_id || null,
    company_id: doc.company_id,
    filename: doc.filename,
    mime_type: doc.mime_type,
    file_path: doc.file_path,
    file_size_bytes: doc.file_size_bytes,
    status: doc.status,
    percent: doc.percent,
    phase: doc.phase,
    current: doc.current,
    total: doc.total,
    message: doc.message,
    result: doc.result || null,
    error: doc.error_message,
    retry_count: doc.retry_count,
    max_retries: doc.max_retries,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

function ensureUploadJobsTable() {
  return;
}

async function createUploadJob(meta = {}) {
  const id = meta.id || crypto.randomUUID();
  const now = new Date();
  if (!meta.company_id) {
    throw new Error("company_id is required to create an upload job.");
  }

  const job = await UploadJob.create({
    id,
    user_id: meta.user_id || null,
    folder_id: meta.folder_id || null,
    company_id: meta.company_id,
    filename: meta.filename || null,
    mime_type: meta.mime_type || null,
    file_path: meta.file_path || null,
    file_size_bytes: meta.file_size_bytes ?? 0,
    status: meta.status || "pending",
    percent: meta.percent ?? 0,
    phase: meta.phase || "pending",
    current: meta.current ?? 0,
    total: meta.total ?? 0,
    message: meta.message || "",
    result: null,
    error_message: null,
    retry_count: 0,
    max_retries: meta.max_retries ?? 3,
    is_trial: Boolean(meta.is_trial),
    trial_fingerprint: meta.trial_fingerprint || null,
    created_at: now,
    updated_at: now,
  });

  console.log("[BG-UPLOAD/MONGO] Job created:", id, "| company:", job.company_id);
  return docToJob(job.toObject());
}

async function updateUploadJob(id, patch = {}) {
  const existing = await UploadJob.findOne({ id: String(id) }).lean();
  if (!existing) return null;

  const update = {
    status: patch.status ?? existing.status,
    percent: patch.percent ?? existing.percent,
    phase: patch.phase ?? existing.phase,
    current: patch.current ?? existing.current,
    total: patch.total ?? existing.total,
    message: patch.message ?? existing.message,
    error_message: patch.error ?? patch.error_message ?? existing.error_message,
    retry_count: patch.retry_count ?? existing.retry_count,
    updated_at: new Date(),
  };

  if (patch.file_path !== undefined) update.file_path = patch.file_path;
  if (patch.user_id !== undefined) update.user_id = patch.user_id;
  if (patch.result !== undefined) update.result = patch.result;

  const job = await UploadJob.findOneAndUpdate({ id: String(id) }, { $set: update }, { new: true }).lean();
  return docToJob(job);
}

async function getUploadJob(id) {
  const job = await UploadJob.findOne({ id: String(id || "") }).lean();
  return docToJob(job);
}

async function listUploadJobsByCompany(companyId, { activeOnly = false, user_id = null } = {}) {
  const query = { company_id: String(companyId || "") };
  if (user_id) query.user_id = String(user_id);
  if (activeOnly) query.status = { $in: ACTIVE_STATUSES };

  const rows = await UploadJob.find(query).sort({ updated_at: -1 }).limit(50).lean();
  return rows.map(docToJob);
}

function getReservedUploadStorageBytes(company_id, { excludeJobId = null } = {}) {
  return listUploadJobsByCompany(company_id, { activeOnly: true }).then((jobs) =>
    jobs.reduce((sum, job) => {
      if (excludeJobId && job.id === excludeJobId) return sum;
      return sum + Math.max(0, Number(job.file_size_bytes) || 0);
    }, 0)
  );
}

function getUserReservedUploadStorageBytes(user_id, { excludeJobId = null } = {}) {
  const query = { user_id: String(user_id || ""), status: { $in: ACTIVE_STATUSES } };
  return UploadJob.find(query)
    .lean()
    .then((rows) =>
      rows.reduce((sum, row) => {
        if (excludeJobId && row.id === excludeJobId) return sum;
        return sum + Math.max(0, Number(row.file_size_bytes) || 0);
      }, 0)
    );
}

async function pruneOldUploadJobs() {
  const cutoff = new Date(Date.now() - MAX_JOB_AGE_MS);
  const result = await UploadJob.deleteMany({
    updated_at: { $lt: cutoff },
    status: { $in: ["complete", "error"] },
  });
  if (result.deletedCount > 0) {
    console.log("[BG-UPLOAD/MONGO] Pruned", result.deletedCount, "old upload job(s)");
  }
}

setInterval(() => {
  void pruneOldUploadJobs();
}, 60 * 60 * 1000).unref?.();

module.exports = {
  ensureUploadJobsTable,
  createUploadJob,
  updateUploadJob,
  getUploadJob,
  listUploadJobsByCompany,
  getReservedUploadStorageBytes,
  getUserReservedUploadStorageBytes,
};
