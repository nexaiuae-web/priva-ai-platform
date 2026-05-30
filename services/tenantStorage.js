/**
 * Shared company storage pool ? one storage_limit_mb ceiling per tenant (company),
 * aggregated across all users and documents in that company.
 */
const {
  getCompanyById: getTenantCompanyById,
  findUserById,
  getUserStorageLimitMbResolved,
} = require("./tenantStore");
const { getDb } = require("./tenantDb");
const Document = require("../models/Document");

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_STORAGE_LIMIT_MB = 512;

const STORAGE_LIMIT_MESSAGE =
  "Upload blocked: The company storage quota limit has been exceeded. Please upgrade your plan.";

const USER_STORAGE_LIMIT_MESSAGE =
  "Upload blocked: Your personal storage quota has been exceeded. Contact your administrator.";

const ACTIVE_UPLOAD_STATUSES = ["pending", "processing", "queued", "running"];

function isTrialSandboxCompanyId(company_id) {
  const id = String(company_id || "").trim();
  return Boolean(id) && id.startsWith("trial_");
}

function documentStorageBytes(doc) {
  if (!doc) return 0;
  if (doc.file_size_bytes != null && doc.file_size_bytes !== "") {
    return Math.max(0, Number(doc.file_size_bytes) || 0);
  }
  return (
    Math.max(0, Number(doc.raw_text_length) || 0) +
    Math.max(0, Number(doc.cleaned_text_length) || 0)
  );
}

async function resolveCompanyForStorage(company_id) {
  const id = String(company_id || "").trim();
  if (!id) return null;

  const tenant = await Promise.resolve(getTenantCompanyById(id));
  if (tenant) {
    return tenant;
  }

  if (isTrialSandboxCompanyId(id)) {
    return {
      id,
      company_name: "Free Trial Sandbox",
      storage_limit_mb: DEFAULT_STORAGE_LIMIT_MB,
      max_users: 10,
      status: "active",
    };
  }

  return null;
}

async function getCommittedDocumentStorageBytes(company_id) {
  const id = String(company_id || "").trim();
  const docs = await Document.find({ company_id: id }, { file_size_bytes: 1, raw_text_length: 1, cleaned_text_length: 1 }).lean();
  return docs.reduce((sum, doc) => sum + documentStorageBytes(doc), 0);
}

async function getReservedUploadStorageBytes(company_id, { excludeJobId = null } = {}) {
  const uploadJobs = require("./uploadJobs");
  if (typeof uploadJobs.getReservedUploadStorageBytes === "function") {
    return uploadJobs.getReservedUploadStorageBytes(company_id, { excludeJobId });
  }

  const { ensureUploadJobsTable } = require("./uploadJobsSqlite");
  ensureUploadJobsTable();
  const db = getDb();
  const id = String(company_id || "").trim();
  const excludeId = excludeJobId ? String(excludeJobId) : null;
  const placeholders = ACTIVE_UPLOAD_STATUSES.map(() => "?").join(", ");

  const rows = db
    .prepare(
      `SELECT id, file_size_bytes FROM upload_jobs
       WHERE company_id = ?
         AND status IN (${placeholders})`
    )
    .all(id, ...ACTIVE_UPLOAD_STATUSES);

  return rows.reduce((sum, row) => {
    if (excludeId && row.id === excludeId) {
      return sum;
    }
    return sum + Math.max(0, Number(row.file_size_bytes) || 0);
  }, 0);
}

async function getTotalTenantStorageUsedBytes(company_id, options = {}) {
  const committed = await getCommittedDocumentStorageBytes(company_id);
  const reserved = await getReservedUploadStorageBytes(company_id, options);
  return committed + reserved;
}

function bytesToMb(bytes) {
  return bytes / BYTES_PER_MB;
}

async function getTotalTenantStorageUsed(company_id, options = {}) {
  const usedBytes = await getTotalTenantStorageUsedBytes(company_id, options);
  return bytesToMb(usedBytes);
}

