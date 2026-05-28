const LEGAL_MARKER_REGEX = /(?=\b(?:المادة|البند|الطرف)\b)/g;

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

function groupIntoBodyChunks(text, maxChars = 800, overlapChars = 100) {
  const paragraphs = splitByLegalMarkers(text);
  const bodyChunks = [];

  if (paragraphs.length === 0) {
    return bodyChunks;
  }

  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      bodyChunks.push(current);
    }

    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    let start = 0;
    while (start < paragraph.length) {
      const end = Math.min(start + maxChars, paragraph.length);
      bodyChunks.push(paragraph.slice(start, end));
      if (end >= paragraph.length) {
        break;
      }
      start = Math.max(0, end - overlapChars);
    }
    current = "";
  }

  if (current) {
    bodyChunks.push(current);
  }

  return bodyChunks;
}

function semanticChunk(text, maxChars = 800, overlapChars = 100, context = {}) {
  const { filename, mime_type: mimeType, document_type: explicitType } = context;
  const documentType =
    explicitType || detectDocumentType(filename, mimeType, text);
  const prefix = buildGlobalPrefix(filename, documentType);

  const bodyChunks = groupIntoBodyChunks(text, maxChars, overlapChars);

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
