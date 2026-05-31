// services/retriever.js
// ============================================
// PRIVA-AI Retriever — OpenAI or Ollama embeddings + Chroma persistent
// Chat: local Ollama (services/llm.js)
// ============================================

require("dotenv").config();

const {
  addVectors,
  searchVectors,
  listVectorsByCompany,
  probeCollectionEmbedDim,
  vectorMatchesFolderScope,
} = require("./vectorStore");
const { chatComplete } = require("./llm");
const {
  getParentById,
  getDocumentById,
  listDocumentsByCompany,
  saveDocumentParents,
} = require("./admin");
const { EMBED_DIM_DEFAULT } = require("./ollamaConfig");
const {
  embedText: embedTextProvider,
  embedTexts,
  getEmbeddingProvider,
  getEffectiveEmbeddingProvider,
  shouldUseOpenAIEmbeddings,
  isOpenAIProvider,
  getOpenAIEmbedModel,
  getConfiguredEmbedDim,
  getPrimaryEmbedModel,
} = require("./embeddings");

const DEFAULT_TOP_K = 15;
const DEFAULT_FETCH_N = parseInt(process.env.CHROMA_FETCH_N || "150", 10);
const CHAT_TOP_K = parseInt(process.env.CHAT_TOP_K || "4", 10);
const CHAT_FETCH_N = parseInt(process.env.CHAT_FETCH_N || "50", 10);
const FOLDER_EMPTY_MESSAGE = "No information found in this folder.";
const MAX_DIVERSE_CHUNKS = parseInt(process.env.CHAT_MAX_CHUNKS || "12", 10);
const WEAK_DISTANCE_THRESHOLD = parseFloat(
  process.env.CHAT_WEAK_DISTANCE_THRESHOLD || "1.05"
);

const QUERY_NORMALIZE_SYSTEM_PROMPT =
  "You are a search query restoration assistant. Fix any obvious typos, keyboard slips, or spelling mistakes in the input query so it matches business documents (e.g., transform 'طبولة' to 'بطولة'). Return ONLY the corrected query text, in the same language, with absolutely no notes, no preamble, and no quotes.";

/** Broad workspace / multi-file summarization intent (AR + EN + FR). */
const GLOBAL_SUMMARY_PATTERNS = [
  /ملخص/i,
  /تلخيص/i,
  /لخّص/i,
  /لخص/i,
  /جميع\s+الملفات/i,
  /كل\s+الملفات/i,
  /جميع\s+المستندات/i,
  /كل\s+المستندات/i,
  /الملفات\s+المرفوعة/i,
  /المستندات\s+المرفوعة/i,
  /خطاب\s+رسمي\s+عام/i,
  /ملفات\s+طبية/i,
  /ملفات\s+قانونية/i,
  /شامل[ةa]?\s+ل/i,
  /overview\s+of\s+(all|the|every)/i,
  /summarize\s+(all|every)/i,
  /summary\s+of\s+(all|every)/i,
  /comprehensive\s+summary/i,
  /all\s+(uploaded\s+)?(files|documents)/i,
  /every\s+(file|document)/i,
  /entire\s+workspace/i,
  /across\s+all\s+(files|documents)/i,
  /résumé/i,
  /résumé\s+complet/i,
  /resume\s+complet/i,
  /\bresume\b/i,
  /synthèse/i,
  /synthèse\s+complète/i,
  /lettre\s+officielle/i,
  /tous\s+les\s+fichiers/i,
  /tous\s+les\s+documents/i,
  /l'ensemble\s+des\s+(fichiers|documents)/i,
  /récapitulatif/i,
  /compte[\s-]rendu/i,
];

const REFERENCES_ALL_DOCS_PATTERNS = [
  /جميع/i,
  /كل\s+ال/i,
  /all\s+(the\s+)?(files|documents)/i,
  /every\s+(file|document)/i,
  /الملفات\s+المرفوعة/i,
  /uploaded\s+files/i,
  /tous\s+les\s+(fichiers|documents)/i,
  /l'ensemble\s+des/i,
  /ensemble\s+des\s+(fichiers|documents)/i,
];

const SUMMARY_INTENT_HINT_RE =
  /ملخص|تلخيص|لخص|summary|summarize|draft|خطاب|overview|résumé|resume|synthèse|lettre|récapitulatif|compte[\s-]rendu/i;

function detectGlobalSummaryQuery(question) {
  const q = String(question || "").trim();
  if (!q) {
    return {
      isGlobalSummary: false,
      referencesAllDocuments: false,
      matched: [],
    };
  }

  const matched = GLOBAL_SUMMARY_PATTERNS.filter((re) => re.test(q)).map(
    (re) => re.source
  );
  const referencesAllDocuments = REFERENCES_ALL_DOCS_PATTERNS.some((re) =>
    re.test(q)
  );

  const isGlobalSummary =
    matched.length > 0 ||
    (referencesAllDocuments && SUMMARY_INTENT_HINT_RE.test(q));

  return {
    isGlobalSummary,
    referencesAllDocuments,
    matched,
  };
}