async function getTenantStorageLimit(company_id) {
  const company = await resolveCompanyForStorage(company_id);
  const isTrialSandbox = isTrialSandboxCompanyId(company_id);
  if (!company && !isTrialSandbox) {
    throw new Error("Company not found for provided company_id.");
  }
  if (!company && isTrialSandbox) {
    return DEFAULT_STORAGE_LIMIT_MB;
  }
  return Math.max(1, Number(company.storage_limit_mb) || DEFAULT_STORAGE_LIMIT_MB);
}

async function getReplacementBytesForFilename(company_id, filename, { user_id = null } = {}) {
  const id = String(company_id || "").trim();
  const name = String(filename || "").trim();
  if (!id || !name) return 0;

  const docs = await Document.find({ company_id: id, filename: name }).lean();
  return docs
    .filter((doc) => {
      if (user_id) {
        const docUser = doc.uploaded_by_user_id || doc.user_id || null;
        return docUser === user_id;
      }
      return true;
    })
    .reduce((sum, doc) => sum + documentStorageBytes(doc), 0);
}

function getOrphanDocumentAttributionUserId(company_id) {
  const id = String(company_id || "").trim();
  if (!id) return null;

  const rows = getDb()
    .prepare(`SELECT id FROM users WHERE company_id = ? AND role = 'user'`)
    .all(id);

  if (rows.length === 1) {
    return rows[0].id;
  }
  return null;
}

function documentCountsTowardUserStorage(doc, user_id, company_id, orphanAttributionUserId) {
  const uid = String(user_id || "").trim();
  const docUser = doc.uploaded_by_user_id || doc.user_id || null;
  if (docUser === uid) {
    return true;
  }
  if (
    !docUser &&
    doc.company_id === company_id &&
    orphanAttributionUserId === uid
  ) {
    return true;
  }
  return false;
}

async function getUserCommittedDocumentStorageBytes(user_id) {
  const user = await Promise.resolve(findUserById(user_id));
  if (!user) return 0;

  const uid = String(user_id || "").trim();
  const companyId = String(user.company_id || "").trim();
  const orphanAttributionUserId = getOrphanDocumentAttributionUserId(companyId);

  const docs = await Document.find({ company_id: companyId }).lean();
  return docs
    .filter((doc) =>
      documentCountsTowardUserStorage(doc, uid, companyId, orphanAttributionUserId)
    )
    .reduce((sum, doc) => sum + documentStorageBytes(doc), 0);
}

async function backfillOrphanDocumentUploaders() {
  const docs = await Document.find({
    $or: [{ uploaded_by_user_id: null }, { uploaded_by_user_id: { $exists: false } }],
  }).lean();

  let changed = 0;
  for (const doc of docs) {
    if (doc.user_id) continue;
    const ownerId = getOrphanDocumentAttributionUserId(doc.company_id);
    if (!ownerId) continue;
    await Document.updateOne({ id: doc.id }, { $set: { uploaded_by_user_id: ownerId } });
    changed += 1;
  }

  if (changed > 0) {
    console.log("[STORAGE] Backfilled uploaded_by_user_id on legacy documents.", { changed });
  }

  return changed > 0;
}

async function getUserReservedUploadStorageBytes(user_id, { excludeJobId = null } = {}) {
  const uploadJobs = require("./uploadJobs");
  if (typeof uploadJobs.getUserReservedUploadStorageBytes === "function") {
    return uploadJobs.getUserReservedUploadStorageBytes(user_id, { excludeJobId });
  }

  const { ensureUploadJobsTable } = require("./uploadJobsSqlite");
  ensureUploadJobsTable();
  const db = getDb();
  const uid = String(user_id || "").trim();
  if (!uid) return 0;

  const excludeId = excludeJobId ? String(excludeJobId) : null;
  const placeholders = ACTIVE_UPLOAD_STATUSES.map(() => "?").join(", ");

  const rows = db
    .prepare(
      `SELECT id, file_size_bytes FROM upload_jobs
       WHERE user_id = ?
         AND status IN (${placeholders})`
    )
    .all(uid, ...ACTIVE_UPLOAD_STATUSES);

  return rows.reduce((sum, row) => {
    if (excludeId && row.id === excludeId) return sum;
    return sum + Math.max(0, Number(row.file_size_bytes) || 0);
  }, 0);
}

