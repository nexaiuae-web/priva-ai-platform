const crypto = require("crypto");
const dotenv = require("dotenv");
const {
  getCompanyById: getTenantCompanyById,
  createCompany: createTenantCompany,
  listCompanies: listTenantCompanies,
} = require("./tenantStore");
const Document = require("../models/Document");
const DocumentParent = require("../models/DocumentParent");
const {
  documentStorageBytes,
  getCompanyStorageUsedBytes,
  assertStorageLimitForUpload,
  assertStorageLimitForCompany,
  getOrphanDocumentAttributionUserId,
  documentCountsTowardUserStorage,
  STORAGE_LIMIT_MESSAGE,
} = require("./tenantStorage");

dotenv.config();

function getAesKeyFromMasterKey() {
  if (!process.env.MASTER_KEY || process.env.MASTER_KEY.length < 32) {
    throw new Error("MASTER_KEY is missing or too short in .env.");
  }

  return crypto.createHash("sha256").update(process.env.MASTER_KEY).digest();
}

function decryptExternalApiKey(encrypted) {
  if (encrypted == null || encrypted === "null" || encrypted === "undefined") {
    console.log("[ADMIN] decrypt: no encrypted data, returning null");
    return null;
  }

  if (typeof encrypted === "string") {
    const s = String(encrypted).trim();
    if (!s) {
      console.log("[ADMIN] decrypt: empty string, returning null");
      return null;
    }
    if (!s.includes(":")) {
      console.log("[ADMIN] decrypt: plain text detected, returning as-is");
      return s;
    }
    try {
      const [ivHex, encryptedHex] = s.split(":");
      if (!ivHex || !encryptedHex) {
        throw new Error("Invalid format: missing iv or encrypted data");
      }
      const iv = Buffer.from(ivHex, "hex");
      const ciphertext = Buffer.from(encryptedHex, "hex");
      const key = Buffer.from(String(process.env.MASTER_KEY || "").padEnd(32).slice(0, 32));
      const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
      let decrypted = decipher.update(ciphertext, undefined, "utf8");
      decrypted += decipher.final("utf8");
      console.log("[ADMIN] decrypt: SUCCESS (legacy CBC)");
      return decrypted;
    } catch (e) {
      console.error("[ADMIN] decrypt legacy FAILED:", e.message);
      logDecryptMasterKeyHint();
      console.log("[ADMIN] decrypt: returning null (fallback)");
      return null;
    }
  }

  if (!encrypted.iv || !encrypted.ciphertext || !encrypted.authTag) {
    console.log("[ADMIN] decrypt: invalid object shape, returning null");
    return null;
  }

  try {
    const iv = Buffer.from(encrypted.iv, "hex");
    const authTag = Buffer.from(encrypted.authTag, "hex");
    const ciphertext = Buffer.from(encrypted.ciphertext, "hex");
    const key = getAesKeyFromMasterKey();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    console.log("[ADMIN] decrypt: SUCCESS");
    return decrypted;
  } catch (e) {
    console.error("[ADMIN] decrypt FAILED:", e.message);
    logDecryptMasterKeyHint();
    console.log("[ADMIN] decrypt: returning null (fallback)");
    return null;
  }
}

function logDecryptMasterKeyHint() {
  const mk = process.env.MASTER_KEY;
  console.error("[ADMIN] MASTER_KEY used:", mk ? `${mk.substring(0, 10)}...` : "(not set)");
}

function hashSecretKey(secretKey) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .createHash("sha256")
    .update(`${salt}${secretKey}`)
    .digest("hex");

  return { salt, hash };
}

async function ensureDb() {
  const documents = await Document.find({}).lean();
  const documentParents = await DocumentParent.find({}).lean();
  return {
    companies: [],
    chat_sessions: [],
    folders: [],
    documents,
    document_parents: documentParents,
    trial_trackers: [],
  };
}

async function persistDb(_db) {
  return;
}