function isRetrievalWeak(hits) {
  if (!Array.isArray(hits) || hits.length === 0) return true;

  const distances = hits
    .map((h) => Number(h.distance))
    .filter((d) => Number.isFinite(d));
  if (!distances.length) return false;

  const best = Math.min(...distances);
  const avg =
    distances.reduce((sum, d) => sum + d, 0) / Math.max(distances.length, 1);

  return (
    best > WEAK_DISTANCE_THRESHOLD ||
    avg > WEAK_DISTANCE_THRESHOLD + 0.15 ||
    hits.length < 2
  );
}

/** Tier-1 folder search is strong enough — skip expensive global fallback. */
function isTier1FolderRetrievalStrong(hits) {
  return Array.isArray(hits) && hits.length > 0 && !isRetrievalWeak(hits);
}

/**
 * Log raw excerpt text that will be injected into the chat LLM (OCR / chunk debug).
 */
function debugLogContextsForLlm(contexts, label = "retrieval") {
  if (!Array.isArray(contexts) || contexts.length === 0) {
    console.log(`[DEBUG-CONTEXT] ${label}: (no contexts)`);
    return;
  }

  const blocks = contexts.map((ctx, index) => {
    const childText = String(ctx.child_text || ctx.content || "").trim();
    const parentText = String(ctx.parent_text || "").trim();
    const filename = ctx.filename || "(unknown)";
    const docId = ctx.document_id || "?";
    const distance =
      ctx.distance != null && Number.isFinite(Number(ctx.distance))
        ? Number(ctx.distance).toFixed(4)
        : "n/a";

    return [
      `[${index + 1}] file=${filename} doc=${docId} distance=${distance}`,
      `child_chars=${childText.length} parent_chars=${parentText.length}`,
      childText || "(empty child_text)",
      parentText ? `--- parent excerpt ---\n${parentText}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const joined = blocks.join("\n---\n");
  console.log(
    `[DEBUG-CONTEXT] ${label} — ${contexts.length} chunk(s) actual text for LLM:\n${joined}`
  );
}

function buildRetrievalResponse(contexts, retrievalMeta) {
  const mode = retrievalMeta?.mode || "unknown";
  debugLogContextsForLlm(contexts, `pre-LLM/${mode}`);

  return {
    contexts,
    retrieval: {
      isGlobalSummary: false,
      weakSemantic: false,
      activeDocuments: 0,
      documentsCovered: 0,
      filenames: [],
      ...retrievalMeta,
      documentsCovered: new Set(
        contexts.map((c) => c.document_id).filter(Boolean)
      ).size,
      filenames: [
        ...new Set(contexts.map((c) => c.filename).filter(Boolean)),
      ],
    },
  };
}

/**
 * LLM typo/spelling normalization — runs once at pipeline entry before any embeddings.
 */
async function normalizeSearchQueryWithLlm(query) {
  const original = String(query || "").trim();
  if (!original) return original;

  try {
    const { text } = await chatComplete({
      messages: [
        { role: "system", content: QUERY_NORMALIZE_SYSTEM_PROMPT },
        { role: "user", content: original },
      ],
    });
    const corrected = String(text || "")
      .trim()
      .replace(/^["'`]+|["'`]+$/g, "");
    if (!corrected || corrected === original) {
      return original;
    }
    console.log("[RETRIEVER] query typo-normalized", {
      from: original.slice(0, 100),
      to: corrected.slice(0, 100),
    });
    return corrected;
  } catch (err) {
    console.warn("[RETRIEVER] query normalize failed:", err.message);
    return original;
  }
}

/** Entry checkpoint: normalize query before vector search (never embed the raw typo). */
async function resolveSearchQuery(question) {
  const originalQuery = String(question || "").trim();
  if (!originalQuery) {
    return {
      originalQuery: "",
      searchQuery: "",
      queryWasNormalized: false,
    };
  }

  const searchQuery = await normalizeSearchQueryWithLlm(originalQuery);
  return {
    originalQuery,
    searchQuery,
    queryWasNormalized: searchQuery !== originalQuery,
  };
}

async function executeSemanticVectorSearch({
  question,
  embedText,
  embedding = null,
  companyIdStr,
  scopeUserId,
  folderId = null,
  allowedDocumentIds,
  topK,
  fetchN,
  maxChunks,
  companyWide = false,
  restrictToFolderId = null,
  skipFolderRestriction = false,
  skipDiversitySelection = false,
}) {
  let results;
  let queryEmbedding = embedding;
  try {
    queryEmbedding = queryEmbedding ?? (await embedText(question));
    results = await searchVectors({
      embedding: queryEmbedding,
      nResults: topK,
      fetchN,
      companyId: companyIdStr,
      userId: scopeUserId,
      folderId: companyWide ? null : folderId || null,
      allowedDocumentIds,
      companyWide,
    });
  } catch (vectorErr) {
    console.error("[RETRIEVER] vector search failed:", vectorErr.message);
    if (vectorErr.stack) console.error(vectorErr.stack);
    results = { ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] };
  }

  const pass = await finalizeSemanticPass({
    results,
    allowedDocumentIds,
    maxChunks,
    restrictToFolderId,
    skipFolderRestriction,
    skipDiversitySelection,
  });
  return { ...pass, queryEmbedding };
}

async function finalizeSemanticPass({
  results,
  allowedDocumentIds,
  maxChunks,
  restrictToFolderId = null,
  skipFolderRestriction = false,
  skipDiversitySelection = false,
}) {
  let hits = filterHitsToAllowedDocuments(
    chromaResultsToHits(results),
    allowedDocumentIds
  );

  if (restrictToFolderId && !skipFolderRestriction) {
    hits = hits.filter((hit) =>
      vectorMatchesFolderScope(hit.metadata, restrictToFolderId)
    );
  }

  const weakSemantic = isRetrievalWeak(hits);
  const contexts = await buildContextsFromChromaResults(
    hitsToChromaResults(hits),
    maxChunks,
    maxChunks,
    {
      allowedDocumentIds,
      skipAllowedDocumentFilter: true,
      restrictToFolderId: skipFolderRestriction ? null : restrictToFolderId,
      skipFolderRestriction,
      skipDiversitySelection,
    }
  );
  return { results: hitsToChromaResults(hits), hits, contexts, weakSemantic };
}

function pickEvenlySpaced(items, count) {
  if (!items?.length || count <= 0) return [];
  if (items.length <= count) return [...items];
  const picked = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.floor((i * (items.length - 1)) / Math.max(count - 1, 1));
    picked.push(items[idx]);
  }
  return picked;
}

