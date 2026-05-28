/**
 * MongoDB-backed vector storage for Render / cloud (no local chroma_data).
 * Uses cosine similarity with manual metadata filtering (same isolation rules as Chroma path).
 */
const VectorChunk = require("../models/VectorChunk");
const { getConfiguredEmbedDim } = require("./embeddings");

const OVERFETCH_FACTOR = parseInt(process.env.CHROMA_OVERFETCH || "15", 10);

function cosineDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return Number.POSITIVE_INFINITY;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 1;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function vectorMatchesFolderScope(metadata, folderId) {
  const vectorFolder =
    metadata == null ? "" : String(metadata.folder_id || "").trim();
  if (folderId == null || folderId === "") {
    return !vectorFolder;
  }
  return vectorFolder === String(folderId);
}

const EMPTY_QUERY_RESULT = {
  ids: [[]],
  documents: [[]],
  metadatas: [[]],
  distances: [[]],
};

async function initializeChromaCollection() {
  const expectedDim = getConfiguredEmbedDim();
  const sample = await VectorChunk.findOne({}, { embedding: 1 }).lean();
  const probed = sample?.embedding?.length || null;
  console.log("[VECTOR/MONGO] initialize", { expectedDim, probed });
  return { expectedDim, probed, forceReset: false, backend: "mongo" };
}

async function ensureCollectionEmbedDim() {
  return;
}

async function probeCollectionEmbedDim() {
  const sample = await VectorChunk.findOne({}, { embedding: 1 }).lean();
  return sample?.embedding?.length || null;
}

async function addVectors({ ids, embeddings, metadatas, documents }) {
  if (!ids?.length) return;
  const expectedDim = getConfiguredEmbedDim();
  const ops = ids.map((id, index) => {
    const embedding = embeddings[index];
    if (embedding.length !== expectedDim) {
      throw new Error(
        `Embedding dimension ${embedding.length} does not match CHROMA_EMBED_DIM=${expectedDim}`
      );
    }
    const meta = metadatas[index] || {};
    return {
      updateOne: {
        filter: { id: String(id) },
        update: {
          $set: {
            id: String(id),
            company_id: String(meta.company_id || ""),
            document_id: String(meta.document_id || ""),
            uploaded_by_user_id: String(meta.uploaded_by_user_id || ""),
            folder_id: String(meta.folder_id || ""),
            parent_id: String(meta.parent_id || ""),
            parent_sequence: Number(meta.parent_sequence) || 0,
            child_sequence: Number(meta.child_sequence) || 0,
            is_child: Boolean(meta.is_child),
            document: String(documents[index] || ""),
            embedding,
          },
        },
        upsert: true,
      },
    };
  });
  await VectorChunk.bulkWrite(ops, { ordered: false });
  console.log("[VECTOR/MONGO] addVectors", ids.length);
}

async function deleteByDocumentId(documentId) {
  const want = String(documentId);
  const result = await VectorChunk.deleteMany({ document_id: want });
  console.log("[VECTOR/MONGO] deleteByDocumentId", want, "removed:", result.deletedCount);
}

async function updateFolderIdForDocument(documentId, folderId = null) {
  const folderValue =
    folderId == null || folderId === "" ? "" : String(folderId).trim();
  const result = await VectorChunk.updateMany(
    { document_id: String(documentId) },
    { $set: { folder_id: folderValue } }
  );
  console.log("[VECTOR/MONGO] updateFolderIdForDocument", documentId, result.modifiedCount);
  return result.modifiedCount || 0;
}

async function searchVectors({
  embedding,
  nResults = 5,
  companyId = null,
  userId = null,
  folderId = null,
  allowedDocumentIds = null,
  fetchN: fetchOverride = null,
  companyWide = false,
}) {
  const want = Math.max(1, nResults);
  const fetchN =
    fetchOverride != null
      ? Math.min(Math.max(1, fetchOverride), 500)
      : Math.min(want * OVERFETCH_FACTOR, 500);

  const query = {};
  if (companyId != null && String(companyId).trim()) {
    query.company_id = String(companyId).trim();
  }

  const candidates = await VectorChunk.find(query).lean();
  const allowedDocSet =
    allowedDocumentIds instanceof Set
      ? allowedDocumentIds
      : Array.isArray(allowedDocumentIds)
        ? new Set(allowedDocumentIds.map(String))
        : null;

  const folderScope =
    companyWide || folderId == null || folderId === ""
      ? null
      : String(folderId).trim();
  const wantUser = userId != null && String(userId).trim() ? String(userId) : null;

  const scored = [];
  for (const row of candidates) {
    const meta = {
      company_id: row.company_id,
      document_id: row.document_id,
      uploaded_by_user_id: row.uploaded_by_user_id,
      folder_id: row.folder_id,
      parent_id: row.parent_id,
    };

    if (wantUser) {
      const vectorUser = String(meta.uploaded_by_user_id || "");
      if (vectorUser && vectorUser !== wantUser) continue;
      if (!vectorUser && allowedDocSet && !allowedDocSet.has(String(meta.document_id))) {
        continue;
      }
    } else if (allowedDocSet && !allowedDocSet.has(String(meta.document_id))) {
      continue;
    }

    if (folderScope && !vectorMatchesFolderScope(meta, folderScope)) {
      continue;
    }

    const distance = cosineDistance(embedding, row.embedding);
    scored.push({
      id: row.id,
      document: row.document,
      metadata: meta,
      distance,
    });
  }

  scored.sort((a, b) => a.distance - b.distance);
  const top = scored.slice(0, fetchN).slice(0, want);

  return {
    ids: [top.map((r) => r.id)],
    documents: [top.map((r) => r.document)],
    metadatas: [top.map((r) => r.metadata)],
    distances: [top.map((r) => r.distance)],
  };
}

async function listVectorsByCompany(companyId) {
  const rows = await VectorChunk.find({ company_id: String(companyId) }).lean();
  return rows.map((row) => ({
    id: row.id,
    document: row.document || "",
    child_text: row.document || "",
    metadata: {
      company_id: row.company_id,
      document_id: row.document_id,
      uploaded_by_user_id: row.uploaded_by_user_id,
      folder_id: row.folder_id,
    },
    distance: 0,
    score: 1,
  }));
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