async function addCompany({ name, client_id, secret_key, external_api_key }) {
  if (!name || !client_id || !secret_key || !external_api_key) {
    throw new Error("name, client_id, secret_key, and external_api_key are required.");
  }

  if (!String(client_id).startsWith("priva_cli_")) {
    throw new Error("client_id must start with priva_cli_.");
  }

  if (!String(secret_key).startsWith("priva_sk_")) {
    throw new Error("secret_key must start with priva_sk_.");
  }

  const company = createTenantCompany({
    company_name: String(name).trim(),
    openai_api_key: String(external_api_key || "").trim(),
  });

  const secret = hashSecretKey(secret_key);
  return {
    id: company.id,
    name: company.company_name,
    client_id,
    secret_key_hash: secret.hash,
    secret_key_salt: secret.salt,
    external_api_key_encrypted: null,
    created_at: company.created_at,
  };
}

async function listCompaniesSafe() {
  const companies = await Promise.resolve(listTenantCompanies());
  return companies.map((company) => ({
    id: company.id,
    name: company.company_name,
    client_id: company.id,
    created_at: company.created_at,
  }));
}

async function getCompanyById(companyId) {
  const company = await Promise.resolve(getTenantCompanyById(companyId));
  if (!company) return null;
  return {
    id: company.id,
    name: company.company_name,
    external_api_key_encrypted: null,
    created_at: company.created_at,
  };
}

async function removeDocumentsByCompanyAndFilename(company_id, filename) {
  const companyId = String(company_id || "").trim();
  const name = String(filename || "").trim();
  const docs = await Document.find({ company_id: companyId, filename: name }, { id: 1 }).lean();
  const removedIds = docs.map((d) => d.id);
  if (removedIds.length === 0) {
    return { removedDocumentIds: [] };
  }

  await Document.deleteMany({ id: { $in: removedIds } });
  await DocumentParent.deleteMany({ document_id: { $in: removedIds } });
  return { removedDocumentIds: removedIds };
}

async function getDocumentById(documentId) {
  const id = String(documentId || "").trim();
  if (!id) return null;
  return Document.findOne({ id }).lean();
}

function documentMatchesFolderScope(doc, folder_id) {
  const docFolder = doc.folder_id ?? null;
  if (folder_id == null) {
    return docFolder == null || docFolder === "";
  }
  return String(docFolder) === String(folder_id);
}

