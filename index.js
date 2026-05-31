require("dotenv").config();
const { connectDatabase } = require("./config/database");

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const multer = require("multer");

// ✅ استبدال LangChain بـ ChromaDB Native Client
const { CHROMA_DATA_DIR, ensureChromaServer } = require("./services/chromaClient");
const {
  deleteByDocumentId,
  updateFolderIdForDocument,
  searchVectors,
  initializeChromaCollection,
} = require("./services/vectorStore");

const {
  addCompany,
  decryptExternalApiKey,
  getCompanyById,
  getDocumentById,
  getParentById,
  listCompaniesSafe,
  listDocumentsByCompany,
  listDocumentsForTrialSandbox,
  deleteDocumentById,
  moveDocumentToFolder,
  assertStorageLimitForUpload,
  STORAGE_LIMIT_MESSAGE,
} = require("./services/admin");
const {
  getTenantStorageSnapshot,
  getUserStorageSnapshot,
  resolveWorkspaceUserQuotaForCreate,
  assertWorkspaceUserQuotaForUpdate,
  backfillOrphanDocumentUploaders,
  documentCountsTowardUserStorage,
  getOrphanDocumentAttributionUserId,
  USER_STORAGE_LIMIT_MESSAGE,
} = require("./services/tenantStorage");
const { attachApiAuth, requireMasterKey } = require("./services/auth");
const { requireAuth, requireAdmin, signUserToken } = require("./services/jwtAuth");
const {
  verifyUserFace,
  registerAdminFaceProfiles,
  removeFaceProfileForUser,
  loadFaceModels,
  referenceImageExists,
  getFaceProfile,
  getFaceReferenceCount,
  isFaceProcessingError,
  MAX_FACE_REFERENCES,
  FACE_PROFILE_NOT_CONFIGURED_MESSAGE,
} = require("./services/faceVerification");
const { startFrontendDevServer } = require("./services/frontendDev");
const {
  initTenantStore,
  createCompany: createTenantCompany,
  createUser: createTenantUser,
  updateUserById: updateTenantUser,
  getCompanyById: getTenantCompanyById,
  listCompaniesWithStats,
  getTenantMetrics,
  updateCompanyLimits,
  verifyUserCredentials,
  createUserSession,
  findUserById,
  isSystemAdminAccount,
  listUsersForAdmin,
} = require("./services/tenantStore");
const { purgeWorkspaceUser, purgeCompanyWithUsers } = require("./services/userLifecycle");
const {
  forwardRouteError,
  wrapRoute,
  respondDocumentsList,
} = require("./services/routeHandler");
const { resolveCompanyId, resolveCompanyRecord } = require("./services/companyResolver");
const { isImageUpload, isPdfUpload } = require("./services/fileType");
const {
  ArabicParentDocumentRetriever,
  retrieveForChat,
  CHAT_FETCH_N,
  CHAT_TOP_K,
  collectUniqueSourceFilenames,
  debugLogContextsForLlm,
  FOLDER_EMPTY_MESSAGE,
} = require("./services/retriever");
const { buildMessagesForChat } = require("./services/promptManager");
const {
  budgetRetrievedContexts,
  fitMessagesToTokenBudget,
  parseRequestHistory,
  CHAT_MAX_CHUNKS,
  estimateMessagesTokens,
} = require("./services/contextBudget");
const { streamChatCompletion } = require("./services/llm");
const {
  getChatProvider,
  getOpenAIChatModel,
  isOpenAIChatEnabled,
} = require("./services/chatConfig");

const {
  beginSse,
  writeSse,
  writeSseData,
  writeStreamToken,
  wantsEventStream,
} = require("./services/sse");
const {
  createUploadJob,
  updateUploadJob,
  getUploadJob,
  listUploadJobsByCompany,
} = require("./services/uploadJobs");
const { enqueueUploadJob } = require("./services/uploadQueue");
const { setDocumentUploadRetriever } = require("./services/documentUploadWorker");
const {
  enforceTrialChatLimit,
  checkTrialUploadLimits,
  getTrialStatusFromRequest,
  isTrialModeRequest,
  isValidTrialCompanyId,
  getFingerprintFromRequest,
  getTrialCompanyIdForRequest,
  attachTrialAuthContext,
} = require("./services/trialTracker");
const {
  getUploadStagingDir,
  useMongoVectorStore,
  isRenderPlatform,
} = require("./services/runtimeConfig");

const UPLOAD_STAGING_DIR = getUploadStagingDir();

const retriever = new ArabicParentDocumentRetriever({
  resolveApiKey: async (company) => {
    console.log("[AUTH] Resolving API key for company:", company?.name ?? company?.id);

    let decrypted = null;
    try {
      decrypted = decryptExternalApiKey(company.external_api_key_encrypted);
    } catch (e) {
      console.warn("[AUTH] Decrypt failed:", e.message);
    }

    if (decrypted && String(decrypted).trim()) {
      console.log("[AUTH] Using decrypted external key");
      return String(decrypted).trim();
    }

    console.log("[AUTH] No external key — using Ollama local (no key needed)");
    return null;
  },
});

function maskApiKey(key) {
  if (!key || typeof key !== "string") return "NULL";
  const s = key.trim();
  if (s.length <= 12) return `${s.slice(0, 4)}…`;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * Retrieve RAG contexts — semantic search + global multi-document fallback when needed.
 */
async function retrieveContextsViaChromaNative(
  question,
  companyId,
  topK,
  fetchN,
  { user_id = null, folder_id = null } = {}
) {
  const { getEmbeddingProvider } = require("./services/embeddings");
  console.log(
    `[RAG] ${getEmbeddingProvider()} embeddings + Chroma | company_id=${companyId}, user_id=${user_id || "(company)"}, folder_id=${folder_id || "(root)"}, topK=${topK}, fetchN=${fetchN}, question="${question.substring(0, 60)}..."`
  );

  return retrieveForChat({
    question,
    company_id: companyId,
    user_id,
    folder_id,
    topK,
    fetchN,
    embedText: (text) => retriever.embedText(text),
  });
}

const app = express();

const CORS_ORIGINS = String(
  process.env.CORS_ORIGINS ||
    "http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || CORS_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "x-company-id",
      "x-master-key",
      "x-plan-mode",
      "x-device-fingerprint",
    ],
  })
);

const PORT = Number(process.env.PORT) || 3005;

const PUBLIC_DIR = path.join(__dirname, "public");

// ============================================
// BOOT
// ============================================
console.log("\n========================================");
console.log("[BOOT] PRIVA-AI starting");
console.log("[BOOT] __dirname:", __dirname);
console.log("[BOOT] PUBLIC_DIR:", PUBLIC_DIR);
console.log("[BOOT] process.cwd():", process.cwd());
console.log("[BOOT] PORT:", PORT);
console.log("[BOOT] Chroma: local embedded only | persist:", CHROMA_DATA_DIR);
const { getChatModel, getPrimaryEmbedModel, EMBED_DIM_DEFAULT } = require("./services/ollamaConfig");
const {
  getEmbeddingProvider,
  isOpenAIProvider,
  getOpenAIEmbedModel,
} = require("./services/embeddings");
console.log("[BOOT] OLLAMA_URL:", process.env.OLLAMA_URL || "http://127.0.0.1:11434");
console.log("[BOOT] CHAT_PROVIDER:", getChatProvider());
if (isOpenAIChatEnabled()) {
  console.log("[BOOT] OPENAI_CHAT_MODEL:", getOpenAIChatModel());
  const oaKey = String(process.env.OPENAI_API_KEY || "").trim();
  console.log("[BOOT] OPENAI_API_KEY (chat):", oaKey ? `set (${oaKey.slice(0, 7)}…)` : "NOT SET");
} else {
  console.log("[BOOT] OLLAMA_CHAT_MODEL:", getChatModel());
}
console.log("[BOOT] EMBEDDING_PROVIDER:", getEmbeddingProvider());
if (isOpenAIProvider()) {
  const oaKey = String(process.env.OPENAI_API_KEY || "").trim();
  console.log("[BOOT] OPENAI_EMBED_MODEL:", getOpenAIEmbedModel());
  console.log("[BOOT] OPENAI_API_KEY:", oaKey ? `set (${oaKey.slice(0, 7)}…)` : "NOT SET");
} else {
  console.log("[BOOT] OLLAMA_EMBED_MODEL:", getPrimaryEmbedModel());
}
console.log("[BOOT] CHROMA_EMBED_DIM:", EMBED_DIM_DEFAULT);
{
  const mk = String(process.env.MASTER_KEY || "").trim();
  if (mk) {
    console.log("[BOOT] MASTER_KEY loaded: prefix", mk.slice(0, 10) + "…", "| length", mk.length, "chars");
  } else {
    console.warn("[BOOT] MASTER_KEY: NOT SET (admin routes will return 500)");
  }
}
console.log("========================================\n");

