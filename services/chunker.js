const LEGAL_MARKER_REGEX = /(?=\b(?:المادة|البند|الطرف)\b)/g;
const { splitIntoTokenChunks, countTokens } = require("./tokenChunker");

/** Default token budget per chunk for the GPT-4o-mini RAG pipeline. */
const DEFAULT_MAX_TOKENS = 800;
/** Overlap ratio between adjacent chunks so context is never lost. */
const DEFAULT_OVERLAP_RATIO = 0.2;

function detectDocumentType(filename, mimeType, sampleText) {
  const name = String(filename || "").toLowerCase();
  const sample = `${String(sampleText || "").slice(0, 2500)}\n${name}`;

  if (/championship|بطولة|esports|e-?sports|gaming|الكتروني/i.test(sample)) {
    return "event_flyer";
  }
  if (/عقد|اتفاق|contract|agreement|mou|nda/i.test(sample)) {
    return "contract";
  }
  if (/قانون|لائحة|مرسوم|regulation|policy/i.test(sample)) {
    return "legal_policy";
  }
  if (String(mimeType || "").includes("pdf")) {
    return "pdf_document";
  }
  if (String(mimeType || "").toLowerCase().startsWith("image/")) {
    return "scanned_image";
  }
  return "general_document";
}

function buildGlobalPrefix(filename, documentType) {
  const safeName = String(filename || "unknown").replace(/\s+/g, " ").trim() || "unknown";
  const type = String(documentType || "general_document");
  return `[Document: ${safeName} | Type: ${type}] -> `;
}

function splitByLegalMarkers(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) {
    return [];
  }

  const markerSplit = normalized.split(LEGAL_MARKER_REGEX).map((part) => part.trim());
  const paragraphs = markerSplit
    .flatMap((part) => part.split(/\n{2,}/g))
    .map((part) => part.trim())
    .filter(Boolean);

  return paragraphs;
}

function detectContentType(text) {
  const snippet = String(text || "");
  if (/المادة|Article|مادة/i.test(snippet)) {
    return "article";
  }
  if (/التوقيع|Signature|Signed|الموقع/i.test(snippet)) {
    return "signature";
  }
  return "legal_clause";
}

function groupIntoBodyChunks(
  text,
  maxTokens = DEFAULT_MAX_TOKENS,
  overlapRatio = DEFAULT_OVERLAP_RATIO
) {
  const paragraphs = splitByLegalMarkers(text);
  const bodyChunks = [];

  if (paragraphs.length === 0) {
    return bodyChunks;
  }

  // Token budget reserved to keep a single paragraph below the chunk cap.
  let current = "";
  const currentTokenCount = () => countTokens(current);

  const addToCurrent = (candidate) => {
    if (currentTokenCount() + countTokens(candidate) <= maxTokens) {
      current = current ? `${current}\n\n${candidate}` : candidate;
      return true;
    }
    return false;
  };

  const flush = () => {
    if (current) {
      bodyChunks.push(current.trim());
      current = "";
    }
  };

  for (const paragraph of paragraphs) {
    if (addToCurrent(paragraph)) {
      continue;
    }

    // Paragraph does not fit within the remaining budget: flush what we have.
    flush();

    if (countTokens(paragraph) <= maxTokens) {
      current = paragraph;
      continue;
    }

    // A single oversized paragraph is split on tokens with 20% overlap.
    bodyChunks.push(...splitIntoTokenChunks(paragraph, { maxTokens, overlapRatio }));
  }

  flush();

  return bodyChunks;
}

function semanticChunk(
  text,
  maxTokens = DEFAULT_MAX_TOKENS,
  overlapRatio = DEFAULT_OVERLAP_RATIO,
  context = {}
) {
  const { filename, mime_type: mimeType, document_type: explicitType } = context;
  const documentType =
    explicitType || detectDocumentType(filename, mimeType, text);
  const prefix = buildGlobalPrefix(filename, documentType);

  const bodyChunks = groupIntoBodyChunks(text, maxTokens, overlapRatio);

  return bodyChunks.map((chunkText, index) => {
    const inner = chunkText;
    const enriched = `${prefix}${inner}`;
    return {
      text: enriched,
      metadata: {
        content_type: detectContentType(inner),
        index,
        document_type: documentType,
        context_prefix: prefix.trim(),
      },
    };
  });
}

module.exports = {
  semanticChunk,
  detectDocumentType,
  buildGlobalPrefix,
  groupIntoBodyChunks,
};
