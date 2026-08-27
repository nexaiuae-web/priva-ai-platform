/**
 * Token-aware text chunking for the PRIVA RAG pipeline.
 *
 * Uses js-tiktoken with the GPT-4o-mini encoding (o200k_base) so that chunk
 * boundaries are measured in the same token space the chat/completion model
 * consumes. Chunks are produced with a configurable overlap (default 20%) so
 * that context spanning two adjacent chunks is preserved across the boundary.
 */

let _encoding = null;

/**
 * Lazily resolve the tokenizer. Falls back to cl100k_base if the
 * gpt-4o-mini-specific encoding cannot be loaded.
 */
function getEncoding() {
  if (_encoding) return _encoding;
  const { encodingForModel } = require("js-tiktoken");
  try {
    _encoding = encodingForModel("gpt-4o-mini");
  } catch (e) {
    console.warn(
      "[TOKEN-CHUNKER] gpt-4o-mini encoding unavailable, falling back to cl100k_base:",
      e.message
    );
    _encoding = encodingForModel("cl100k_base");
  }
  return _encoding;
}

/**
 * Count tokens for a piece of text using the GPT-4o-mini encoding.
 * @param {string} text
 * @returns {number}
 */
function countTokens(text) {
  if (!text) return 0;
  return getEncoding().encode(String(text)).length;
}

/**
 * Estimate tokens on a per-character heuristic, as a safe fallback if the
 * tokenizer cannot be built. Tuned for mixed Arabic/English document text.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  const nonAscii = (s.match(/[^\x00-\x7F]/g) || []).length;
  const ascii = s.length - nonAscii;
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

/**
 * Split text into token-bounded chunks with a configurable overlap.
 *
 * The text is tokenised once and walked with a sliding window so that exactly
 * `overlapTokens` tokens are shared between adjacent chunks:
 *
 *   chunk i  -> tokens [start, start + maxTokens)
 *   next start = end - overlapTokens
 *
 * Every chunk is capped at `maxTokens` tokens (default 800) and overlaps its
 * neighbours by `overlapRatio` (default 20% -> 160 tokens). This guarantees
 * no context is lost at a split boundary.
 *
 * @param {string} text
 * @param {{ maxTokens?: number, overlapRatio?: number, overlapTokens?: number }} [opts]
 * @returns {string[]} Overlapping text chunks (trimmed, non-empty).
 */
function splitIntoTokenChunks(text, opts = {}) {
  const input = String(text || "");
  const trimmedInput = input.trim();
  if (!trimmedInput) return [];

  const maxTokens = Math.max(2, Math.floor(opts.maxTokens) || 800);

  const overlapRatio = Number(opts.overlapRatio);
  let overlapTokens =
    Number.isFinite(overlapRatio) && overlapRatio > 0
      ? Math.round(maxTokens * overlapRatio)
      : (Number.isInteger(opts.overlapTokens) ? opts.overlapTokens : 0);
  overlapTokens = Math.max(0, Math.min(overlapTokens, maxTokens - 1));

  const enc = getEncoding();
  const ids = enc.encode(trimmedInput);
  if (ids.length === 0) return [];

  if (ids.length <= maxTokens) {
    return [trimmedInput];
  }

  const chunks = [];
  let start = 0;

  while (start < ids.length) {
    const end = Math.min(start + maxTokens, ids.length);
    const chunkText = enc.decode(ids.slice(start, end)).trim();
    if (chunkText) {
      chunks.push(chunkText);
    }
    if (end >= ids.length) break;
    start = end - overlapTokens;
  }

  return chunks;
}

module.exports = {
  splitIntoTokenChunks,
  countTokens,
  estimateTokens,
  getEncoding,
};