try {
  console.log("[BOOT] cwd sample files:", fs.readdirSync(process.cwd()).slice(0, 15).join(", "));
} catch (e) {
  console.warn("[BOOT] readdirSync cwd:", e.message);
}

if (!fs.existsSync(CHROMA_DATA_DIR)) {
  fs.mkdirSync(CHROMA_DATA_DIR, { recursive: true });
  console.log("[BOOT] Created CHROMA_DATA_DIR:", CHROMA_DATA_DIR);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdirSync(UPLOAD_STAGING_DIR, { recursive: true });
      cb(null, UPLOAD_STAGING_DIR);
    },
    filename: (req, _file, cb) => {
      const uploadId = crypto.randomUUID();
      req.pendingUploadId = uploadId;
      cb(null, `${uploadId}.bin`);
    },
  }),
  limits: { fileSize: 5000 * 1024 * 1024 }, // Support up to 5000 MB per single file
});

setDocumentUploadRetriever(retriever);

const faceImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = String(file.mimetype || "").toLowerCase();
    if (mime === "image/jpeg" || mime === "image/jpg" || mime === "image/png") {
      return cb(null, true);
    }
    return cb(new Error("Only JPG or PNG face images are allowed."));
  },
});

const faceImageUploadFields = faceImageUpload.fields([
  { name: "face_image", maxCount: 1 },
  { name: "face_images", maxCount: MAX_FACE_REFERENCES },
]);

function collectFaceImageBuffers(req) {
  const buffers = [];
  if (req.file?.buffer?.length) {
    buffers.push(req.file.buffer);
  }
  const files = req.files;
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (entry?.buffer?.length) buffers.push(entry.buffer);
    }
  } else if (files && typeof files === "object") {
    for (const fieldName of ["face_image", "face_images"]) {
      const group = files[fieldName];
      if (!Array.isArray(group)) continue;
      for (const entry of group) {
        if (entry?.buffer?.length) buffers.push(entry.buffer);
      }
    }
  }
  return buffers;
}

function parseFaceUploadReplaceFlag(req) {
  const raw = req.query?.replace ?? req.body?.replace ?? "";
  return String(raw).toLowerCase() === "true" || String(raw) === "1";
}

function respondToFaceProcessingError(res, error) {
  const code = error?.code || "NO_FACE_DETECTED";
  const message =
    error?.message || "Could not detect a valid face in the image. Please use a clear, front-facing photo.";

  if (code === "FACE_MODEL_ERROR") {
    return res.status(503).json({ error: code, message });
  }

  return res.status(400).json({
    error: code === "FACE_PROCESSING_FAILED" ? code : "NO_FACE_DETECTED",
    message,
  });
}

/** Accept multipart field `file` or `document` (frontend may use either). */
function discardStagedUploadFile(req) {
  try {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  } catch {
    /* ignore */
  }
}

function documentUploadMiddleware(req, res, next) {
  const multerHandler = upload.fields([
    { name: "file", maxCount: 1 },
    { name: "document", maxCount: 1 },
  ]);

  multerHandler(req, res, (err) => {
    if (err) {
      return next(err);
    }
    try {
      const files = req.files || {};
      req.file = files.file?.[0] || files.document?.[0] || null;
      return next();
    } catch (setupError) {
      return next(setupError);
    }
  });
}

function forwardUploadHandlerError(res, next, error) {
  if (res.headersSent) {
    return;
  }
  const quotaResponse = handleStorageQuotaError(res, error);
  if (quotaResponse) {
    return quotaResponse;
  }
  return forwardRouteError(res, next, error, "UPLOAD");
}

function buildStorageLimitPayload(storageError) {
  return {
    error: "STORAGE_LIMIT_REACHED",
    code: "STORAGE_LIMIT_REACHED",
    message: STORAGE_LIMIT_MESSAGE,
    storage_pool_scope: "company",
    used_mb: storageError?.used_mb ?? null,
    limit_mb: storageError?.limit_mb ?? null,
    used_bytes: storageError?.used_bytes ?? null,
    limit_bytes: storageError?.limit_bytes ?? null,
  };
}

function respondStorageLimit(res, storageError) {
  return res.status(400).json(buildStorageLimitPayload(storageError));
}

function buildUserStorageLimitPayload(storageError) {
  return {
    error: "USER_STORAGE_LIMIT_REACHED",
    code: "USER_STORAGE_LIMIT_REACHED",
    message: USER_STORAGE_LIMIT_MESSAGE,
    storage_pool_scope: "user",
    used_mb: storageError?.used_mb ?? null,
    limit_mb: storageError?.limit_mb ?? null,
    used_bytes: storageError?.used_bytes ?? null,
    limit_bytes: storageError?.limit_bytes ?? null,
  };
}

function respondUserStorageLimit(res, storageError) {
  return res.status(400).json(buildUserStorageLimitPayload(storageError));
}

function handleStorageQuotaError(res, storageError) {
  if (storageError?.code === "USER_STORAGE_LIMIT_REACHED") {
    return respondUserStorageLimit(res, storageError);
  }
  if (storageError?.code === "STORAGE_LIMIT_REACHED") {
    return respondStorageLimit(res, storageError);
  }
  return null;
}

async function enrichCompaniesWithStoragePool(companies) {
  return Promise.all(
    companies.map(async (company) => {
      const snapshot = await getTenantStorageSnapshot(company.id);
      if (!snapshot) {
        return {
          ...company,
          storage_pool_scope: "company",
          storage_used_mb: 0,
          storage_remaining_mb: Number(company.storage_limit_mb) || 0,
        };
      }
      return {
        ...company,
        storage_pool_scope: snapshot.storage_pool_scope,
        storage_used_mb: snapshot.storage_used_mb,
        storage_committed_mb: snapshot.storage_committed_mb,
        storage_reserved_mb: snapshot.storage_reserved_mb,
        storage_remaining_mb: snapshot.storage_remaining_mb,
      };
    })
  );
}

async function resolveUploadCompanyId(req) {
  if (isTrialModeRequest(req)) {
    const trialCompanyId = getTrialCompanyIdForRequest(req);
    if (!isValidTrialCompanyId(trialCompanyId)) {
      return null;
    }
    attachTrialAuthContext(req, trialCompanyId);
    return trialCompanyId;
  }

  const companyId = await resolveCompanyId(req);
  req.auth = req.auth || {};
  req.auth.company_id = companyId;
  if (companyId && companyId !== "default") {
    console.log("[UPLOAD] company_id:", companyId);
  }
  return companyId;
}

async function acceptDocumentUploadCore(req, res) {
  const uploadId = req.pendingUploadId || crypto.randomUUID();

  console.log("\n========== [UPLOAD] REQUEST RECEIVED (background mode) ==========");
  console.log("[UPLOAD] Timestamp:", new Date().toISOString());
  console.log("[UPLOAD] Path:", req.originalUrl);
  console.log("[UPLOAD] upload_id:", uploadId);

  if (!req.file) {
    console.error("[UPLOAD] ❌ No file in multipart (fields: file, document)");
    res.status(400).json({
      error: "No file received. Use multipart field name 'file' or 'document'.",
    });
    return;
  }

  const mimeType = String(req.file.mimetype || "").toLowerCase();
  const isPdf = isPdfUpload(req.file);
  const isImage = isImageUpload(req.file);

  console.log(
    "[UPLOAD] ✅ File staged:",
    req.file.originalname,
    req.file.size,
    "bytes | path:",
    req.file.path
  );

  if (!isPdf && !isImage) {
    discardStagedUploadFile(req);
    res.status(400).json({
      error:
        "Unsupported file type. Upload a PDF or an image (PNG, JPG, JPEG, WEBP, GIF, BMP, TIFF).",
      mimetype: mimeType || null,
      filename: req.file.originalname,
    });
    return;
  }

  const companyId = await resolveUploadCompanyId(req);
  if (!companyId && isTrialModeRequest(req)) {
    respondMissingTrialFingerprint(res);
    return;
  }
  const trialMode = isTrialModeRequest(req);
  const company = trialMode
    ? { id: companyId, company_name: "Free Trial Sandbox", name: "Free Trial Sandbox" }
    : await resolveCompanyRecord(companyId);
  if (!company) {
    res.status(404).json({ error: "Company not found.", company_id: companyId });
    return;
  }

  const userId = req.auth?.user?.id || null;
  const { normalizeFolderId, assertFolderAccess } = require("./services/folders");
  const folder_id = normalizeFolderId(
    req.body?.folder_id ?? req.body?.folderId ?? req.query?.folder_id
  );

  if (trialMode && folder_id) {
    res.status(400).json({
      error: "TRIAL_FOLDER_SCOPE_NOT_ALLOWED",
      code: "TRIAL_FOLDER_SCOPE_NOT_ALLOWED",
      message: "Folder-scoped uploads are not available in Free Trial mode.",
    });
    return;
  }

  if (folder_id && !trialMode) {
    await assertFolderAccess(folder_id, {
      user_id: userId,
      company_id: company.id,
    });
  }

  if (!trialMode) {
    try {
      await assertStorageLimitForUpload(company.id, req.file.size, {
        filename: req.file.originalname,
        userId,
      });
    } catch (storageError) {
      const quotaResponse = handleStorageQuotaError(res, storageError);
      if (quotaResponse) {
        return;
      }
      throw storageError;
    }
  }

  await createUploadJob({
    id: uploadId,
    user_id: userId,
    folder_id,
    company_id: company.id,
    is_trial: trialMode,
    trial_fingerprint: trialMode ? getFingerprintFromRequest(req) : null,
    filename: req.file.originalname,
    mime_type: req.file.mimetype,
    file_path: req.file.path,
    file_size_bytes: req.file.size,
    status: "processing",
    phase: "queued",
    message: "File received — queued for background processing",
    percent: 2,
  });

  enqueueUploadJob(uploadId);

  res.status(202).json({
    upload_id: uploadId,
    job_id: uploadId,
    status: "processing",
    message:
      "Document accepted. Processing continues in the background even if you close the app.",
    filename: req.file.originalname,
    poll_url: `/api/documents/status/${uploadId}`,
  });
}