async function getUserTotalStorageUsedBytes(user_id, options = {}) {
  const committed = await getUserCommittedDocumentStorageBytes(user_id);
  const reserved = await getUserReservedUploadStorageBytes(user_id, options);
  return committed + reserved;
}

async function getUserStorageSnapshot(user_id, options = {}) {
  const user = await Promise.resolve(findUserById(user_id));
  if (!user || user.role !== "user") {
    return null;
  }

  const limitMb = await Promise.resolve(getUserStorageLimitMbResolved(user.id));
  const limitBytes = limitMb * BYTES_PER_MB;
  const committedBytes = await getUserCommittedDocumentStorageBytes(user.id);
  const reservedBytes = await getUserReservedUploadStorageBytes(user.id, options);
  const usedBytes = committedBytes + reservedBytes;

  return {
    user_id: user.id,
    storage_pool_scope: "user",
    storage_limit_mb: limitMb,
    storage_used_mb: bytesToMb(usedBytes),
    storage_committed_mb: bytesToMb(committedBytes),
    storage_reserved_mb: bytesToMb(reservedBytes),
    storage_remaining_mb: Math.max(0, bytesToMb(limitBytes - usedBytes)),
    storage_used_bytes: usedBytes,
    storage_limit_bytes: limitBytes,
  };
}

function buildUserStorageLimitError(usedBytes, limitBytes) {
  const err = new Error(USER_STORAGE_LIMIT_MESSAGE);
  err.code = "USER_STORAGE_LIMIT_REACHED";
  err.used_bytes = usedBytes;
  err.limit_bytes = limitBytes;
  err.used_mb = bytesToMb(usedBytes);
  err.limit_mb = bytesToMb(limitBytes);
  return err;
}

async function assertUserStorageForUpload(user_id, newFileBytes, options = {}) {
  const { filename = null, excludeJobId = null } = options;
  const uid = String(user_id || "").trim();
  if (!uid) {
    return null;
  }

  const user = await Promise.resolve(findUserById(uid));
  if (!user || user.role !== "user") {
    return null;
  }

  const limitMb = await Promise.resolve(getUserStorageLimitMbResolved(user.id));
  const limitBytes = limitMb * BYTES_PER_MB;

  let committedBytes = await getUserCommittedDocumentStorageBytes(user.id);
  const replacementBytes = filename
    ? await getReplacementBytesForFilename(user.company_id, filename, { user_id: user.id })
    : 0;
  committedBytes = Math.max(0, committedBytes - replacementBytes);

  const reservedBytes = await getUserReservedUploadStorageBytes(user.id, { excludeJobId });
  const usedBytes = committedBytes + reservedBytes;
  const incomingBytes = Math.max(0, Number(newFileBytes) || 0);
  const projectedTotal = usedBytes + incomingBytes;

  if (projectedTotal > limitBytes) {
    throw buildUserStorageLimitError(projectedTotal, limitBytes);
  }

  return {
    user,
    usedBytes,
    committedBytes,
    reservedBytes,
    incomingBytes,
    projectedTotal,
    limitBytes,
    limitMb,
  };
}

function buildStorageLimitError(usedBytes, limitBytes) {
  const err = new Error(STORAGE_LIMIT_MESSAGE);
  err.code = "STORAGE_LIMIT_REACHED";
  err.used_bytes = usedBytes;
  err.limit_bytes = limitBytes;
  err.used_mb = bytesToMb(usedBytes);
  err.limit_mb = bytesToMb(limitBytes);
  return err;
}

async function getTenantStorageSnapshot(company_id, options = {}) {
  const company = await resolveCompanyForStorage(company_id);
  if (!company) {
    return null;
  }

  const limitMb = await getTenantStorageLimit(company.id);
  const limitBytes = limitMb * BYTES_PER_MB;
  const committedBytes = await getCommittedDocumentStorageBytes(company.id);
  const reservedBytes = await getReservedUploadStorageBytes(company.id, options);
  const usedBytes = committedBytes + reservedBytes;

  return {
    company_id: company.id,
    storage_pool_scope: "company",
    storage_limit_mb: limitMb,
    storage_used_mb: bytesToMb(usedBytes),
    storage_committed_mb: bytesToMb(committedBytes),
    storage_reserved_mb: bytesToMb(reservedBytes),
    storage_remaining_mb: Math.max(0, bytesToMb(limitBytes - usedBytes)),
    storage_used_bytes: usedBytes,
    storage_limit_bytes: limitBytes,
  };
}

