// services/vectorStore.js — Persistent Chroma: no `where` in query/get; filter manually + logs
const { getOrCreateCollection, deleteCollection } = require("./chromaClient");
const { getConfiguredEmbedDim } = require("./embeddings");

let collectionDimChecked = false;

const OVERFETCH_FACTOR = parseInt(process.env.CHROMA_OVERFETCH || "15", 10);

function isForceResetOnBoot() {
  const v = String(process.env.CHROMA_FORCE_RESET_ON_BOOT || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * حذف مستند من ChromaDB حسب document_id (فلترة يدوية إذا فشل where)
 */
async function deleteByDocumentId(documentId) {
  const collection = await getOrCreateCollection("company_docs");
  const want = String(documentId);
  console.log("[VECTOR] deleteByDocumentId start", want);

  let idsToDelete = [];

  try {
    const results = await collection.get({
      where: { document_id: want },
    });
    idsToDelete = results.ids || [];
    console.log("[VECTOR] deleteByDocumentId get(where) returned", idsToDelete.length, "ids");
  } catch (e) {
    console.warn("[VECTOR] get(where) failed:", e.message);
  }

  if (idsToDelete.length === 0) {
    console.log("[VECTOR] deleteByDocumentId falling back to full scan + manual filter");
    const all = await collection.get({ include: ["metadatas"] });
    const ids = all.ids || [];
    const metas = all.metadatas || [];
    for (let i = 0; i < ids.length; i++) {
      const m = metas[i];
      if (m != null && String(m.document_id) === want) {
        idsToDelete.push(ids[i]);
      }
    }
    console.log("[VECTOR] manual filter matched", idsToDelete.length, "ids for document_id=", want);
  }

  if (idsToDelete.length > 0) {
    await collection.delete({ ids: idsToDelete });
    console.log("[VECTOR] Deleted", idsToDelete.length, "vectors for doc:", want);
  } else {
    console.log("[VECTOR] No vectors to delete for doc:", want);
  }
}

/**
 * On server boot: drop company_docs if dimension mismatches or CHROMA_FORCE_RESET_ON_BOOT=1.
 */
async function initializeChromaCollection(collectionName = "company_docs") {
  const expectedDim = getConfiguredEmbedDim();
  const probed = await probeCollectionEmbedDim(collectionName);
  const forceReset = isForceResetOnBoot();

  if (forceReset) {
    console.warn(
      `[VECTOR] CHROMA_FORCE_RESET_ON_BOOT — dropping "${collectionName}" for fresh ${expectedDim}-dim vectors`
    );
    await deleteCollection(collectionName);
    collectionDimChecked = false;
  } else if (probed != null && probed !== expectedDim) {
    console.warn(
      `[VECTOR] Dimension mismatch: collection=${probed}, expected=${expectedDim}. ` +
        `Dropping "${collectionName}" (re-upload documents).`
    );
    await deleteCollection(collectionName);
    collectionDimChecked = false;
  } else if (probed != null) {
    console.log(`[VECTOR] Collection OK: ${probed}-dim matches CHROMA_EMBED_DIM=${expectedDim}`);
  } else {
    console.log(`[VECTOR] Empty collection — will index at ${expectedDim} dimensions`);
  }

  await getOrCreateCollection(collectionName);
  collectionDimChecked = true;
  return { expectedDim, probed, forceReset };
}

/**
 * Before add: recreate collection if embedding size changed mid-session.
 */
async function ensureCollectionEmbedDim(collectionName = "company_docs") {
  if (collectionDimChecked) return;

  const expectedDim = getConfiguredEmbedDim();
  const probed = await probeCollectionEmbedDim(collectionName);
  if (probed != null && probed !== expectedDim) {
    console.warn(
      `[VECTOR] Embedding dimension mismatch: collection=${probed}, expected=${expectedDim}. ` +
        `Recreating "${collectionName}".`
    );
    await deleteCollection(collectionName);
  }
  collectionDimChecked = true;
}

/**
 * إضافة vectors إلى ChromaDB
 */
async function addVectors({ ids, embeddings, metadatas, documents }) {
  await ensureCollectionEmbedDim("company_docs");
  const collection = await getOrCreateCollection("company_docs");
  console.log("[VECTOR] addVectors", ids.length, "records");
  await collection.add({
    ids,
    embeddings,
    metadatas,
    documents,
  });
  console.log("[VECTOR] addVectors done");
}

/**
 * بحث تشابه: **بدون where** (وضع Persistent)، ثم فلترة يدوية بـ company_id عند الحاجة.
 * @param {{ embedding: number[], nResults: number, companyId?: string|null }} opts
 */
function vectorMatchesFolderScope(metadata, folderId) {
  const vectorFolder =
    metadata == null ? "" : String(metadata.folder_id || "").trim();
  if (folderId == null || folderId === "") {
    return !vectorFolder;
  }
  return vectorFolder === String(folderId);
}

/**
 * Build Chroma `where` with only defined, non-empty fields.
 * Multiple clauses MUST use `$and` (Chroma rejects bare multi-key objects).
 * Root/global chat: omit folder_id so search spans all company folders.
 * Folder-scoped chat: include folder_id for strict isolation.
 */
function buildChromaWhereFilter({ companyId = null, userId = null, folderId = null } = {}) {
  const clauses = [];

  if (companyId != null && String(companyId).trim()) {
    clauses.push({ company_id: String(companyId).trim() });
  }
  if (userId != null && String(userId).trim()) {
    clauses.push({ uploaded_by_user_id: String(userId).trim() });
  }

  const folderScope =
    folderId == null || folderId === "" ? null : String(folderId).trim();
  if (folderScope) {
    clauses.push({ folder_id: folderScope });
  }

  if (clauses.length === 0) {
    return undefined;
  }
  if (clauses.length === 1) {
    return clauses[0];
  }
  return { $and: clauses };
}

const EMPTY_QUERY_RESULT = {
  ids: [[]],
  documents: [[]],
  metadatas: [[]],
  distances: [[]],
};

async function searchVectors({
  embedding,
  nResults = 5,
  companyId = null,
  userId = null,
  folderId = null,
  allowedDocumentIds = null,
  fetchN: fetchOverride = null,
  /** When true, never apply folder_id metadata filtering (company-wide / tier-2 fallback). */
  companyWide = false,
}) {
  const collection = await getOrCreateCollection("company_docs");
  const want = Math.max(1, nResults);
  const fetchN =
    fetchOverride != null
      ? Math.min(Math.max(1, fetchOverride), 500)
      : Math.min(want * OVERFETCH_FACTOR, 500);

  const allowedDocSet =
    allowedDocumentIds instanceof Set
      ? allowedDocumentIds
      : Array.isArray(allowedDocumentIds)
        ? new Set(allowedDocumentIds.map(String))
        : null;

  console.log("[VECTOR] searchVectors", {
    nResults: want,
    fetchN,
    companyId: companyId != null ? String(companyId) : "(no filter)",
    userId: userId != null ? String(userId) : "(no filter)",
    folderId:
      companyWide || folderId == null || !String(folderId).trim()
        ? "(company-wide)"
        : String(folderId),
    companyWide: Boolean(companyWide),
    allowedDocuments: allowedDocSet ? allowedDocSet.size : "(none)",
  });

  const folderScope =
    companyWide || folderId == null || folderId === ""
      ? null
      : String(folderId).trim();
  const whereFilter = buildChromaWhereFilter({
    companyId,
    userId,
    folderId: folderScope,
  });

  let raw;
  try {
    const queryOpts = {
      queryEmbeddings: [embedding],
      nResults: fetchN,
    };
    if (whereFilter) {
      queryOpts.where = whereFilter;
    }
    raw = await collection.query(queryOpts);
  } catch (queryErr) {
    console.warn("[VECTOR] query with where failed, retrying without where:", queryErr.message);
    try {
      raw = await collection.query({
        queryEmbeddings: [embedding],
        nResults: fetchN,
      });
    } catch (fallbackErr) {
      console.error("[VECTOR] query failed:", fallbackErr.message);
      return { ...EMPTY_QUERY_RESULT };
    }
  }

  let ids = raw.ids?.[0] || [];
  let documents = raw.documents?.[0] || [];
  let metadatas = raw.metadatas?.[0] || [];
  let distances = raw.distances?.[0] || [];

  const rawCount = ids.length;

  if (companyId != null && String(companyId).length > 0) {
    const wantStr = String(companyId);
    const fIds = [];
    const fDocs = [];
    const fMeta = [];
    const fDist = [];
    for (let i = 0; i < ids.length; i++) {
      const m = metadatas[i];
      const cid = m == null ? "" : String(m.company_id);
      if (cid === wantStr) {
        fIds.push(ids[i]);
        fDocs.push(documents[i]);
        fMeta.push(m);
        fDist.push(distances[i]);
      }
    }
    ids = fIds;
    documents = fDocs;
    metadatas = fMeta;
    distances = fDist;
    console.log("[VECTOR] manual company_id filter", {
      rawHits: rawCount,
      afterFilter: ids.length,
      companyId: wantStr,
    });
  }

  if (userId != null && String(userId).length > 0) {
    const wantUser = String(userId);
    const fIds = [];
    const fDocs = [];
    const fMeta = [];
    const fDist = [];
    for (let i = 0; i < ids.length; i++) {
      const m = metadatas[i];
      const docId = m == null ? "" : String(m.document_id || "");
      const vectorUser = m == null ? "" : String(m.uploaded_by_user_id || "");
      if (vectorUser && vectorUser === wantUser) {
        fIds.push(ids[i]);
        fDocs.push(documents[i]);
        fMeta.push(m);
        fDist.push(distances[i]);
        continue;
      }
      if (!vectorUser && allowedDocSet && docId && allowedDocSet.has(docId)) {
        fIds.push(ids[i]);
        fDocs.push(documents[i]);
        fMeta.push(m);
        fDist.push(distances[i]);
      }
    }
    ids = fIds;
    documents = fDocs;
    metadatas = fMeta;
    distances = fDist;
    console.log("[VECTOR] manual user/document scope filter", {
      afterFilter: ids.length,
      userId: wantUser,
    });
  } else if (allowedDocSet && allowedDocSet.size > 0) {
    const fIds = [];
    const fDocs = [];
    const fMeta = [];
    const fDist = [];
    for (let i = 0; i < ids.length; i++) {
      const m = metadatas[i];
      const docId = m == null ? "" : String(m.document_id || "");
      if (docId && allowedDocSet.has(docId)) {
        fIds.push(ids[i]);
        fDocs.push(documents[i]);
        fMeta.push(m);
        fDist.push(distances[i]);
      }
    }
    ids = fIds;
    documents = fDocs;
    metadatas = fMeta;
    distances = fDist;
    console.log("[VECTOR] manual allowed document_id filter", {
      afterFilter: ids.length,
    });
  }

  if (folderScope) {
    const fIds = [];
    const fDocs = [];
    const fMeta = [];
    const fDist = [];
    for (let i = 0; i < ids.length; i++) {
      const m = metadatas[i];
      if (vectorMatchesFolderScope(m, folderScope)) {
        fIds.push(ids[i]);
        fDocs.push(documents[i]);
        fMeta.push(m);
        fDist.push(distances[i]);
      }
    }
    ids = fIds;
    documents = fDocs;
    metadatas = fMeta;
    distances = fDist;
    console.log("[VECTOR] manual folder_id filter", {
      afterFilter: ids.length,
      folderId: folderScope,
    });
  }

  return {
    ids: [ids],
    documents: [documents],
    metadatas: [metadatas],
    distances: [distances],
  };
}

/**
 * Read embedding dimension from an existing vector in Chroma (if any).
 */
async function probeCollectionEmbedDim(collectionName = "company_docs") {
  try {
    const collection = await getOrCreateCollection(collectionName);
    const res = await collection.get({ limit: 1, include: ["embeddings"] });
    const len = res.embeddings?.[0]?.length;
    if (len && len > 0) {
      console.log("[VECTOR] Collection embedding dimension:", len);
      return len;
    }
  } catch (e) {
    console.warn("[VECTOR] Could not probe collection embedding dimension:", e.message);
  }
  return null;
}

/**
 * Update folder_id on all vectors for a document (best-effort for RAG folder scoping).
 */
async function updateFolderIdForDocument(documentId, folderId = null) {
  const collection = await getOrCreateCollection("company_docs");
  const want = String(documentId);
  const folderValue =
    folderId == null || folderId === "" ? "" : String(folderId).trim();

  let ids = [];
  let metadatas = [];

  try {
    const results = await collection.get({
      where: { document_id: want },
      include: ["metadatas"],
    });
    ids = results.ids || [];
    metadatas = results.metadatas || [];
  } catch (e) {
    console.warn("[VECTOR] updateFolderId get(where) failed:", e.message);
  }

  if (ids.length === 0) {
    const all = await collection.get({ include: ["metadatas"] });
    const allIds = all.ids || [];
    const allMetas = all.metadatas || [];
    for (let i = 0; i < allIds.length; i++) {
      const m = allMetas[i];
      if (m != null && String(m.document_id) === want) {
        ids.push(allIds[i]);
        metadatas.push(m);
      }
    }
  }

  if (ids.length === 0) {
    console.log("[VECTOR] updateFolderId: no vectors for document", want);
    return 0;
  }

  const updatedMetas = metadatas.map((meta) => ({
    ...(meta || {}),
    folder_id: folderValue,
  }));

  await collection.update({
    ids,
    metadatas: updatedMetas,
  });

  console.log("[VECTOR] updateFolderIdForDocument", {
    documentId: want,
    folder_id: folderValue || "(root)",
    vectors: ids.length,
  });
  return ids.length;
}

/**
 * List all indexed child-chunk vectors for a company (manual company_id filter).
 */
async function listVectorsByCompany(companyId) {
  const collection = await getOrCreateCollection("company_docs");
  const wantStr = String(companyId);
  const all = await collection.get({ include: ["documents", "metadatas"] });
  const ids = all.ids || [];
  const documents = all.documents || [];
  const metadatas = all.metadatas || [];
  const records = [];

  for (let i = 0; i < ids.length; i++) {
    const m = metadatas[i];
    if (m == null || String(m.company_id) !== wantStr) continue;
    records.push({
      id: ids[i],
      document: documents[i] || "",
      child_text: documents[i] || "",
      metadata: m,
      distance: 0,
      score: 1,
    });
  }

  console.log("[VECTOR] listVectorsByCompany", {
    companyId: wantStr,
    chunks: records.length,
  });
  return records;
}

module.exports = {
  deleteByDocumentId,
  updateFolderIdForDocument,
  addVectors,
  searchVectors,
  vectorMatchesFolderScope,
  listVectorsByCompany,
  probeCollectionEmbedDim,
  ensureCollectionEmbedDim,
  initializeChromaCollection,
};