function acceptDocumentUpload(req, res, next) {
  void acceptDocumentUploadCore(req, res).catch((error) => {
    console.error("[UPLOAD] ❌ accept:", error.message);
    discardStagedUploadFile(req);
    forwardUploadHandlerError(res, next, error);
  });
}

async function resolveDocumentsCompanyId(req) {
  if (isTrialModeRequest(req)) {
    const trialCompanyId = getTrialCompanyIdForRequest(req);
    if (!isValidTrialCompanyId(trialCompanyId)) {
      return null;
    }
    attachTrialAuthContext(req, trialCompanyId);
    return trialCompanyId;
  }
  return resolveCompanyId(req);
}

function serializeDocumentListItem(doc) {
  return {
    id: doc.id,
    filename: doc.filename,
    folder_id: doc.folder_id ?? null,
    uploadedAt: doc.created_at,
    created_at: doc.created_at,
    mime_type: doc.mime_type,
    vector_count: doc.vector_count,
  };
}

function respondMissingTrialFingerprint(res) {
  return res.status(400).json({
    error: "TRIAL_FINGERPRINT_REQUIRED",
    code: "TRIAL_FINGERPRINT_REQUIRED",
    message:
      "Free Trial requests require x-device-fingerprint for strict data isolation.",
  });
}

function resolveWorkspaceDocumentUserScope(req) {
  const user = req.auth?.user;
  if (!user?.id) return null;
  const role = String(user.role || "").trim().toLowerCase();
  return role === "user" ? String(user.id) : null;
}

function resolveFolderIdFromRequest(req) {
  const { normalizeFolderId } = require("./services/folders");
  const raw = req.query?.folder_id ?? req.body?.folder_id ?? req.body?.folderId;
  return normalizeFolderId(raw);
}

async function listDocumentsHandlerCore(req, res) {
  // CRITICAL: Free Trial must never reach premium/root company resolution below.
  if (isTrialModeRequest(req)) {
    const trialCompanyId = getTrialCompanyIdForRequest(req);
    if (!isValidTrialCompanyId(trialCompanyId)) {
      console.warn("[DOCUMENTS] TRIAL isolation — empty list (invalid sandbox id)", {
        trialCompanyId: trialCompanyId ?? null,
        fingerprint: getFingerprintFromRequest(req) ? "present" : "missing",
        plan_mode: req.headers["x-plan-mode"] ?? null,
      });
      return respondDocumentsList(res, []);
    }

    attachTrialAuthContext(req, trialCompanyId);
    const docs = await listDocumentsForTrialSandbox(trialCompanyId);
    const payload = docs.map(serializeDocumentListItem);

    console.log(
      "[DOCUMENTS] TRIAL GET",
      trialCompanyId,
      "→",
      payload.length,
      "items (strict sandbox)"
    );
    return respondDocumentsList(res, payload);
  }

  const companyId = await resolveCompanyId(req);
  if (!companyId) {
    return res.status(400).json({ error: "company_id could not be resolved." });
  }

  const scopeUserId = resolveWorkspaceDocumentUserScope(req);
  const folder_id = resolveFolderIdFromRequest(req);

  if (req.auth?.user && String(req.auth.user.role || "").toLowerCase() === "user" && !scopeUserId) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const company = await resolveCompanyRecord(companyId);
  if (!company) {
    return res.status(404).json({ error: "Company not found." });
  }

  if (folder_id) {
    const { assertFolderAccess } = require("./services/folders");
    await assertFolderAccess(folder_id, {
      user_id: scopeUserId,
      company_id: companyId,
    });
  }

  const docs = await listDocumentsByCompany(companyId, {
    user_id: scopeUserId,
    folder_id,
  });
  const payload = docs.map(serializeDocumentListItem);

  console.log(
    "[DOCUMENTS] GET",
    companyId,
    "folder:",
    folder_id || "(root)",
    "→",
    payload.length,
    "items"
  );
  return respondDocumentsList(res, payload);
}

const listDocumentsHandler = wrapRoute(listDocumentsHandlerCore, "DOCUMENTS");

async function listFoldersHandlerCore(req, res) {
  if (isTrialModeRequest(req)) {
    return res.status(200).json({ folders: [] });
  }

  const companyId = await resolveDocumentsCompanyId(req);
  if (!companyId && isTrialModeRequest(req)) {
    return respondMissingTrialFingerprint(res);
  }
  const scopeUserId = resolveWorkspaceDocumentUserScope(req);

  if (!scopeUserId) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const { listFoldersForUser } = require("./services/folders");
  const folders = await listFoldersForUser({
    user_id: scopeUserId,
    company_id: companyId,
  });

  return res.status(200).json({ folders });
}

const listFoldersHandler = wrapRoute(listFoldersHandlerCore, "FOLDERS");

async function createFolderHandler(req, res, next) {
  try {
    if (isTrialModeRequest(req)) {
      return res.status(403).json({
        error: "TRIAL_FOLDER_CREATE_BLOCKED",
        code: "TRIAL_FOLDER_CREATE_BLOCKED",
        message: "Folder creation is not available in Free Trial mode.",
      });
    }

    const companyId = await resolveDocumentsCompanyId(req);
    if (!companyId && isTrialModeRequest(req)) {
      return respondMissingTrialFingerprint(res);
    }
    const scopeUserId = resolveWorkspaceDocumentUserScope(req);
    const name = String(req.body?.name || req.body?.folder_name || "").trim();

    if (!scopeUserId) {
      return res.status(401).json({ error: "Authentication required." });
    }
    if (!name) {
      return res.status(400).json({ error: "Folder name is required." });
    }

    const { createFolderForUser } = require("./services/folders");
    const folder = await createFolderForUser({
      name,
      user_id: scopeUserId,
      company_id: companyId,
    });

    return res.status(201).json({ folder });
  } catch (err) {
    if (err.message?.includes("already exists")) {
      return res.status(409).json({ error: err.message });
    }
    console.error("[FOLDERS] create failed:", err.message);
    if (err.stack) console.error(err.stack);
    return next(err);
  }
}

// ============================================
// 1️⃣ Core middleware
// ============================================
app.use(express.json({ limit: "15mb" }));

app.use((req, res, next) => {
  const ct = req.headers["content-type"] || "none";
  console.log(`[HTTP] ${req.method} ${req.path} | Content-Type: ${ct}`);
  next();
});

// ============================================
// 2️⃣ Public entry points — no JWT / company middleware
// ============================================
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    api: `http://localhost:${PORT}`,
    frontend: "http://localhost:8080 (run Vite separately or START_FRONTEND_DEV=1)",
  });
});

app.get("/chat", (_req, res) => {
  const chatHtmlPath = path.join(PUBLIC_DIR, "chat.html");
  res.sendFile(chatHtmlPath, (err) => {
    if (err) {
      console.error("[GET /chat] sendFile failed:", err.message);
      if (!res.headersSent) {
        res.status(500).send("Could not load chat.html");
      }
    }
  });
});

// ============================================
// 3️⃣ الملفات الثابتة
// ============================================
app.use(express.static(PUBLIC_DIR));

// ============================================
// 4️⃣ API ROUTES — auth middleware scoped to /api and /admin only
// ============================================