async function assertTenantStorageForUpload(company_id, newFileBytes, options = {}) {
  const { filename = null, excludeJobId = null, userId = null } = options;
  const company = await resolveCompanyForStorage(company_id);
  const isTrialSandbox = isTrialSandboxCompanyId(company_id);
  if (!company && !isTrialSandbox) {
    throw new Error("Company not found for provided company_id.");
  }
  if (!company && isTrialSandbox) {
    return {
      company: {
        id: String(company_id || "").trim() || "trial_unknown",
        company_name: "Free Trial Sandbox",
        storage_limit_mb: DEFAULT_STORAGE_LIMIT_MB,
      },
      user: null,
      usedBytes: 0,
      committedBytes: 0,
      reservedBytes: 0,
      incomingBytes: Math.max(0, Number(newFileBytes) || 0),
      projectedTotal: Math.max(0, Number(newFileBytes) || 0),
      limitBytes: DEFAULT_STORAGE_LIMIT_MB * BYTES_PER_MB,
      limitMb: DEFAULT_STORAGE_LIMIT_MB,
      usedMb: 0,
      incomingMb: bytesToMb(Math.max(0, Number(newFileBytes) || 0)),
      projectedMb: bytesToMb(Math.max(0, Number(newFileBytes) || 0)),
    };
  }

  const userResult = await assertUserStorageForUpload(userId, newFileBytes, {
    filename,
    excludeJobId,
  });

  const limitMb = await getTenantStorageLimit(company.id);
  const limitBytes = limitMb * BYTES_PER_MB;

  let committedBytes = await getCommittedDocumentStorageBytes(company.id);
  const replacementBytes = filename
    ? await getReplacementBytesForFilename(company.id, filename)
    : 0;
  committedBytes = Math.max(0, committedBytes - replacementBytes);

  const reservedBytes = await getReservedUploadStorageBytes(company.id, { excludeJobId });
  const usedBytes = committedBytes + reservedBytes;
  const incomingBytes = Math.max(0, Number(newFileBytes) || 0);
  const projectedTotal = usedBytes + incomingBytes;

  if (projectedTotal > limitBytes) {
    throw buildStorageLimitError(projectedTotal, limitBytes);
  }

  return {
    company,
    user: userResult?.user || null,
    usedBytes,
    committedBytes,
    reservedBytes,
    incomingBytes,
    projectedTotal,
    limitBytes,
    limitMb,
    usedMb: bytesToMb(usedBytes),
    incomingMb: bytesToMb(incomingBytes),
    projectedMb: bytesToMb(projectedTotal),
  };
}

async function assertTenantStorageForCompany(company_id, additionalBytes, options = {}) {
  const { filename = null, excludeJobId = null, userId = null } = options;
  const company = await resolveCompanyForStorage(company_id);
  const isTrialSandbox = isTrialSandboxCompanyId(company_id);
  if (!company && !isTrialSandbox) {
    throw new Error("Company not found for provided company_id.");
  }
  if (!company && isTrialSandbox) {
    const incomingBytes = Math.max(0, Number(additionalBytes) || 0);
    return {
      company: {
        id: String(company_id || "").trim() || "trial_unknown",
        company_name: "Free Trial Sandbox",
        storage_limit_mb: DEFAULT_STORAGE_LIMIT_MB,
      },
      usedBytes: 0,
      limitBytes: DEFAULT_STORAGE_LIMIT_MB * BYTES_PER_MB,
      incomingBytes,
      projectedTotal: incomingBytes,
    };
  }

  await assertUserStorageForUpload(userId, additionalBytes, { filename, excludeJobId });

  const limitMb = await getTenantStorageLimit(company.id);
  const limitBytes = limitMb * BYTES_PER_MB;

  let committedBytes = await getCommittedDocumentStorageBytes(company.id);
  if (filename) {
    const replacementBytes = await getReplacementBytesForFilename(company.id, filename);
    committedBytes = Math.max(0, committedBytes - replacementBytes);
  }

  const reservedBytes = await getReservedUploadStorageBytes(company.id, { excludeJobId });
  const usedBytes = committedBytes + reservedBytes;
  const incomingBytes = Math.max(0, Number(additionalBytes) || 0);
  const projectedTotal = usedBytes + incomingBytes;

  if (projectedTotal > limitBytes) {
    throw buildStorageLimitError(projectedTotal, limitBytes);
  }

  return { company, usedBytes, limitBytes, incomingBytes, projectedTotal };
}

