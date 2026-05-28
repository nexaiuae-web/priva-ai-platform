/**
 * Ollama chat + embedding defaults (local-first).
 * Embeddings: services/embeddings.js (EMBEDDING_PROVIDER=ollama | openai).
 */

require("dotenv").config();

const EMBED_DIM_DEFAULT = Number.parseInt(process.env.CHROMA_EMBED_DIM || "768", 10);

function uniqueModels(list) {
  const seen = new Set();
  const out = [];
  for (const m of list) {
    const s = String(m || "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** Fast chat model (OLLAMA_MODEL / OLLAMA_CHAT_MODEL). */
function getChatModel() {
  return (
    process.env.OLLAMA_CHAT_MODEL ||
    process.env.OLLAMA_MODEL ||
    "qwen2.5:1.5b"
  ).trim();
}

/** Ollama embedding model (EMBEDDING_PROVIDER=ollama). */
function getPrimaryEmbedModel() {
  return (process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text").trim();
}

/** Models to try until embedding dimension matches CHROMA_EMBED_DIM. */
function getEmbedModelCandidates() {
  return uniqueModels([
    process.env.OLLAMA_EMBED_MODEL,
    "nomic-embed-text",
    "mxbai-embed-large",
    "all-minilm",
    process.env.OLLAMA_MODEL,
  ]);
}

module.exports = {
  EMBED_DIM_DEFAULT,
  getChatModel,
  getPrimaryEmbedModel,
  getEmbedModelCandidates,
};