async function loginHandler(req, res) {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: "username and password are required.",
      });
    }

    const authResult = await verifyUserCredentials(username, password);
    if (!authResult) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const { user, company } = authResult;

    const { token, jti, expiresAt } = signUserToken(user, company);
    await createUserSession({
      user_id: user.id,
      company_id: company.id,
      jti,
      expires_at: expiresAt,
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      user: {
        username: user.username,
        role: user.role,
        company_id: company.id,
        company_name: company.company_name,
      },
    });
  } catch (error) {
    console.error("[LOGIN] error:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Login failed.",
    });
  }
}

const apiRouter = express.Router();
apiRouter.use(attachApiAuth);

const chatRouter = express.Router();
const uploadRouter = express.Router();
const documentsRouter = express.Router();
const adminRouter = express.Router();

adminRouter.post("/add-company", requireMasterKey, async (req, res, next) => {
  try {
    const company = await addCompany(req.body);
    return res.status(201).json({
      message: "Company created successfully.",
      company: {
        id: company.id,
        name: company.name,
        client_id: company.client_id,
        created_at: company.created_at,
      },
    });
  } catch (error) {
    return next(error);
  }
});

adminRouter.get("/companies", requireAuth, requireAdmin, async (req, res) => {
  try {
    console.log(
      "[ADMIN] GET /companies | user:",
      req.auth?.user?.username,
      "| role:",
      req.auth?.user?.role
    );
    const companies = await enrichCompaniesWithStoragePool(
      await Promise.resolve(listCompaniesWithStats())
    );
    const metrics = await Promise.resolve(getTenantMetrics());
    const total_storage_used_mb = companies.reduce(
      (sum, company) => sum + Number(company.storage_used_mb || 0),
      0
    );
    return res.json({
      companies,
      metrics: {
        ...metrics,
        total_storage_used_mb,
        storage_pool_scope: "company",
      },
    });
  } catch (error) {
    console.error("[ADMIN] GET /companies error:", error);
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

adminRouter.post("/companies", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const company_name = String(req.body?.company_name || "").trim();
    const openai_api_key = String(req.body?.openai_api_key || "").trim();
    if (!company_name) {
      return res.status(400).json({ error: "company_name is required." });
    }

    const company = createTenantCompany({
      company_name,
      openai_api_key,
      storage_limit_mb: req.body?.storage_limit_mb ?? req.body?.storage_limit,
    });

    const admin_username = String(req.body?.admin_username || "").trim();
    const admin_password = String(req.body?.admin_password || "");
    let user = null;
    if (admin_username && admin_password) {
      user = createTenantUser({
        username: admin_username,
        password: admin_password,
        company_id: company.id,
        role: "admin",
      });
    } else if (admin_username || admin_password) {
      return res.status(400).json({
        error: "admin_username and admin_password must both be provided to create an initial user.",
      });
    }

    return res.status(201).json({
      message: "Company created successfully.",
      company: {
        id: company.id,
        company_name: company.company_name,
      },
      user,
    });
  } catch (error) {
    return next(error);
  }
});

async function updateCompanyHandler(req, res, next) {
  try {
    const companyId = String(req.params.id || "").trim();
    if (!companyId) {
      return res.status(400).json({ error: "Company id is required." });
    }

    const storage_limit_mb = req.body?.storage_limit_mb ?? req.body?.storage_limit;

    if (storage_limit_mb === undefined || storage_limit_mb === null || storage_limit_mb === "") {
      return res.status(400).json({
        error: "storage_limit_mb is required.",
      });
    }

    console.log(
      "[ADMIN] PATCH/PUT /companies/:id | id:",
      companyId,
      "| storage_limit_mb:",
      storage_limit_mb
    );

    const company = updateCompanyLimits(companyId, { storage_limit_mb });
    if (!company) {
      return res.status(404).json({ error: "Company not found.", company_id: companyId });
    }

    return res.status(200).json({
      message: "Company plan updated successfully.",
      company,
    });
  } catch (error) {
    if (error.message?.includes("must be a positive integer")) {
      return res.status(400).json({ error: error.message });
    }
    return next(error);
  }
}

adminRouter.patch("/companies/:id", requireAuth, requireAdmin, updateCompanyHandler);
adminRouter.put("/companies/:id", requireAuth, requireAdmin, updateCompanyHandler);

adminRouter.get("/users", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const userRows = await Promise.resolve(listUsersForAdmin());
    const users = await Promise.all(
      userRows.map(async (user) => {
        const profile = await getFaceProfile(user.id);
        const referenceCount = await getFaceReferenceCount(user.id);
        const storageSnapshot = await getUserStorageSnapshot(user.id);
        return {
          ...user,
          storage_limit_mb: storageSnapshot?.storage_limit_mb ?? user.storage_limit_mb,
          storage_used_mb: storageSnapshot?.storage_used_mb ?? 0,
          storage_remaining_mb: storageSnapshot?.storage_remaining_mb ?? 0,
          has_face_profile:
            (profile?.reference_count || 0) > 0 ||
            (await referenceImageExists(user.id)),
          face_reference_count: referenceCount,
          max_face_references: MAX_FACE_REFERENCES,
          reference_image_paths: profile?.reference_image_paths || [],
          reference_image_path: profile?.reference_image_paths?.[0] || null,
        };
      })
    );
    return res.json({ users });
  } catch (error) {
    console.error("[ADMIN] GET /users error:", error);
    return res.status(500).json({ error: error?.message || String(error) });
  }
});

adminRouter.post("/users", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");
    const company_id = String(req.body?.company_id || "").trim();
    const storage_limit_mb_raw = req.body?.storage_limit_mb ?? req.body?.storage_limit;

    if (!username || !password || !company_id) {
      return res.status(400).json({
        error: "username, password, and company_id are required.",
      });
    }

    const storage_limit_mb = await resolveWorkspaceUserQuotaForCreate(
      company_id,
      storage_limit_mb_raw
    );

    const user = await Promise.resolve(
      createTenantUser({
        username,
        password,
        company_id,
        role: "user",
        storage_limit_mb,
      })
    );

    const storageSnapshot = await getUserStorageSnapshot(user.id);

    return res.status(201).json({
      message: "Workspace user created.",
      user: {
        ...user,
        storage_used_mb: storageSnapshot?.storage_used_mb ?? 0,
        storage_remaining_mb: storageSnapshot?.storage_remaining_mb ?? 0,
      },
    });
  } catch (error) {
    if (error.message?.includes("already taken")) {
      return res.status(409).json({ error: error.message });
    }
    if (error.message?.includes("Company not found")) {
      return res.status(404).json({ error: error.message });
    }
    if (
      error.message?.includes("storage_limit_mb") ||
      error.message?.includes("company pool") ||
      error.message?.includes("physical space")
    ) {
      return res.status(400).json({ error: error.message });
    }
    return next(error);
  }
});

adminRouter.patch("/users/:userId", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const userId = String(req.params.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "User id is required." });
    }

    const storage_limit_mb_raw = req.body?.storage_limit_mb ?? req.body?.storage_limit;
    if (
      storage_limit_mb_raw === undefined ||
      storage_limit_mb_raw === null ||
      storage_limit_mb_raw === ""
    ) {
      return res.status(400).json({ error: "storage_limit_mb is required." });
    }

    const storage_limit_mb = await assertWorkspaceUserQuotaForUpdate(
      userId,
      storage_limit_mb_raw
    );

    const user = await Promise.resolve(updateTenantUser(userId, { storage_limit_mb }));
    if (!user) {
      return res.status(404).json({ error: "User not found.", user_id: userId });
    }

    const storageSnapshot = await getUserStorageSnapshot(user.id);

    return res.status(200).json({
      message: "User storage quota updated.",
      user: {
        ...user,
        storage_used_mb: storageSnapshot?.storage_used_mb ?? 0,
        storage_remaining_mb: storageSnapshot?.storage_remaining_mb ?? 0,
      },
    });
  } catch (error) {
    if (
      error.message?.includes("storage_limit_mb") ||
      error.message?.includes("company pool") ||
      error.message?.includes("physical space") ||
      error.message?.includes("current storage usage") ||
      error.message?.includes("workspace users")
    ) {
      return res.status(400).json({ error: error.message });
    }
    return next(error);
  }
});

adminRouter.delete("/users/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const userId = String(req.params.id || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "User id is required." });
    }

    console.log("[ADMIN] DELETE /users/:id | id:", userId);

    const result = await purgeWorkspaceUser(userId);
    if (result.reason === "system_admin_protected") {
      return res.status(403).json({
        error: "Cannot delete the system administrator account.",
        user_id: userId,
      });
    }
    if (!result.removed) {
      return res.status(404).json({ error: "User not found.", user_id: userId });
    }

    return res.json({
      message: "User and face profile data removed.",
      user_id: result.user_id,
      username: result.username,
      company_id: result.company_id,
    });
  } catch (error) {
    console.error("[ADMIN] DELETE /users/:id error:", error.message);
    return next(error);
  }
});

