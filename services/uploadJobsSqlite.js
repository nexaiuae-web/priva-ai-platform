const crypto = require("crypto");
const { getDb } = require("./tenantDb");

const MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function ensureUploadJobsTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS upload_jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      company_id TEXT NOT NULL,
      filename TEXT,
      mime_type TEXT,
      file_path TEXT,
      file_size_bytes INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      percent INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL DEFAULT 'pending',
      current INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      result_json TEXT,
      error_message TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      max_retries INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_upload_jobs_company_status
      ON upload_jobs(company_id, status);
    CREATE INDEX IF NOT EXISTS idx_upload_jobs_updated
      ON upload_jobs(updated_at);
  `);

  const columns = db.prepare(`PRAGMA table_info(upload_jobs)`).all();
  const columnNames = new Set(columns.map((col) => col.name));
  if (!columnNames.has("folder_id")) {
    db.exec(`ALTER TABLE upload_jobs ADD COLUMN folder_id TEXT`);
  }
}

function rowToJob(row) {
  if (!row) return null;
  let result = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json);
    } catch {
      result = null;
    }
  }
  return {
    id: row.id,
    upload_id: row.id,
    user_id: row.user_id,
    folder_id: row.folder_id || null,
    company_id: row.company_id,
    filename: row.filename,
    mime_type: row.mime_type,
    file_path: row.file_path,
    file_size_bytes: row.file_size_bytes,
    status: row.status,
    percent: row.percent,
    phase: row.phase,
    current: row.current,
    total: row.total,
    message: row.message,
    result,
    error: row.error_message,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createUploadJob(meta = {}) {
  ensureUploadJobsTable();
  const db = getDb();
  const id = meta.id || crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    user_id: meta.user_id || null,
    folder_id: meta.folder_id || null,
    company_id: meta.company_id,
    filename: meta.filename || null,
    mime_type: meta.mime_type || null,
    file_path: meta.file_path || null,
    file_size_bytes: meta.file_size_bytes ?? null,
    status: meta.status || "pending",
    percent: meta.percent ?? 0,
    phase: meta.phase || "pending",
    current: meta.current ?? 0,
    total: meta.total ?? 0,
    message: meta.message || "",
    result_json: null,
    error_message: null,
    retry_count: 0,
    max_retries: meta.max_retries ?? 3,
    created_at: now,
    updated_at: now,
  };

  if (!job.company_id) {
    throw new Error("company_id is required to create an upload job.");
  }

  db.prepare(
    `INSERT INTO upload_jobs (
      id, user_id, folder_id, company_id, filename, mime_type, file_path, file_size_bytes,
      status, percent, phase, current, total, message, result_json, error_message,
      retry_count, max_retries, created_at, updated_at
    ) VALUES (
      @id, @user_id, @folder_id, @company_id, @filename, @mime_type, @file_path, @file_size_bytes,
      @status, @percent, @phase, @current, @total, @message, @result_json, @error_message,
      @retry_count, @max_retries, @created_at, @updated_at
    )`
  ).run(job);

  console.log("[BG-UPLOAD] Job created:", id, "| company:", job.company_id, "| file:", job.filename);
  return rowToJob(db.prepare(`SELECT * FROM upload_jobs WHERE id = ?`).get(id));
}

function updateUploadJob(id, patch = {}) {
  ensureUploadJobsTable();
  const db = getDb();
  const existing = getUploadJob(id);
  if (!existing) return null;

  const now = new Date().toISOString();
  const next = {
    status: patch.status ?? existing.status,
    percent: patch.percent ?? existing.percent,
    phase: patch.phase ?? existing.phase,
    current: patch.current ?? existing.current,
    total: patch.total ?? existing.total,
    message: patch.message ?? existing.message,
    error_message: patch.error ?? patch.error_message ?? existing.error,
    retry_count: patch.retry_count ?? existing.retry_count,
    result_json:
      patch.result !== undefined
        ? JSON.stringify(patch.result)
        : existing.result
          ? JSON.stringify(existing.result)
          : null,
    updated_at: now,
  };

  if (patch.file_path !== undefined) {
    db.prepare(`UPDATE upload_jobs SET file_path = @file_path, updated_at = @updated_at WHERE id = @id`).run({
      id,
      file_path: patch.file_path,
      updated_at: now,
    });
  }

  if (patch.user_id !== undefined) {
    db.prepare(`UPDATE upload_jobs SET user_id = @user_id, updated_at = @updated_at WHERE id = @id`).run({
      id,
      user_id: patch.user_id,
      updated_at: now,
    });
  }

  db.prepare(
    `UPDATE upload_jobs SET
      status = @status,
      percent = @percent,
      phase = @phase,
      current = @current,
      total = @total,
      message = @message,
      result_json = @result_json,
      error_message = @error_message,
      retry_count = @retry_count,
      updated_at = @updated_at
     WHERE id = @id`
  ).run({ id, ...next });

  return getUploadJob(id);
}

function getUploadJob(id) {
  ensureUploadJobsTable();
  const db = getDb();
  const row = db.prepare(`SELECT * FROM upload_jobs WHERE id = ?`).get(String(id || ""));
  return rowToJob(row);
}

function listUploadJobsByCompany(companyId, { activeOnly = false, user_id = null } = {}) {
  ensureUploadJobsTable();
  const db = getDb();
  const cid = String(companyId || "");
  const uid = user_id ? String(user_id) : null;

  if (activeOnly) {
    const sql = uid
      ? `SELECT * FROM upload_jobs
         WHERE company_id = ?
           AND user_id = ?
           AND status IN ('pending', 'processing', 'queued', 'running')
         ORDER BY updated_at DESC`
      : `SELECT * FROM upload_jobs
         WHERE company_id = ?
           AND status IN ('pending', 'processing', 'queued', 'running')
         ORDER BY updated_at DESC`;
    return uid
      ? db.prepare(sql).all(cid, uid).map(rowToJob)
      : db.prepare(sql).all(cid).map(rowToJob);
  }

  const sql = uid
    ? `SELECT * FROM upload_jobs
       WHERE company_id = ?
         AND user_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`
    : `SELECT * FROM upload_jobs
       WHERE company_id = ?
       ORDER BY updated_at DESC
       LIMIT 50`;
  return uid
    ? db.prepare(sql).all(cid, uid).map(rowToJob)
    : db.prepare(sql).all(cid).map(rowToJob);
}

function pruneOldUploadJobs() {
  ensureUploadJobsTable();
  const db = getDb();
  const cutoff = new Date(Date.now() - MAX_JOB_AGE_MS).toISOString();
  const result = db
    .prepare(
      `DELETE FROM upload_jobs
       WHERE updated_at < ?
         AND status IN ('complete', 'error')`
    )
    .run(cutoff);
  if (result.changes > 0) {
    console.log("[BG-UPLOAD] Pruned", result.changes, "old upload job(s)");
  }
}

setInterval(pruneOldUploadJobs, 60 * 60 * 1000).unref?.();

module.exports = {
  ensureUploadJobsTable,
  createUploadJob,
  updateUploadJob,
  getUploadJob,
  listUploadJobsByCompany,
};