async function mapDocumentsToListRows(docs) {
  const docIds = docs.map((doc) => String(doc.id));
  const parentCounts = new Map();
  if (docIds.length > 0) {
    const counts = await DocumentParent.aggregate([
      { $match: { document_id: { $in: docIds } } },
      { $group: { _id: "$document_id", count: { $sum: 1 } } },
    ]);
    for (const item of counts) {
      parentCounts.set(String(item._id), Number(item.count) || 0);
    }
  }

  return docs
    .map((doc) => ({
      id: doc.id,
      company_id: doc.company_id,
      folder_id: doc.folder_id ?? null,
      filename: doc.filename,
      mime_type: doc.mime_type,
      created_at: doc.created_at,
      vector_count: Array.isArray(doc.chunks) ? doc.chunks.length : 0,
      parent_count: parentCounts.get(String(doc.id)) || 0,
    }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function findOrphanedTrialDocuments(fingerprint, primaryCompanyId, knownDocIds = new Set()) {
  const fingerprintStr = String(fingerprint || "").trim();
  if (!fingerprintStr) return [];

  const UploadJob = require("../models/UploadJob");
  const jobs = await UploadJob.find({
    is_trial: true,
    $or: [{ trial_fingerprint: fingerprintStr }, { company_id: primaryCompanyId }],
  })
    .select("id company_id result status")
    .lean();

  if (!jobs.length) return [];

  const jobIds = [];
  const altCompanyIds = new Set();
  const resultDocIds = [];

  for (const job of jobs) {
    jobIds.push(String(job.id));
    const jobCompanyId = String(job.company_id || "").trim();
    if (jobCompanyId && jobCompanyId !== primaryCompanyId) {
      altCompanyIds.add(jobCompanyId);
    }
    const result = job.result && typeof job.result === "object" ? job.result : null;
    const docId = result?.document_id || result?.id;
    if (docId) {
      resultDocIds.push(String(docId));
    }
  }

  const orClauses = [{ upload_job_id: { $in: jobIds } }];
  if (resultDocIds.length) {
    orClauses.push({ id: { $in: resultDocIds } });
  }
  if (altCompanyIds.size) {
    orClauses.push({ company_id: { $in: [...altCompanyIds] } });
  }
  orClauses.push({
    company_id: "default",
    upload_job_id: { $in: jobIds },
  });

  const candidates = await Document.find({ $or: orClauses }).lean();
  const orphans = candidates.filter((doc) => !knownDocIds.has(String(doc.id)));

  if (orphans.length) {
    console.warn("[DOCUMENTS] TRIAL orphan fallback matched documents", {
      primaryCompanyId,
      fingerprint: "present",
      orphanCount: orphans.length,
      orphanCompanyIds: [...new Set(orphans.map((doc) => doc.company_id))],
    });
  }

  return orphans;
}

async function listDocumentsForTrialSandbox(company_id, { fingerprint = null } = {}) {
  const companyId = String(company_id || "").trim();
  if (!companyId || !companyId.startsWith("trial_")) {
    return [];
  }

  const primaryDocs = await Document.find({ company_id: companyId }).lean();
  const mergedById = new Map();
  for (const doc of primaryDocs) {
    mergedById.set(String(doc.id), doc);
  }

  const orphanDocs = await findOrphanedTrialDocuments(
    fingerprint,
    companyId,
    new Set([...mergedById.keys()])
  );
  for (const doc of orphanDocs) {
    mergedById.set(String(doc.id), doc);
  }

  return mapDocumentsToListRows([...mergedById.values()]);
}

async function listDocumentsByCompany(
  company_id,
  { user_id = null, folder_id = null, all_folders = false } = {}
) {
  const companyId = String(company_id || "").trim();
  const orphanAttributionUserId = user_id
    ? getOrphanDocumentAttributionUserId(companyId)
    : null;
  const normalizedFolderId =
    folder_id == null || folder_id === "" ? null : String(folder_id).trim();

  const docs = await Document.find({ company_id: companyId }).lean();
  const filtered = docs.filter((doc) => {
    if (!all_folders && !documentMatchesFolderScope(doc, normalizedFolderId)) {
      return false;
    }
    if (!user_id) return true;
    return documentCountsTowardUserStorage(
      doc,
      user_id,
      companyId,
      orphanAttributionUserId
    );
  });

  return mapDocumentsToListRows(filtered);
}

async function deleteDocumentById(company_id, documentId) {
  const companyId = String(company_id || "").trim();
  const docId = String(documentId || "").trim();
  const doc = await Document.findOneAndDelete({ id: docId, company_id: companyId }).lean();
  if (!doc) return null;

  await DocumentParent.deleteMany({ document_id: docId });
  return doc;
}

async function moveDocumentToFolder(company_id, documentId, folder_id = null) {
  const companyId = String(company_id || "").trim();
  const docId = String(documentId || "").trim();
  const normalizedFolderId =
    folder_id == null || folder_id === "" ? null : String(folder_id).trim();

  const doc = await Document.findOneAndUpdate(
    { id: docId, company_id: companyId },
    { $set: { folder_id: normalizedFolderId, updated_at: new Date() } },
    { new: true, lean: true }
  );
  return doc || null;
}

async function saveDocumentParents(parentRecords) {
  if (!parentRecords || parentRecords.length === 0) return;
  const normalized = parentRecords.map((record) => ({
    ...record,
    created_at: record.created_at || new Date().toISOString(),
  }));
  await DocumentParent.insertMany(normalized, { ordered: false });
}

async function getParentById(parentId) {
  const id = String(parentId || "").trim();
  if (!id) return null;
  return DocumentParent.findOne({ id }).lean();
}

async function getParentsForDocument(documentId) {
  const id = String(documentId || "").trim();
  if (!id) return [];
  return DocumentParent.find({ document_id: id }).lean();
}

const { resolveCompanyForStorage } = require("./tenantStorage");

async function resolveCompanyForDocuments(company_id) {
  return resolveCompanyForStorage(company_id);
}

async function saveDocumentForCompany({
  company_id,
  filename,
  mime_type,
  chunks,
  raw_ocr_text,
  cleaned_text,
  raw_text_length,
  cleaned_text_length,
  detected_document_type,
  ocr_verification,
  file_size_bytes = 0,
  upload_job_id = null,
  uploaded_by_user_id = null,
  folder_id = null,
}) {
  const normalizedCompanyId = String(company_id || "").trim();
  const isTrialSandbox = normalizedCompanyId.startsWith("trial_");
  const incomingBytes =
    Math.max(0, Number(file_size_bytes) || 0) ||
    Math.max(0, Number(raw_text_length) || 0) + Math.max(0, Number(cleaned_text_length) || 0);

  let userId = uploaded_by_user_id;
  if (!userId && upload_job_id) {
    try {
      const { getUploadJob } = require("./uploadJobs");
      const job = await getUploadJob(upload_job_id);
      userId = job?.user_id || null;
    } catch {
      userId = null;
    }
  }

  if (!isTrialSandbox) {
    await assertStorageLimitForCompany(normalizedCompanyId, incomingBytes, {
      filename,
      excludeJobId: upload_job_id,
      userId,
    });
  } else {
    console.log("[DOC-SAVE] Trial sandbox bypass", {
      company_id: normalizedCompanyId,
      filename,
      incoming_bytes: incomingBytes,
      upload_job_id: upload_job_id || null,
    });
  }

  const normalizedFolderId =
    folder_id == null || folder_id === "" ? null : String(folder_id).trim();

  const documentRecord = {
    id: `doc_${crypto.randomBytes(6).toString("hex")}`,
    company_id: normalizedCompanyId,
    folder_id: normalizedFolderId,
    uploaded_by_user_id: userId || null,
    filename,
    mime_type,
    chunks,
    raw_ocr_text,
    cleaned_text,
    raw_text_length,
    cleaned_text_length,
    detected_document_type,
    ocr_verification,
    file_size_bytes: incomingBytes,
    upload_job_id: upload_job_id || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: "complete",
    vector_indexed: false,
  };

  try {
    await Document.create(documentRecord);
    console.log("[DOC-SAVE] MongoDB document created", {
      id: documentRecord.id,
      company_id: documentRecord.company_id,
      filename: documentRecord.filename,
      upload_job_id: documentRecord.upload_job_id,
    });
    return documentRecord;
  } catch (error) {
    console.error("[DOC-SAVE] MongoDB create failed:", error.message);
    if (error?.stack) {
      console.error(error.stack);
    }
    throw error;
  }
}

module.exports = {
  ensureDb,
  persistDb,
  addCompany,
  decryptExternalApiKey,
  getCompanyById,
  getDocumentById,
  getParentById,
  getParentsForDocument,
  listCompaniesSafe,
  listDocumentsByCompany,
  listDocumentsForTrialSandbox,
  deleteDocumentById,
  moveDocumentToFolder,
  removeDocumentsByCompanyAndFilename,
  saveDocumentForCompany,
  saveDocumentParents,
  resolveCompanyForDocuments,
  getCompanyStorageUsedBytes,
  assertStorageLimitForCompany,
  assertStorageLimitForUpload,
  documentStorageBytes,
  STORAGE_LIMIT_MESSAGE,
};