adminRouter.post(
  "/users/create-with-face",
  requireAuth,
  requireAdmin,
  faceImageUploadFields,
  async (req, res, next) => {
    let createdUser = null;

    try {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const company_id = String(req.body?.company_id || "").trim();
      const faceBuffers = collectFaceImageBuffers(req);

      if (!username || !password || !company_id) {
        return res.status(400).json({
          error: "username, password, and company_id are required.",
        });
      }

      if (!faceBuffers.length) {
        return res.status(400).json({
          error:
            "At least one face image is required (multipart field: face_image or face_images, up to 5).",
        });
      }

      if (faceBuffers.length > MAX_FACE_REFERENCES) {
        return res.status(400).json({
          error: `A maximum of ${MAX_FACE_REFERENCES} reference face images are allowed per user.`,
        });
      }

      const storage_limit_mb_raw = req.body?.storage_limit_mb ?? req.body?.storage_limit;
      const storage_limit_mb = await resolveWorkspaceUserQuotaForCreate(
        company_id,
        storage_limit_mb_raw
      );

      createdUser = await Promise.resolve(
        createTenantUser({
          username,
          password,
          company_id,
          role: "user",
          storage_limit_mb,
        })
      );

      console.log(
        "[ADMIN] POST create-with-face | user:",
        createdUser.username,
        "| company:",
        company_id,
        "| face_refs:",
        faceBuffers.length
      );

      const faceResult = await registerAdminFaceProfiles(createdUser.id, faceBuffers);
      const company = await Promise.resolve(getTenantCompanyById(company_id));

      const storageSnapshot = await getUserStorageSnapshot(createdUser.id);

      return res.status(201).json({
        message: "Workspace user created with reference face profile.",
        user: {
          id: createdUser.id,
          username: createdUser.username,
          company_id: createdUser.company_id,
          company_name: company?.company_name || null,
          role: createdUser.role,
          created_at: createdUser.created_at,
          storage_limit_mb: storageSnapshot?.storage_limit_mb ?? createdUser.storage_limit_mb,
          storage_used_mb: storageSnapshot?.storage_used_mb ?? 0,
          has_face_profile: true,
        },
        face_profile: faceResult,
      });
    } catch (error) {
      if (createdUser?.id) {
        await purgeWorkspaceUser(createdUser.id);
      }

      console.error("[ADMIN] create-with-face error:", error.message);
      if (error.stack && !isFaceProcessingError(error)) {
        console.error(error.stack);
      }

      if (error.message?.includes("already taken")) {
        return res.status(409).json({ error: error.message });
      }
      if (error.message?.includes("Company not found")) {
        return res.status(404).json({ error: error.message });
      }
      if (isFaceProcessingError(error)) {
        return respondToFaceProcessingError(res, error);
      }
      if (
        error.message?.includes("username and password") ||
        error.message?.includes("company_id is required") ||
        error.message?.includes("Face image file is required")
      ) {
        return res.status(400).json({ error: error.message });
      }
      if (
        error.message?.includes("storage_limit_mb") ||
        error.message?.includes("company pool") ||
        error.message?.includes("physical space")
      ) {
        return res.status(400).json({ error: error.message });
      }

      return next(error);
    }
  }
);

adminRouter.post(
  "/users/:userId/face-image",
  requireAuth,
  requireAdmin,
  faceImageUploadFields,
  async (req, res, next) => {
    try {
      const userId = String(req.params.userId || "").trim();
      const faceBuffers = collectFaceImageBuffers(req);
      const replace = parseFaceUploadReplaceFlag(req);

      if (!userId) {
        return res.status(400).json({ error: "user id is required." });
      }

      const user = await Promise.resolve(findUserById(userId));
      if (!user) {
        return res.status(404).json({ error: "User not found.", user_id: userId });
      }

      if (isSystemAdminAccount(user) || user.role !== "user") {
        return res.status(403).json({
          error: "FACE_PROFILE_NOT_APPLICABLE",
          message:
            "Reference face images apply only to workspace tenant users, not system or company administrators.",
        });
      }

      if (!faceBuffers.length) {
        return res.status(400).json({
          error:
            "At least one face image is required (multipart field: face_image or face_images, up to 5).",
        });
      }

      if (
        !replace &&
        (await getFaceReferenceCount(userId)) + faceBuffers.length > MAX_FACE_REFERENCES
      ) {
        return res.status(400).json({
          error: `Cannot exceed ${MAX_FACE_REFERENCES} reference images per user. Use replace=true to replace the full gallery.`,
        });
      }

      console.log(
        "[ADMIN] POST face-image | user:",
        user.username,
        "| id:",
        userId,
        "| refs:",
        faceBuffers.length,
        "| replace:",
        replace
      );

      const result = await registerAdminFaceProfiles(userId, faceBuffers, { replace });

      return res.status(200).json({
        message: replace
          ? "Reference face gallery replaced successfully."
          : "Reference face image(s) saved successfully.",
        user: {
          id: user.id,
          username: user.username,
          company_id: user.company_id,
          role: user.role,
        },
        face_profile: result,
      });
    } catch (error) {
      console.error("[ADMIN] face-image upload error:", error.message);
      if (error.stack && !isFaceProcessingError(error)) {
        console.error(error.stack);
      }
      if (isFaceProcessingError(error)) {
        return respondToFaceProcessingError(res, error);
      }
      return next(error);
    }
  }
);

adminRouter.delete("/companies/:id", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const companyId = String(req.params.id || "").trim();
    if (!companyId) {
      return res.status(400).json({ error: "Company id is required." });
    }

    console.log("[ADMIN] DELETE /companies/:id | id:", companyId);

    const result = await purgeCompanyWithUsers(companyId);
    if (!result.removed) {
      return res.status(404).json({ error: "Company not found.", company_id: companyId });
    }

    return res.json({
      message: "Company and its users were removed.",
      company_id: companyId,
      users_removed: result.users_removed,
      faces_purged: result.faces_purged,
    });
  } catch (error) {
    console.error("[ADMIN] DELETE /companies/:id error:", error.message);
    return next(error);
  }
});

// ============================================
// 📤 Document upload & list (/api/documents + /api/upload)
// ============================================
uploadRouter.post("/", documentUploadMiddleware, checkTrialUploadLimits, acceptDocumentUpload);

function serializeUploadJob(job) {
  return {
    upload_id: job.id,
    job_id: job.id,
    status: job.status,
    percent: job.percent,
    phase: job.phase,
    current: job.current,
    total: job.total,
    message: job.message,
    filename: job.filename,
    result: job.result,
    error: job.error,
    retry_count: job.retry_count,
    updated_at: job.updatedAt,
    created_at: job.createdAt,
  };
}

async function uploadStatusHandler(req, res) {
  const uploadId = String(req.params.jobId || req.params.uploadId || "").trim();
  let job = await getUploadJob(uploadId);
  if (!job) {
    return res.status(404).json({ error: "Upload job not found.", upload_id: uploadId });
  }

  const scopeUserId = resolveWorkspaceDocumentUserScope(req);
  if (scopeUserId) {
    const authCompanyId = String(
      req.auth?.user?.company_id || req.auth?.company_id || ""
    ).trim();
    const jobCompanyId = String(job.company_id || "").trim();

    if (authCompanyId && jobCompanyId && authCompanyId !== jobCompanyId) {
      return res.status(404).json({ error: "Upload job not found.", upload_id: uploadId });
    }

    if (job.user_id && String(job.user_id) !== scopeUserId) {
      return res.status(404).json({ error: "Upload job not found.", upload_id: uploadId });
    }

    if (!job.user_id) {
      job = (await updateUploadJob(uploadId, { user_id: scopeUserId })) || job;
    }
  }

  return res.json(serializeUploadJob(job));
}

async function listActiveUploadsHandlerCore(req, res) {
  if (isTrialModeRequest(req)) {
    const trialCompanyId = getTrialCompanyIdForRequest(req);
    if (!isValidTrialCompanyId(trialCompanyId)) {
      return res.status(200).json({ uploads: [] });
    }
    attachTrialAuthContext(req, trialCompanyId);
    const jobs = await listUploadJobsByCompany(trialCompanyId, { activeOnly: true });
    return res.status(200).json({
      uploads: jobs.map(serializeUploadJob),
    });
  }

  const companyId = await resolveCompanyId(req);
  if (!companyId) {
    return res.status(200).json({ uploads: [] });
  }
  const scopeUserId = resolveWorkspaceDocumentUserScope(req);
  const jobs = await listUploadJobsByCompany(companyId, {
    activeOnly: true,
    user_id: scopeUserId,
  });
  return res.status(200).json({
    uploads: jobs.map(serializeUploadJob),
  });
}