function parseQuotaMbInput(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  const parsed = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("storage_limit_mb must be a positive number.");
  }
  return parsed;
}

async function resolveWorkspaceUserQuotaForCreate(company_id, storage_limit_mb) {
  const snapshot = await getTenantStorageSnapshot(company_id);
  if (!snapshot) {
    throw new Error("Company not found.");
  }

  const remainingMb = Math.max(0, Number(snapshot.storage_remaining_mb) || 0);

  if (storage_limit_mb === undefined || storage_limit_mb === null || storage_limit_mb === "") {
    return Math.max(1, Math.floor(remainingMb));
  }

  const requested = parseQuotaMbInput(storage_limit_mb);
  if (requested > remainingMb + 1e-6) {
    throw new Error(
      `User storage quota (${requested.toFixed(2)} MB) exceeds physical space remaining in the company pool (${remainingMb.toFixed(2)} MB available).`
    );
  }

  return Math.max(1, Math.round(requested * 100) / 100);
}

async function assertWorkspaceUserQuotaForUpdate(user_id, storage_limit_mb) {
  const userSnapshot = await getUserStorageSnapshot(user_id);
  if (!userSnapshot) {
    throw new Error("User not found.");
  }

  const user = await Promise.resolve(findUserById(user_id));
  if (!user || user.role !== "user") {
    throw new Error("Storage quota applies only to workspace users.");
  }

  const companySnapshot = await getTenantStorageSnapshot(user.company_id);
  if (!companySnapshot) {
    throw new Error("Company not found.");
  }

  const requested = parseQuotaMbInput(storage_limit_mb);
  const usedMb = Math.max(0, Number(userSnapshot.storage_used_mb) || 0);
  const remainingMb = Math.max(0, Number(companySnapshot.storage_remaining_mb) || 0);
  const maxMb = usedMb + remainingMb;

  if (requested < usedMb - 1e-6) {
    throw new Error(
      `Quota cannot be lower than the user's current storage usage (${usedMb.toFixed(2)} MB).`
    );
  }

  if (requested > maxMb + 1e-6) {
    throw new Error(
      `User storage quota (${requested.toFixed(2)} MB) exceeds physical space available for this user (max ${maxMb.toFixed(2)} MB).`
    );
  }

  return Math.max(1, Math.round(requested * 100) / 100);
}

module.exports = {
  BYTES_PER_MB,
  DEFAULT_STORAGE_LIMIT_MB,
  STORAGE_LIMIT_MESSAGE,
  USER_STORAGE_LIMIT_MESSAGE,
  documentStorageBytes,
  resolveCompanyForStorage,
  getCommittedDocumentStorageBytes,
  getReservedUploadStorageBytes,
  getUserCommittedDocumentStorageBytes,
  getUserReservedUploadStorageBytes,
  getUserTotalStorageUsedBytes,
  getTotalTenantStorageUsedBytes,
  getTotalTenantStorageUsed,
  getTenantStorageLimit,
  getTenantStorageSnapshot,
  getUserStorageSnapshot,
  getReplacementBytesForFilename,
  assertUserStorageForUpload,
  assertTenantStorageForUpload,
  assertTenantStorageForCompany,
  resolveWorkspaceUserQuotaForCreate,
  assertWorkspaceUserQuotaForUpdate,
  backfillOrphanDocumentUploaders,
  getOrphanDocumentAttributionUserId,
  documentCountsTowardUserStorage,
  buildStorageLimitError,
  buildUserStorageLimitError,
  getCompanyStorageUsedBytes: getTotalTenantStorageUsedBytes,
  assertStorageLimitForUpload: assertTenantStorageForUpload,
  assertStorageLimitForCompany: assertTenantStorageForCompany,
};