function hitsToChromaResults(hits) {
  return {
    ids: [hits.map((h) => h.id)],
    documents: [hits.map((h) => h.document || h.child_text || "")],
    metadatas: [hits.map((h) => h.metadata || {})],
    distances: [hits.map((h) => h.distance ?? 0)],
  };
}

function mergeRetrievalContexts(primary, secondary, maxChunks) {
  const seen = new Set();
  const out = [];

  const add = (ctx) => {
    const key = [
      ctx.document_id,
      ctx.parent_sequence,
      ctx.child_sequence,
      (ctx.child_text || "").slice(0, 60),
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(ctx);
  };

  for (const c of primary) {
    if (out.length >= maxChunks) break;
    add(c);
  }
  for (const c of secondary) {
    if (out.length >= maxChunks) break;
    add(c);
  }
  return out.slice(0, maxChunks);
}

/**
 * Force raw chunks from every active document (evenly distributed), ignoring semantic distance.
 */
async function fetchDistributedGlobalHits(companyId, maxChunks, activeDocIds) {
  const allowed = new Set((activeDocIds || []).map(String));
  const allRecords = await listVectorsByCompany(companyId);
  const byDoc = new Map();

  for (const rec of allRecords) {
    const docId = String(rec.metadata?.document_id || "");
    if (!docId) continue;
    if (allowed.size > 0 && !allowed.has(docId)) continue;
    if (!byDoc.has(docId)) byDoc.set(docId, []);
    byDoc.get(docId).push(rec);
  }

  const docIds = [...byDoc.keys()];
  if (!docIds.length) {
    console.warn("[RETRIEVER] Global fallback: no vectors for company", companyId);
    return [];
  }

  for (const docId of docIds) {
    byDoc.get(docId).sort((a, b) => {
      const pa = Number(a.metadata?.parent_sequence ?? 0);
      const pb = Number(b.metadata?.parent_sequence ?? 0);
      if (pa !== pb) return pa - pb;
      return (
        Number(a.metadata?.child_sequence ?? 0) -
        Number(b.metadata?.child_sequence ?? 0)
      );
    });
  }

  const limit = Math.min(Math.max(1, maxChunks), MAX_DIVERSE_CHUNKS);
  const basePerDoc = Math.max(1, Math.floor(limit / docIds.length));
  let remainder = limit - basePerDoc * docIds.length;
  const selected = [];

  for (const docId of docIds) {
    let quota = basePerDoc + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
    const chunks = byDoc.get(docId) || [];
    selected.push(...pickEvenlySpaced(chunks, Math.min(quota, chunks.length)));
  }

  if (selected.length < limit) {
    let round = 0;
    while (selected.length < limit) {
      let added = false;
      for (const docId of docIds) {
        const chunks = byDoc.get(docId) || [];
        if (round < chunks.length) {
          const candidate = chunks[round];
          if (!selected.some((s) => s.id === candidate.id)) {
            selected.push(candidate);
            added = true;
            if (selected.length >= limit) break;
          }
        }
      }
      if (!added) break;
      round += 1;
    }
  }

  console.log("[RETRIEVER] Global distributed hits", {
    documents: docIds.length,
    selected: selected.length,
    perDocBase: basePerDoc,
  });

  return selected.slice(0, limit);
}

const SPONSOR_KEYWORDS = [
  "راعي",
  "رعاية",
  "برعاية",
  "راعٍ",
  "sponsor",
  "sponsored",
  "مقدم من",
  "بالتعاون",
  "شريك",
  "partner",
  "شركة",
  "بنك",
  "مصرف",
  "اتصالات",
  "du",
  "etisalat",
  "flyemirates",
  "نادي",
];

function boostSponsorChunks(chunks) {
  return chunks
    .map((chunk) => {
      const text = (chunk.content || chunk.document || chunk.child_text || "").toLowerCase();
      let boost = 0;
      for (const kw of SPONSOR_KEYWORDS) {
        if (text.includes(kw.toLowerCase())) boost += 0.25;
      }
      if (text.length < 300) boost += 0.15;
      const base = chunk.distance != null ? -Number(chunk.distance) : 0;
      return {
        ...chunk,
        score: base + boost,
      };
    })
    .sort((a, b) => b.score - a.score);
}

function documentKeyForChunk(chunk) {
  const meta = chunk.metadata || {};
  if (meta.document_id != null && String(meta.document_id).trim()) {
    return `doc:${meta.document_id}`;
  }
  if (meta.filename != null && String(meta.filename).trim()) {
    return `file:${meta.filename}`;
  }
  return `id:${chunk.id || "unknown"}`;
}

/**
 * Prefer at least one high-scoring chunk per distinct document before filling remaining slots.
 */
function selectMultiDocumentChunks(hits, maxChunks = CHAT_TOP_K) {
  const boosted = boostSponsorChunks(hits);
  const sorted = [...boosted].sort((a, b) => (b.score || 0) - (a.score || 0));
  const buckets = new Map();

  for (const chunk of sorted) {
    const key = documentKeyForChunk(chunk);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(chunk);
  }

  const selected = [];
  const seenText = new Set();

  const tryAdd = (chunk) => {
    const text = (chunk.content || chunk.document || chunk.child_text || "")
      .trim()
      .substring(0, 80);
    if (!text || seenText.has(text)) return false;
    seenText.add(text);
    selected.push(chunk);
    return true;
  };

  const bucketLists = [...buckets.values()];
  let round = 0;
  while (selected.length < maxChunks && bucketLists.some((list) => list.length > round)) {
    for (const list of bucketLists) {
      if (round < list.length && selected.length < maxChunks) {
        tryAdd(list[round]);
      }
    }
    round += 1;
  }

  for (const chunk of sorted) {
    if (selected.length >= maxChunks) break;
    tryAdd(chunk);
  }

  console.log(
    `[Retriever] Multi-document select: ${selected.length} chunks across ${buckets.size} file(s)`
  );
  return selected.slice(0, maxChunks);
}

function selectDiverseChunks(hits, topK, maxUnique = MAX_DIVERSE_CHUNKS) {
  const limit = Math.min(Math.max(1, topK), maxUnique);
  return selectMultiDocumentChunks(hits, limit);
}

function selectBestChunks(chunks, maxChunks = 3, poolLimit = maxChunks) {
  const sorted = [...chunks].sort((a, b) => (b.score || 0) - (a.score || 0));
  const selected = [];
  const seenTexts = new Set();

  for (const chunk of sorted) {
    const text = (chunk.content || chunk.document || chunk.child_text || "").substring(0, 50);
    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    selected.push(chunk);
    if (selected.length >= poolLimit) break;
  }

  console.log(`[Retriever] Selected ${selected.length} best chunks from ${chunks.length}`);
  return selected.slice(0, maxChunks);
}

function chromaResultsToHits(results) {
  const hits = [];
  const rowCount = results.ids[0]?.length || 0;
  for (let i = 0; i < rowCount; i++) {
    hits.push({
      id: results.ids[0][i],
      document: results.documents[0][i] || "",
      child_text: results.documents[0][i] || "",
      metadata: results.metadatas[0][i] || {},
      distance: results.distances[0][i],
    });
  }
  return hits;
}

function filterHitsToAllowedDocuments(hits, allowedDocumentIds) {
  if (!allowedDocumentIds || allowedDocumentIds.size === 0) {
    return hits;
  }
  return hits.filter((hit) => {
    const docId = String(hit.metadata?.document_id || "");
    return docId && allowedDocumentIds.has(docId);
  });
}

async function buildContextsFromChromaResults(
  results,
  topK,
  maxUnique = topK,
  options = {}
) {
  let hits = chromaResultsToHits(results);
  if (options.allowedDocumentIds && !options.skipAllowedDocumentFilter) {
    hits = filterHitsToAllowedDocuments(hits, options.allowedDocumentIds);
  }
  if (options.restrictToFolderId && !options.skipFolderRestriction) {
    const folderId = String(options.restrictToFolderId);
    hits = hits.filter((hit) =>
      vectorMatchesFolderScope(hit.metadata, folderId)
    );
  }
  const hardCap = Math.min(
    Math.max(1, topK),
    Math.max(1, maxUnique),
    MAX_DIVERSE_CHUNKS
  );
  const selected = options.skipDiversitySelection
    ? hits.slice(0, hardCap)
    : selectDiverseChunks(hits, hardCap, hardCap);
  const contexts = [];

  for (const hit of selected) {
    const meta = hit.metadata || {};
    const parentId = meta.parent_id;

    const childText = hit.child_text || hit.document || "";
    let parentText = "";
    if (parentId) {
      try {
        const row = await getParentById(String(parentId));
        if (row?.text && row.text !== childText) {
          parentText = row.text;
        }
      } catch (e) {
        console.warn("[RETRIEVER] getParentById", parentId, e.message);
      }
    }

    let filename = meta.filename || null;
    try {
      if (meta.document_id) {
        const doc = await getDocumentById(String(meta.document_id));
        if (doc?.filename) filename = doc.filename;
      }
    } catch (e) {
      console.warn("[RETRIEVER] getDocumentById", meta.document_id, e.message);
    }

    const rank = contexts.length + 1;
    const parentSeq =
      meta.parent_sequence != null ? Number(meta.parent_sequence) : null;
    const childSeq =
      meta.child_sequence != null ? Number(meta.child_sequence) : null;
    let pageLabel = null;
    if (meta.page != null && String(meta.page).trim()) {
      pageLabel = String(meta.page);
    } else if (parentSeq != null || childSeq != null) {
      pageLabel = `section ${(parentSeq ?? 0) + 1}, chunk ${(childSeq ?? 0) + 1}`;
    } else {
      pageLabel = `chunk ${rank}`;
    }

    contexts.push({
      rank,
      citationTag: `[Source ${rank}]`,
      child_text: childText,
      parent_text: parentText !== childText ? parentText : "",
      document_id: meta.document_id,
      parent_id: parentId,
      filename,
      page_label: pageLabel,
      parent_sequence: parentSeq,
      child_sequence: childSeq,
      distance: hit.distance,
      score: hit.score,
    });
  }

  console.log("[RETRIEVER] diverse contexts", {
    rawHits: hits.length,
    afterBoostSelect: selected.length,
    returned: contexts.length,
  });

  return contexts;
}

/** Deduplicated filenames from retrieved contexts (for SSE attribution). */
function collectUniqueSourceFilenames(contexts) {
  const seen = new Set();
  const filenames = [];
  for (const ctx of contexts || []) {
    const raw = ctx?.filename;
    if (raw == null || !String(raw).trim()) continue;
    const name = String(raw).trim();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    filenames.push(name);
  }
  return filenames;
}

class ArabicParentDocumentRetriever {
  constructor(options = {}) {
    this.resolveApiKey = options.resolveApiKey || (async () => null);
    this._expectedEmbedDim = null;

    const provider = getEffectiveEmbeddingProvider();
    if (shouldUseOpenAIEmbeddings() || isOpenAIProvider()) {
      console.log(
        "[RETRIEVER] Initialized (OpenAI embeddings):",
        getOpenAIEmbedModel(),
        "| dim:",
        getConfiguredEmbedDim(),
        "| env:",
        provider
      );
    } else {
      console.log(
        "[RETRIEVER] Initialized (Ollama embeddings):",
        process.env.OLLAMA_URL || "http://127.0.0.1:11434",
        "| model:",
        getPrimaryEmbedModel(),
        "| dim:",
        getConfiguredEmbedDim()
      );
    }
  }

  async getExpectedEmbedDim() {
    if (this._expectedEmbedDim != null) return this._expectedEmbedDim;

    const configured = getConfiguredEmbedDim();
    const probed = await probeCollectionEmbedDim("company_docs");

    if (isOpenAIProvider()) {
      this._expectedEmbedDim = configured;
      if (probed != null && probed !== configured) {
        console.warn(
          `[RETRIEVER] Chroma has ${probed}-dim vectors; config expects ${configured}. ` +
            `Collection will be recreated on next index (re-upload documents).`
        );
      }
    } else {
      this._expectedEmbedDim =
        probed && Number.isFinite(probed) && probed > 0 ? probed : configured;
    }

    console.log("[RETRIEVER] Expected embedding dimension:", this._expectedEmbedDim);
    return this._expectedEmbedDim;
  }

  async embedText(text, _apiKey = null, options = {}) {
    await this.getExpectedEmbedDim();
    return embedTextProvider(text, options);
  }

  async embedTexts(texts, onProgress, options = {}) {
    await this.getExpectedEmbedDim();
    return embedTexts(texts, onProgress, options);
  }

  async indexDocument({
    company,
    document_id,
    text,
    onProgress,
    uploaded_by_user_id = null,
    folder_id = null,
  }) {
    const companyIdStr = String(company.id);
    const existingDoc = await getDocumentById(document_id);
    let uploaderId = uploaded_by_user_id;
    if (!uploaderId) {
      uploaderId = existingDoc?.uploaded_by_user_id || existingDoc?.user_id || null;
    }
    const uploaderIdStr = uploaderId ? String(uploaderId) : "";
    const folderIdStr =
      folder_id != null && folder_id !== ""
        ? String(folder_id)
        : existingDoc?.folder_id
          ? String(existingDoc.folder_id)
          : "";

    const embedOpts = { isTrial: companyIdStr.startsWith("trial_") };

    console.log("[INDEX] start", {
      document_id,
      company_id: companyIdStr,
      folder_id: folderIdStr || null,
      uploaded_by_user_id: uploaderIdStr || null,
      provider: getEffectiveEmbeddingProvider(embedOpts),
      is_trial: embedOpts.isTrial,
    });

    const parents = this.splitIntoParents(text, 2000);
    const parentPlans = parents.map((parent, p) => ({
      parent,
      p,
      parentId: `${document_id}_parent_${p}`,
      children: this.splitIntoChildren(parent, 400),
    }));

    const totalChunks = parentPlans.reduce((n, plan) => n + plan.children.length, 0);
    const expectedDim = await this.getExpectedEmbedDim();
    let globalChunkIndex = 0;
    let totalParents = 0;
    let totalChildren = 0;
    const parentRecords = [];

    const reportEmbeddingProgress = () => {
      if (!onProgress || totalChunks === 0) return;
      const percent = Math.min(100, Math.round((globalChunkIndex / totalChunks) * 100));
      onProgress({
        phase: "embedding",
        current: globalChunkIndex,
        total: totalChunks,
        percent,
        message: `Embedding chunk ${globalChunkIndex}/${totalChunks}`,
      });
    };

    if (onProgress) {
      onProgress({
        phase: "embedding",
        current: 0,
        total: totalChunks,
        percent: 0,
        message: `Starting embeddings (0/${totalChunks})`,
      });
    }

    for (const plan of parentPlans) {
      const { parent, p, parentId, children } = plan;
      const childEmbeddings = [];

      for (let c = 0; c < children.length; c++) {
        const child = children[c];
        const embedding = await embedTextProvider(child, embedOpts);
        if (embedding.length !== expectedDim) {
          throw new Error(
            `Embedding dimension ${embedding.length} does not match CHROMA_EMBED_DIM=${expectedDim}`
          );
        }
        childEmbeddings.push(embedding);
        globalChunkIndex++;
        reportEmbeddingProgress();
      }

      const childIds = [];
      const childMetadatas = [];
      const childDocuments = [];

      for (let c = 0; c < children.length; c++) {
        const child = children[c];
        const childId = `${parentId}_child_${c}`;
        childIds.push(childId);
        childMetadatas.push({
          company_id: companyIdStr,
          document_id: String(document_id),
          uploaded_by_user_id: uploaderIdStr,
          folder_id: folderIdStr,
          parent_id: parentId,
          parent_sequence: p,
          child_sequence: c,
          is_child: true,
        });
        childDocuments.push(child);
        totalChildren++;
      }

      await addVectors({
        ids: childIds,
        embeddings: childEmbeddings,
        metadatas: childMetadatas,
        documents: childDocuments,
      });

      parentRecords.push({
        id: parentId,
        company_id: companyIdStr,
        document_id: String(document_id),
        parent_index: p,
        text: parent,
        child_ids: childIds,
        created_at: new Date().toISOString(),
      });

      totalParents++;
    }

    await saveDocumentParents(parentRecords);
    console.log("[INDEX] done", { parents: totalParents, children: totalChildren });

    if (onProgress) {
      onProgress({
        phase: "embedding",
        current: totalChunks,
        total: totalChunks,
        percent: 100,
        message: "Embeddings complete",
      });
    }

    return {
      parentsStored: totalParents,
      childrenIndexed: totalChildren,
      totalChunks,
    };
  }

  async retrieve({
    question,
    company_id,
    user_id = null,
    folder_id = null,
    topK = CHAT_TOP_K,
    fetchN = CHAT_FETCH_N,
    apiKey = null,
  }) {
    return retrieveForChat({
      question,
      company_id,
      user_id,
      folder_id,
      topK,
      fetchN,
      embedText: (text) => this.embedText(text, apiKey),
    });
  }

  splitIntoParents(text, size) {
    const chunks = [];
    const paragraphs = String(text).split(/\n\s*\n/);
    let current = "";

    for (const para of paragraphs) {
      if ((current + para).length > size && current.length > 0) {
        chunks.push(current.trim());
        current = para;
      } else {
        current += "\n\n" + para;
      }
    }
    if (current) chunks.push(current.trim());
    return chunks;
  }

  splitIntoChildren(text, size) {
    const sentences = String(text).split(/(?<=[.۔!؟])\s+/);
    const chunks = [];
    let current = "";

    for (const sentence of sentences) {
      if ((current + sentence).length > size && current.length > 0) {
        chunks.push(current.trim());
        current = sentence;
      } else {
        current += sentence;
      }
    }
    if (current) chunks.push(current.trim());
    return chunks;
  }
}

/**
 * Company-wide chat retrieval (root / global view) with optional summary fallback.
 */
async function retrieveCompanyWide({
  searchQuery,
  originalQuery,
  queryWasNormalized = false,
  embedText,
  companyIdStr,
  scopeUserId,
  topK,
  fetchN,
  maxChunks,
  intent,
}) {
  const companyDocs = await listDocumentsByCompany(companyIdStr, {
    user_id: scopeUserId,
    folder_id: null,
    all_folders: true,
  });
  const activeDocIds = companyDocs.map((d) => String(d.id));
  const allowedDocumentIds = new Set(activeDocIds);

  let queryEmbedding = null;
  try {
    queryEmbedding = await embedText(searchQuery);
  } catch (embedErr) {
    console.error("[RETRIEVER] company-wide embed failed:", embedErr.message);
  }

  const semantic = await executeSemanticVectorSearch({
    question: searchQuery,
    embedText,
    embedding: queryEmbedding,
    companyIdStr,
    scopeUserId,
    companyWide: true,
    allowedDocumentIds,
    skipFolderRestriction: true,
    topK,
    fetchN,
    maxChunks,
  });

  const coveredDocIds = new Set(
    semantic.contexts.map((c) => String(c.document_id || "")).filter(Boolean)
  );
  const missingDocCount =
    activeDocIds.length > 0
      ? activeDocIds.filter((id) => !coveredDocIds.has(id)).length
      : 0;

  const needsDistributedFallback =
    intent.isGlobalSummary ||
    semantic.weakSemantic ||
    (activeDocIds.length > 1 &&
      missingDocCount > 0 &&
      intent.referencesAllDocuments);

  let contexts = semantic.contexts;
  let retrievalMode = "semantic";
  let weakSemantic = semantic.weakSemantic;

  if (needsDistributedFallback && activeDocIds.length > 0) {
    const globalHits = await fetchDistributedGlobalHits(
      companyIdStr,
      maxChunks,
      activeDocIds
    );

    if (globalHits.length > 0) {
      const globalResults = hitsToChromaResults(globalHits);
      const globalContexts = await buildContextsFromChromaResults(
        globalResults,
        maxChunks,
        maxChunks,
        { skipDiversitySelection: true, allowedDocumentIds }
      );

      contexts =
        intent.isGlobalSummary || semantic.weakSemantic
          ? mergeRetrievalContexts(globalContexts, semantic.contexts, maxChunks)
          : mergeRetrievalContexts(
              semantic.contexts,
              globalContexts,
              maxChunks
            );

      retrievalMode = intent.isGlobalSummary
        ? "global_summary"
        : semantic.weakSemantic
          ? "global_weak_semantic"
          : "global_supplement";
      weakSemantic = false;
    }
  }

  console.log("[RETRIEVER] retrieveForChat done (company-wide)", {
    mode: retrievalMode,
    contexts: contexts.length,
    weakSemantic,
    missingDocCount,
  });

  return buildRetrievalResponse(contexts, {
    mode: retrievalMode,
    isGlobalSummary: intent.isGlobalSummary,
    weakSemantic,
    activeDocuments: activeDocIds.length,
    folder_id: null,
    retrievalTier: 1,
    originalQuery,
    searchQuery,
    queryWasNormalized,
  });
}

/**
 * Folder-scoped two-tier retrieval:
 * Tier 1 — strict folder filter; Tier 2 — company-wide if tier 1 is empty/weak.
 */
async function retrieveFolderScoped({
  searchQuery,
  originalQuery,
  queryWasNormalized = false,
  embedText,
  companyIdStr,
  scopeUserId,
  folderScope,
  topK,
  fetchN,
  maxChunks,
}) {
  let queryEmbedding = null;
  try {
    queryEmbedding = await embedText(searchQuery);
    console.log("[RETRIEVER] folder pipeline embedding ready", {
      queryWasNormalized,
      searchPreview: searchQuery.slice(0, 80),
    });
  } catch (embedErr) {
    console.error("[RETRIEVER] folder pipeline embed failed:", embedErr.message);
  }

  const folderDocs = await listDocumentsByCompany(companyIdStr, {
    user_id: scopeUserId,
    folder_id: folderScope,
    all_folders: false,
  });
  const folderDocIds = folderDocs.map((d) => String(d.id));
  const folderAllowedIds = new Set(folderDocIds);

  let tier1 = {
    hits: [],
    contexts: [],
    weakSemantic: true,
    queryEmbedding: null,
  };

  if (folderDocIds.length > 0) {
    console.log("[RETRIEVER] tier-1 strict folder search", folderScope);
    tier1 = await executeSemanticVectorSearch({
      question: searchQuery,
      embedText,
      embedding: queryEmbedding,
      companyIdStr,
      scopeUserId,
      folderId: folderScope,
      allowedDocumentIds: folderAllowedIds,
      restrictToFolderId: folderScope,
      skipFolderRestriction: false,
      topK,
      fetchN,
      maxChunks,
    });
  } else {
    console.log("[RETRIEVER] tier-1 skipped — folder has no documents", folderScope);
  }

  if (isTier1FolderRetrievalStrong(tier1.hits)) {
    console.log("[RETRIEVER] tier-1 satisfied — using folder-only context", {
      hits: tier1.hits.length,
      bestDistance: Math.min(...tier1.hits.map((h) => Number(h.distance) || 999)),
    });
    return buildRetrievalResponse(tier1.contexts, {
      mode: "folder_strict",
      weakSemantic: false,
      activeDocuments: folderDocIds.length,
      folder_id: folderScope,
      retrievalTier: 1,
      emptyFolder: false,
      originalQuery,
      searchQuery,
      queryWasNormalized,
    });
  }

  console.log("[RETRIEVER] tier-1 weak/empty — tier-2 company-wide fallback", {
    folderScope,
    tier1Hits: tier1.hits.length,
    tier1Weak: tier1.weakSemantic,
  });

  const companyDocs = await listDocumentsByCompany(companyIdStr, {
    user_id: scopeUserId,
    folder_id: null,
    all_folders: true,
  });
  const companyAllowedIds = new Set(companyDocs.map((d) => String(d.id)));

  const tier2 = await executeSemanticVectorSearch({
    question: searchQuery,
    embedText,
    embedding: queryEmbedding ?? tier1.queryEmbedding,
    companyIdStr,
    scopeUserId,
    companyWide: true,
    allowedDocumentIds: companyAllowedIds,
    skipFolderRestriction: true,
    skipDiversitySelection: true,
    topK,
    fetchN,
    maxChunks,
  });

  const tier2Strong =
    tier2.contexts.length > 0 &&
    (isTier1FolderRetrievalStrong(tier2.hits) || !tier2.weakSemantic);

  if (tier2Strong) {
    console.log("[RETRIEVER] tier-2 fallback succeeded", {
      contexts: tier2.contexts.length,
      hits: tier2.hits.length,
      queryWasNormalized,
      filenames: [
        ...new Set(tier2.contexts.map((c) => c.filename).filter(Boolean)),
      ],
      mode: "folder_global_fallback",
    });
    return buildRetrievalResponse(tier2.contexts, {
      mode: "folder_global_fallback",
      weakSemantic: false,
      activeDocuments: companyDocs.length,
      folder_id: folderScope,
      retrievalTier: 2,
      emptyFolder: false,
      fallbackFromFolder: folderScope,
      usedCompanyWideContext: true,
      originalQuery,
      searchQuery,
      queryWasNormalized,
    });
  }

  console.log("[RETRIEVER] tier-1 and tier-2 returned no usable context", {
    folderScope,
    queryWasNormalized,
    tier2Hits: tier2.hits.length,
    tier2Weak: tier2.weakSemantic,
  });
  return {
    contexts: [],
    retrieval: {
      mode: "folder_empty",
      emptyFolder: true,
      folder_id: folderScope,
      isGlobalSummary: false,
      weakSemantic: true,
      activeDocuments: folderDocIds.length,
      documentsCovered: 0,
      filenames: [],
      retrievalTier: 2,
      message: FOLDER_EMPTY_MESSAGE,
      originalQuery,
      searchQuery,
      queryWasNormalized,
    },
  };
}

/**
 * Unified chat retrieval: semantic search + folder two-tier fallback + summary routing.
 */
async function retrieveForChat({
  question,
  company_id,
  user_id = null,
  folder_id = null,
  topK = CHAT_TOP_K,
  fetchN = CHAT_FETCH_N,
  embedText,
}) {
  const companyIdStr = String(company_id);
  const scopeUserId = user_id ? String(user_id) : null;
  const folderScope =
    folder_id == null || folder_id === "" ? null : String(folder_id).trim();
  const maxChunks = Math.min(Math.max(1, topK), MAX_DIVERSE_CHUNKS);

  const { originalQuery, searchQuery, queryWasNormalized } =
    await resolveSearchQuery(question);
  const intent = detectGlobalSummaryQuery(originalQuery);

  console.log("[RETRIEVER] retrieveForChat", {
    company_id: companyIdStr,
    user_id: scopeUserId || "(company)",
    folder_id: folderScope || "(company-wide)",
    queryWasNormalized,
    originalPreview: originalQuery.slice(0, 80),
    searchPreview: searchQuery.slice(0, 80),
    topK,
    fetchN,
    maxChunks,
    isGlobalSummary: intent.isGlobalSummary,
    intentMatched: intent.matched,
  });

  if (!searchQuery) {
    return {
      contexts: [],
      retrieval: {
        mode: "empty_query",
        weakSemantic: true,
        activeDocuments: 0,
        documentsCovered: 0,
        filenames: [],
      },
    };
  }

  try {
    if (folderScope) {
      return await retrieveFolderScoped({
        searchQuery,
        originalQuery,
        queryWasNormalized,
        embedText,
        companyIdStr,
        scopeUserId,
        folderScope,
        topK,
        fetchN,
        maxChunks,
      });
    }

    return await retrieveCompanyWide({
      searchQuery,
      originalQuery,
      queryWasNormalized,
      embedText,
      companyIdStr,
      scopeUserId,
      topK,
      fetchN,
      maxChunks,
      intent,
    });
  } catch (err) {
    console.error("[RETRIEVER] retrieveForChat failed:", err.message);
    if (err.stack) console.error(err.stack);
    return {
      contexts: [],
      retrieval: {
        mode: "error",
        isGlobalSummary: false,
        weakSemantic: true,
        activeDocuments: 0,
        documentsCovered: 0,
        filenames: [],
        error: err.message,
      },
    };
  }
}

module.exports = {
  ArabicParentDocumentRetriever,
  retrieveForChat,
  debugLogContextsForLlm,
  resolveSearchQuery,
  normalizeSearchQueryWithLlm,
  detectGlobalSummaryQuery,
  isRetrievalWeak,
  isTier1FolderRetrievalStrong,
  fetchDistributedGlobalHits,
  buildContextsFromChromaResults,
  collectUniqueSourceFilenames,
  mergeRetrievalContexts,
  boostSponsorChunks,
  selectDiverseChunks,
  selectMultiDocumentChunks,
  selectBestChunks,
  documentKeyForChunk,
  DEFAULT_TOP_K,
  DEFAULT_FETCH_N,
  CHAT_TOP_K,
  CHAT_FETCH_N,
  FOLDER_EMPTY_MESSAGE,
  EMBED_DIM_DEFAULT,
};