const listActiveUploadsHandler = wrapRoute(listActiveUploadsHandlerCore, "UPLOADS");

uploadRouter.get("/status/:jobId", uploadStatusHandler);

async function companyStorageHandlerCore(req, res) {
  if (isTrialModeRequest(req)) {
    const trialCompanyId = getTrialCompanyIdForRequest(req);
    if (!isValidTrialCompanyId(trialCompanyId)) {
      return res.status(200).json({
        storage_pool_scope: "trial",
        storage_used_mb: 0,
        storage_committed_mb: 0,
        storage_reserved_mb: 0,
        storage_remaining_mb: 5,
        storage_limit_mb: 5,
      });
    }
    const status = await getTrialStatusFromRequest(req);
    const usedBytes = status.trial?.storage_used_bytes ?? 0;
    const limitBytes = status.trial?.storage_limit_bytes ?? 5 * 1024 * 1024;
    return res.status(200).json({
      storage_pool_scope: "trial",
      storage_used_mb: Math.round((usedBytes / (1024 * 1024)) * 100) / 100,
      storage_committed_mb: 0,
      storage_reserved_mb: 0,
      storage_remaining_mb:
        Math.round(((limitBytes - usedBytes) / (1024 * 1024)) * 100) / 100,
      storage_limit_mb: 5,
    });
  }

  const companyId = await resolveCompanyId(req);
  const company = await resolveCompanyRecord(companyId);
  if (!company) {
    return res.status(404).json({ error: "Company not found." });
  }
  const snapshot = await getTenantStorageSnapshot(company.id);
  if (!snapshot) {
    return res.status(404).json({ error: "Company not found." });
  }
  return res.status(200).json(snapshot);
}

const companyStorageHandler = wrapRoute(companyStorageHandlerCore, "STORAGE");

documentsRouter.get("/storage", companyStorageHandler);
documentsRouter.get("/", listDocumentsHandler);
documentsRouter.get("/uploads/active", listActiveUploadsHandler);
documentsRouter.get("/upload-status/:jobId", uploadStatusHandler);
documentsRouter.get("/status/:uploadId", uploadStatusHandler);
documentsRouter.post("/", documentUploadMiddleware, checkTrialUploadLimits, acceptDocumentUpload);

documentsRouter.patch("/:id/move", moveDocumentHandler);
documentsRouter.delete("/:id", requireMasterKey, deleteDocumentHandler);

async function moveDocumentHandler(req, res, next) {
  const docId = String(req.params?.id ?? "").trim();

  try {
    if (!docId) {
      return res.status(400).json({ error: "Document id is required." });
    }

    if (isTrialModeRequest(req)) {
      return res.status(400).json({
        error: "TRIAL_FOLDER_SCOPE_NOT_ALLOWED",
        code: "TRIAL_FOLDER_SCOPE_NOT_ALLOWED",
        message: "Folder moves are not available in Free Trial mode.",
      });
    }

    const companyId = await resolveDocumentsCompanyId(req);
    const scopeUserId = resolveWorkspaceDocumentUserScope(req);
    const { normalizeFolderId, assertFolderAccess } = require("./services/folders");
    const folder_id = normalizeFolderId(
      req.body?.folder_id ?? req.body?.folderId
    );

    if (
      req.auth?.user &&
      String(req.auth.user.role || "").toLowerCase() === "user" &&
      !scopeUserId
    ) {
      return res.status(401).json({ error: "Authentication required." });
    }

    const company = await resolveCompanyRecord(companyId);
    if (!company) {
      return res.status(404).json({ error: "Company not found." });
    }

    const existing = await getDocumentById(docId);
    if (!existing || String(existing.company_id) !== String(companyId)) {
      return res.status(404).json({ error: "Document not found." });
    }

    if (scopeUserId) {
      const orphanAttributionUserId = getOrphanDocumentAttributionUserId(companyId);
      if (
        !documentCountsTowardUserStorage(
          existing,
          scopeUserId,
          companyId,
          orphanAttributionUserId
        )
      ) {
        return res.status(404).json({ error: "Document not found." });
      }
    }

    if (folder_id) {
      await assertFolderAccess(folder_id, {
        user_id: scopeUserId,
        company_id: companyId,
      });
    }

    const currentFolder = existing.folder_id ?? null;
    if (String(currentFolder || "") === String(folder_id || "")) {
      return res.json({
        success: true,
        document: {
          id: existing.id,
          filename: existing.filename,
          folder_id: folder_id ?? null,
        },
        message: "Document is already in this location.",
      });
    }

    const moved = await moveDocumentToFolder(companyId, docId, folder_id);
    if (!moved) {
      return res.status(404).json({ error: "Document not found." });
    }

    try {
      await updateFolderIdForDocument(docId, folder_id);
    } catch (vectorErr) {
      console.warn("[DOCUMENTS] move vector folder_id update:", vectorErr.message);
    }

    console.log(
      "[DOCUMENTS] PATCH move",
      docId,
      "→",
      folder_id || "(root)",
      "| company:",
      companyId
    );

    return res.json({
      success: true,
      document: {
        id: moved.id,
        filename: moved.filename,
        folder_id: moved.folder_id ?? null,
      },
    });
  } catch (err) {
    if (err.message?.includes("Folder not found")) {
      return res.status(404).json({ error: err.message });
    }
    console.error("[DOCUMENTS] move failed:", err.message);
    return next(err);
  }
}

async function deleteDocumentHandler(req, res, next) {
  const docId = String(req.params?.id ?? "").trim();
  const logCtx = {
    method: req.method,
    path: req.originalUrl,
    docId: docId || "(empty)",
    query: req.query,
    headers: {
      "x-company-id": req.headers["x-company-id"] ?? null,
      "x-master-key": req.headers["x-master-key"] ? "present" : "missing",
    },
    auth_company_id: req.auth?.company_id ?? null,
  };

  console.log("\n========== [DOCUMENTS] DELETE ==========");
  console.log("[DOCUMENTS] DELETE context:", JSON.stringify(logCtx, null, 2));

  try {
    if (!docId) {
      console.error("[DOCUMENTS] DELETE 400: req.params.id is missing or empty", logCtx);
      return res.status(400).json({
        error: "Document id is required in the URL path.",
        details: "Expected DELETE /api/documents/:id",
      });
    }

    const trialMode = isTrialModeRequest(req);
    let companyId = await resolveDocumentsCompanyId(req);
    console.log("[DOCUMENTS] DELETE resolved company_id:", companyId ?? "(none)");

    if (trialMode && !isValidTrialCompanyId(companyId)) {
      return res.status(404).json({
        error: "Document not found.",
        document_id: docId,
      });
    }

    let doc = null;

    if (companyId) {
      doc = await deleteDocumentById(companyId, docId);
      if (!doc && !trialMode) {
        console.warn(
          "[DOCUMENTS] DELETE no match for company_id + doc id; trying lookup by id only",
          { companyId, docId }
        );
      }
    } else if (!trialMode) {
      console.log("[DOCUMENTS] DELETE no company_id — will resolve from document record");
    }

    if (!doc && !trialMode) {
      const existing = await getDocumentById(docId);
      if (existing) {
        companyId = existing.company_id;
        console.log("[DOCUMENTS] DELETE fallback company_id from DB:", companyId);
        doc = await deleteDocumentById(companyId, docId);
      }
    }

    if (!doc) {
      console.error("[DOCUMENTS] DELETE 404:", {
        docId,
        companyId: companyId ?? null,
        hint: "Document not found for this id (and company_id if provided).",
      });
      return res.status(404).json({
        error: "Document not found.",
        document_id: docId,
        company_id: companyId ?? undefined,
      });
    }

    console.log("[DOCUMENTS] 🗑️ DB removed:", doc.filename, "| id:", docId, "| company:", companyId);

    let chromaDeleted = false;
    try {
      await deleteByDocumentId(docId);
      chromaDeleted = true;
      console.log("[DOCUMENTS] ✅ Chroma vectors deleted for doc:", docId);
    } catch (chromaErr) {
      console.warn("[DOCUMENTS] Chroma delete warning:", chromaErr.message);
    }

    console.log("========== [DOCUMENTS] DELETE SUCCESS ==========\n");

    return res.json({
      success: true,
      message: "Document deleted",
      document_id: docId,
      company_id: companyId,
      filename: doc.filename,
      chroma_vectors_removed: chromaDeleted,
    });
  } catch (err) {
    console.error("[DOCUMENTS] DELETE 500:", err.message);
    console.error(err.stack);
    return next(err);
  }
}

// ============================================
// 🤖 CHAT API — باستخدام Chroma Native
// ============================================
chatRouter.post("/", async (req, res, next) => {
  console.log("\n========== [CHAT] REQUEST RECEIVED ==========");
  console.log("[CHAT] Timestamp:", new Date().toISOString());
  console.log("[CHAT] Headers:", {
    "x-master-key": req.headers["x-master-key"] ? "PRESENT" : "MISSING",
    "x-company-id": req.headers["x-company-id"],
    "content-type": req.headers["content-type"] || "none",
  });

  try {
    const trialQuota = await enforceTrialChatLimit(req, res);
    if (!trialQuota.ok) {
      return trialQuota.response;
    }

    const trialCompanyId = getTrialCompanyIdForRequest(req);
    if (isTrialModeRequest(req) && !isValidTrialCompanyId(trialCompanyId)) {
      return respondMissingTrialFingerprint(res);
    }
    const companyId = trialCompanyId || (await resolveCompanyId(req));
    if (!companyId) {
      return res.status(400).json({ error: "company_id could not be resolved." });
    }
    req.auth = req.auth || {};
    req.auth.company_id = companyId;
    if (trialCompanyId) {
      attachTrialAuthContext(req, trialCompanyId);
    }
    console.log("[CHAT] company_id:", companyId);

    const company = trialCompanyId
      ? { id: companyId, company_name: "Free Trial Sandbox", name: "Free Trial Sandbox" }
      : await resolveCompanyRecord(companyId);
    if (!company) {
      return res.status(404).json({
        error: "Company not found.",
        company_id: companyId,
      });
    }

    const companyDisplayName = company.company_name || company.name;
    console.log("[CHAT] ✅ Company:", companyDisplayName, "| id:", company.id);

    const rawQuestion =
      req.body?.question ??
      req.body?.message ??
      req.body?.text ??
      req.body?.prompt ??
      req.body?.content ??
      req.body?.query;
    const question = String(rawQuestion ?? "").trim();
    console.log(
      "[CHAT] question preview:",
      question ? question.slice(0, 80) + (question.length > 80 ? "…" : "") : "(empty)"
    );
    if (!question) {
      console.warn("[CHAT] question missing — req.body keys:", Object.keys(req.body || {}));
      console.warn("[CHAT] req.body:", JSON.stringify(req.body, null, 2));
      return res.status(400).json({
        error: "question is required.",
        hint: "Send question, message, text, prompt, content, or query in the JSON body.",
        receivedKeys: Object.keys(req.body || {}),
      });
    }

    const maxChatTopK = Math.max(
      CHAT_TOP_K,
      parseInt(process.env.CHAT_TOP_K_MAX || "12", 10)
    );
    const requestedTopK =
      parseInt(String(req.body?.top_k ?? CHAT_TOP_K), 10) || CHAT_TOP_K;
    const chatTopK = Math.min(
      maxChatTopK,
      CHAT_MAX_CHUNKS,
      Math.max(1, requestedTopK)
    );
    const chatFetchN = Math.max(
      CHAT_FETCH_N,
      parseInt(process.env.CHAT_FETCH_N || String(CHAT_FETCH_N), 10)
    );
    console.log("[CHAT] topK:", chatTopK, "| fetchN:", chatFetchN);

    // ─── RAG retrieval: OpenAI or Ollama embeddings (EMBEDDING_PROVIDER) ───
    let contexts = [];
    let retrievalMeta = { mode: "semantic", isGlobalSummary: false };
    let retrievalError = null;

    const chatScopeUserId = resolveWorkspaceDocumentUserScope(req);
    const { normalizeFolderId, assertFolderAccess } = require("./services/folders");
    const chatFolderId = normalizeFolderId(
      req.body?.folder_id ?? req.body?.folderId
    );

    if (chatFolderId && !trialCompanyId) {
      await assertFolderAccess(chatFolderId, {
        user_id: chatScopeUserId,
        company_id: company.id,
      });
    }

    console.log("[CHAT] Step 1: retrieve contexts (local Chroma + embeddings)...");
    try {
      const result = await retrieveContextsViaChromaNative(
        question,
        company.id,
        chatTopK,
        chatFetchN,
        { user_id: chatScopeUserId, folder_id: chatFolderId }
      );
      contexts = result.contexts;
      retrievalMeta = result.retrieval || retrievalMeta;
      console.log(
        `[CHAT] Retrieved ${contexts.length} chunks | mode=${retrievalMeta.mode} | docs=${retrievalMeta.documentsCovered}/${retrievalMeta.activeDocuments} → ${getChatProvider()} chat`
      );
    } catch (e) {
      console.error("[CHAT] Chroma native retrieval failed:", e.message);
      console.error(e.stack);
      retrievalError = e.message;

      try {
        console.log("[CHAT] Step 1b: fallback retriever.retrieve...");
        const fallback = await retriever.retrieve({
          question,
          company_id: company.id,
          user_id: chatScopeUserId,
          folder_id: chatFolderId,
          topK: chatTopK,
          fetchN: chatFetchN,
          apiKey: null,
        });
        if (fallback?.contexts?.length) {
          contexts = fallback.contexts;
          retrievalMeta = fallback.retrieval || retrievalMeta;
          retrievalError = null;
          console.log("[CHAT] ✅ Fallback:", contexts.length, "contexts");
        }
      } catch (fallbackErr) {
        console.error("[CHAT] Fallback also failed:", fallbackErr.message);
        console.error(fallbackErr.stack);
      }
    }

    if (retrievalMeta.emptyFolder) {
      const emptyMsg = FOLDER_EMPTY_MESSAGE;
      console.log("[CHAT] empty folder scope — responding without RAG leakage");
      beginSse(res);
      writeStreamToken(res, emptyMsg);
      writeSseData(res, {
        done: true,
        sources: [],
        source_filenames: [],
        retrieval: retrievalMeta,
      });
      res.end();
      return;
    }

    if (!contexts.length) {
      console.log("[CHAT] ⚠️ No contexts — returning 404 (or SSE error if headers already sent)");
      const noContextMessage = chatFolderId
        ? FOLDER_EMPTY_MESSAGE
        : "No indexed segments found. Upload documents first.";
      if (!res.headersSent) {
        return res.status(404).json({
          error: noContextMessage,
          details: retrievalError,
        });
      }
      beginSse(res);
      writeSse(res, "error", {
        message: noContextMessage,
        details: retrievalError,
      });
      res.end();
      return;
    }

    console.log(
      "[CHAT] Step 2: stream answer via",
      getChatProvider(),
      isOpenAIChatEnabled() ? `(${getOpenAIChatModel()})` : `(Ollama ${getChatModel()})`
    );
    const chatHistory = parseRequestHistory(req.body);
    debugLogContextsForLlm(contexts, "chat/raw-retrieval");
    const { contexts: budgetedContexts, stats: budgetStats } =
      budgetRetrievedContexts(contexts);
    console.log("[CHAT] Context budget:", JSON.stringify(budgetStats));
    debugLogContextsForLlm(budgetedContexts, "chat/post-budget");

    let messages = buildMessagesForChat({
      question,
      contexts: budgetedContexts,
      history: chatHistory,
      isGlobalSummary: Boolean(retrievalMeta.isGlobalSummary),
      retrievalMode: retrievalMeta.mode,
    });

    const { messages: fittedMessages, stats: fitStats } =
      fitMessagesToTokenBudget(messages);
    messages = fittedMessages;
    console.log(
      "[CHAT] Payload fit:",
      JSON.stringify({
        ...fitStats,
        estimatedInputTokens: estimateMessagesTokens(messages),
      })
    );

    const source_filenames = collectUniqueSourceFilenames(budgetedContexts);
    const sources = budgetedContexts.map((c) => ({
      citation: c.citationTag,
      document_id: c.document_id,
      filename: c.filename,
      page: c.page_label || null,
      page_label: c.page_label,
      child_excerpt: (c.child_text || "").slice(0, 400),
      parent_excerpt: (c.parent_text || "").slice(0, 800),
      distance: c.distance,
    }));

    console.log(
      "[CHAT] Source files:",
      source_filenames.length ? source_filenames.join(", ") : "(none)"
    );

    beginSse(res);
    writeSseData(res, {
      type: "sources",
      sources,
      source_filenames,
      company_id: company.id,
      company_name: companyDisplayName,
    });

    let fullText = "";
    const llmStreamClientError =
      "Failed to communicate with LLM provider. Please check your network connection or reduce payload size.";

    try {
      const { provider, model } = await streamChatCompletion(
        { messages, apiKey: company.openai_api_key || null },
        (delta) => {
          fullText += delta;
          writeStreamToken(res, delta);
        }
      );

      console.log("[CHAT] ✅ Stream complete, answer length:", fullText.length);
      console.log(
        "\n========== AI CHAT STREAM (full) ==========\n",
        fullText,
        "\n========== END ==========\n"
      );

      writeSseData(res, {
        type: "done",
        answer: fullText,
        provider,
        model,
        sources,
        source_filenames,
        company_id: company.id,
        company_name: companyDisplayName,
      });
      res.end();
    } catch (streamErr) {
      console.error(
        "[LLM STREAM ERROR]: Failed to fetch from OpenAI",
        streamErr
      );
      if (!res.headersSent) {
        return res.status(500).json({
          error: llmStreamClientError,
          details:
            streamErr?.cause?.message || streamErr?.message || "LLM stream failed",
        });
      }
      writeSse(res, "error", {
        message: llmStreamClientError,
        details: streamErr?.cause?.message || streamErr?.message,
      });
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
  } catch (error) {
    console.error("[CHAT] ❌❌❌ UNHANDLED ERROR ❌❌❌");
    console.error("[CHAT] Message:", error?.message);
    console.error("[CHAT] Stack:\n", error?.stack);
    if (res.headersSent) {
      try {
        writeSse(res, "error", { message: error.message || "Stream failed." });
      } catch { /* ignore */ }
      try {
        res.end();
      } catch { /* ignore */ }
      return;
    }
    return next(error);
  }
});

apiRouter.get(
  "/trial/status",
  wrapRoute(async (req, res) => {
    const status = await getTrialStatusFromRequest(req);
    return res.status(200).json(status);
  }, "TRIAL_STATUS")
);

apiRouter.post("/login", loginHandler);

const authRouter = express.Router();
authRouter.post("/verify-face", requireAuth, async (req, res, next) => {
  try {
    const image =
      req.body?.image ?? req.body?.image_base64 ?? req.body?.face_image ?? req.body?.snapshot;
    if (!image) {
      return res.status(400).json({
        success: false,
        error: "IMAGE_REQUIRED",
        message: "image (base64) is required.",
      });
    }

    const userId = req.auth?.user?.id;
    if (!userId) {
      return res.status(401).json({ error: "Authentication required." });
    }

    console.log("[FACE] verify-face | user:", req.auth.user.username, "| id:", userId);

    const result = await verifyUserFace(userId, image);
    if (!result.match) {
      return res.status(401).json({
        success: false,
        error: "FACE_VERIFICATION_FAILED",
        message: "Face verification failed. Identity could not be verified.",
        match_score: result.match_score,
        distance: result.distance,
        threshold: result.threshold,
        max_distance: result.max_distance,
        references_compared: result.references_compared,
        best_reference_index: result.best_reference_index,
      });
    }

    return res.status(200).json({
      success: true,
      message: "Face verification successful.",
      match_score: result.match_score,
      distance: result.distance,
      threshold: result.threshold,
      references_compared: result.references_compared,
      matched_reference_index: result.matched_reference_index,
      gallery_adapted: result.gallery_adapted,
      private_local_inference: true,
    });
  } catch (error) {
    console.error("[FACE] verify-face error:", error.message);
    if (error.code === "FACE_PROFILE_NOT_CONFIGURED") {
      return res.status(403).json({
        success: false,
        error: "FACE_PROFILE_NOT_CONFIGURED",
        message: FACE_PROFILE_NOT_CONFIGURED_MESSAGE,
      });
    }
    if (isFaceProcessingError(error)) {
      return res.status(400).json({
        success: false,
        error: error.code || "NO_FACE_DETECTED",
        message: error.message,
      });
    }
    return next(error);
  }
});

apiRouter.use("/auth", authRouter);
apiRouter.use("/chat", chatRouter);
apiRouter.use("/upload", uploadRouter);
apiRouter.use("/documents", documentsRouter);
const foldersRouter = express.Router();
foldersRouter.get("/", listFoldersHandler);
foldersRouter.post("/", createFolderHandler);
apiRouter.use("/folders", foldersRouter);
apiRouter.use("/admin", adminRouter);
app.use("/api", apiRouter);

// Legacy paths (backward compatibility) — same API auth stack
const legacyAdminRouter = express.Router();
legacyAdminRouter.use(attachApiAuth);
legacyAdminRouter.use("/upload-doc", uploadRouter);
legacyAdminRouter.use("/docs", documentsRouter);
app.use("/admin", legacyAdminRouter);

// ============================================
// 6️⃣ ERROR HANDLER
// ============================================
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    console.error("[ERROR HANDLER] MulterError:", error.code, error.message);
    return res.status(400).json({
      error: "Upload parsing failed.",
      code: error.code,
      details: error.message,
    });
  }

  const message = typeof error?.message === "string" ? error.message : "Internal server error.";
  const lowered = message.toLowerCase();
  console.error("[ERROR HANDLER]", message);
  if (error?.stack) console.error(error.stack);

  if (isFaceProcessingError(error)) {
    return respondToFaceProcessingError(res, error);
  }
  if (error?.code === "USER_STORAGE_LIMIT_REACHED") {
    return res.status(400).json(buildUserStorageLimitPayload(error));
  }
  if (error?.code === "STORAGE_LIMIT_REACHED") {
    return res.status(400).json(buildStorageLimitPayload(error));
  }
  if (error?.code === "TRIAL_STORAGE_EXCEEDED" || error?.code === "TRIAL_FINGERPRINT_REQUIRED") {
    return res.status(400).json({
      error: error.code,
      code: error.code,
      message: message,
    });
  }
  if (lowered.includes("company not found for provided company_id")) {
    return res.status(404).json({ error: message, company_id: _req.body?.company_id });
  }

  if (lowered.includes("ocr")) {
    return res.status(422).json({ error: "OCR processing failed.", details: message });
  }
  if (lowered.includes("pdf")) {
    return res.status(422).json({ error: "PDF text extraction failed.", details: message });
  }
  if (lowered.includes("chunk")) {
    return res.status(422).json({ error: "Chunking failed.", details: message });
  }
  if (lowered.includes("upload") || lowered.includes("no file received")) {
    return res.status(400).json({ error: "Upload failed.", details: message });
  }
  if (
    lowered.includes("chroma") ||
    lowered.includes("embedding") ||
    lowered.includes("vector") ||
    lowered.includes("ollama")
  ) {
    return res.status(503).json({ error: "Vector / embeddings service unavailable.", details: message });
  }
  if (lowered.includes("llm") || lowered.includes("stream chat completion")) {
    return res.status(502).json({ error: "LLM request failed.", details: message });
  }
  if (
    lowered.includes("required") ||
    lowered.includes("must start") ||
    lowered.includes("already exists") ||
    lowered.includes("missing")
  ) {
    return res.status(400).json({ error: message });
  }

  return res.status(500).json({
    error: message,
    message,
    code: error?.code || "INTERNAL_ERROR",
    details: message,
  });
});

(async () => {
  try {
    await connectDatabase();
    await Promise.resolve(initTenantStore());
    await backfillOrphanDocumentUploaders();

    if (useMongoVectorStore()) {
      const mongoVectorInit = await initializeChromaCollection("company_docs");
      console.log("[BOOT] Vector store (MongoDB):", mongoVectorInit);
    } else {
      await ensureChromaServer();
      const chromaInit = await initializeChromaCollection("company_docs");
      console.log("[BOOT] Chroma collection init:", chromaInit);
    }

    if (!isRenderPlatform()) {
      try {
        await loadFaceModels();
        console.log("[BOOT] Face-API models preloaded and ready");
      } catch (faceBootErr) {
        console.warn(
          "[BOOT] Face-API preload failed (will retry on first face request):",
          faceBootErr.message
        );
      }
    } else {
      console.log("[BOOT] Render mode: skipping local Face-API preload (ephemeral disk)");
    }
  } catch (e) {
    console.error("[BOOT] Startup failed:", e.message);
    process.exit(1);
  }

  if (!isRenderPlatform()) {
    startFrontendDevServer();
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 PRIVA-AI API running on http://localhost:${PORT}`);
    if (!isRenderPlatform()) {
      console.log(`📝 Built-in chat UI: http://localhost:${PORT}/chat`);
      console.log(`🌐 User frontend (Vite): http://localhost:8080`);
      console.log(
        `   → Start UI: cd priva-ai-workspace-main/priva-ai-workspace-main && npm run dev`
      );
      console.log(
        `   → Or set START_FRONTEND_DEV=1 to launch Vite from this process (see FRONTEND_DIR)`
      );
      console.log(`📁 Chroma local persist: ${CHROMA_DATA_DIR}`);
    } else {
      console.log("[BOOT] Render mode: VECTOR_STORE=mongo | TENANT_STORE=mongo (auto)");
      console.log(`📤 Upload staging: ${UPLOAD_STAGING_DIR}`);
    }
    console.log(`🤖 Ollama: ${process.env.OLLAMA_URL || "http://127.0.0.1:11434"}`);
    console.log(`💬 Chat model: ${getChatModel()} | 📐 Embed model: ${getPrimaryEmbedModel()}`);
    console.log(`\n✅ Ready for requests.\n`);
  });
})();