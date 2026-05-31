/**
 * Embedding providers — OpenAI (cloud) or Ollama (local dev).
 * On Render / production / trial sessions, routes through OpenAI when OPENAI_API_KEY is set.
 */

require("dotenv").config();

const { OpenAIEmbeddings } = require("@langchain/openai");
const {
  EMBED_DIM_DEFAULT,
  getEmbedModelCandidates,
  getPrimaryEmbedModel,
} = require("./ollamaConfig");
const { isRenderPlatform } = require("./runtimeConfig");

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

let openaiEmbeddingsClient = null;

function hasOpenAIKey() {
  return Boolean(String(process.env.OPENAI_API_KEY || "").trim());
}

function isLocalOllamaUrl(url = OLLAMA_URL) {
  const normalized = String(url || "").toLowerCase();
  return (
    normalized.includes("127.0.0.1") ||
    normalized.includes("localhost") ||
    normalized.includes("0.0.0.0")
  );
}

function isTrialEmbeddingContext(options = {}) {
  return Boolean(options.isTrial || options.trialMode);
}

function getEmbeddingProvider() {
  return String(process.env.EMBEDDING_PROVIDER || "ollama").trim().toLowerCase();
}

function isOpenAIProvider() {
  return getEmbeddingProvider() === "openai";
}

function shouldUseOpenAIEmbeddings(options = {}) {
  if (isOpenAIProvider()) {
    return true;
  }
  if (!hasOpenAIKey()) {
    return false;
  }
  if (isTrialEmbeddingContext(options)) {
    return true;
  }
  if (isRenderPlatform()) {
    return true;
  }
  if (process.env.NODE_ENV === "production" && isLocalOllamaUrl()) {
    return true;
  }
  if (String(process.env.EMBEDDING_FORCE_OPENAI || "").toLowerCase() === "true") {
    return true;
  }
  return false;
}

function getEffectiveEmbeddingProvider(options = {}) {
  if (shouldUseOpenAIEmbeddings(options)) {
    return hasOpenAIKey() ? "openai" : "openai-missing-key";
  }
  return "ollama";
}

function getOpenAIEmbedModel() {
  return (process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small").trim();
}

function getConfiguredEmbedDim() {
  return EMBED_DIM_DEFAULT;
}

function getOpenAIClient() {
  if (!openaiEmbeddingsClient) {
    const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY is not set. Add it to .env or set EMBEDDING_PROVIDER=ollama for local-only embeddings."
      );
    }
    const model = getOpenAIEmbedModel();
    const dimensions = getConfiguredEmbedDim();
    const clientConfig = {
      apiKey,
      model,
    };
    if (model.includes("text-embedding-3") && Number.isFinite(dimensions) && dimensions > 0) {
      clientConfig.dimensions = dimensions;
    }
    openaiEmbeddingsClient = new OpenAIEmbeddings(clientConfig);
    console.log(
      "[EMBED] OpenAI client ready | model:",
      model,
      clientConfig.dimensions ? `| dimensions=${clientConfig.dimensions}` : ""
    );
  }
  return openaiEmbeddingsClient;
}

function normalizeEmbeddingLength(vector, expectedDim) {
  if (!Array.isArray(vector)) {
    throw new Error("Invalid embedding: expected number array");
  }
  if (!expectedDim || vector.length === expectedDim) {
    return vector;
  }
  console.warn(
    `[EMBED] Vector length ${vector.length} != CHROMA_EMBED_DIM=${expectedDim} (using as-is)`
  );
  return vector;
}

async function embedTextOpenAI(text, expectedDim = EMBED_DIM_DEFAULT) {
  const input = String(text ?? "");
  console.log(
    `[EMBED] OpenAI → ${getOpenAIEmbedModel()} | chars=${input.length} | dim=${expectedDim}`
  );
  const vector = await getOpenAIClient().embedQuery(input);
  return normalizeEmbeddingLength(vector, expectedDim);
}

async function embedTextsOpenAI(texts, onProgress, expectedDim = EMBED_DIM_DEFAULT) {
  const inputs = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ""));
  if (inputs.length === 0) return [];

  console.log(
    `[EMBED] OpenAI batch → ${getOpenAIEmbedModel()} | count=${inputs.length} | dim=${expectedDim}`
  );
  const vectors = await getOpenAIClient().embedDocuments(inputs);
  if (onProgress) {
    onProgress({
      current: inputs.length,
      total: inputs.length,
      percent: 100,
    });
  }
  return vectors.map((vector) => normalizeEmbeddingLength(vector, expectedDim));
}

async function embedTextOllama(text, expectedDim, options = {}) {
  if (shouldUseOpenAIEmbeddings(options)) {
    return embedTextOpenAI(text, expectedDim);
  }

  const candidates = getEmbedModelCandidates();
  const prompt = String(text ?? "");
  let lastMismatch = null;
  let lastError = null;

  for (const model of candidates) {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Ollama ${response.status}: ${errorText.slice(0, 300)}`);
      }

      const data = await response.json();
      const embedding = data.embedding;
      if (!Array.isArray(embedding)) {
        throw new Error("Invalid Ollama response: missing embedding array");
      }

      if (expectedDim && embedding.length !== expectedDim) {
        lastMismatch = { model, got: embedding.length, want: expectedDim };
        console.warn(
          `[EMBED] Ollama ${model} → ${embedding.length} dims (want ${expectedDim})`
        );
        continue;
      }

      return embedding;
    } catch (e) {
      lastError = e;
      console.warn(`[EMBED] Ollama ${model} failed:`, e.message);
    }
  }

  if (hasOpenAIKey()) {
    console.warn(
      "[EMBED] Ollama unavailable — falling back to OpenAI:",
      lastError?.message || "all models failed"
    );
    return embedTextOpenAI(text, expectedDim);
  }

  const hint =
    lastMismatch != null
      ? ` Last: ${lastMismatch.model} gave ${lastMismatch.got}, need ${lastMismatch.want}.`
      : "";
  throw new Error(
    `No Ollama embedding model produced ${expectedDim || "expected"} dimensions.${hint}`
  );
}

/**
 * Single text embedding (query or one chunk).
 * @param {string} text
 * @param {{ isTrial?: boolean, trialMode?: boolean }} [options]
 */
async function embedText(text, options = {}) {
  const input = String(text ?? "");
  const expectedDim = getConfiguredEmbedDim();

  if (shouldUseOpenAIEmbeddings(options)) {
    if (!hasOpenAIKey()) {
      throw new Error(
        "Cloud embeddings require OPENAI_API_KEY (trial and Render deployments cannot use local Ollama)."
      );
    }
    return embedTextOpenAI(input, expectedDim);
  }

  console.log(`[EMBED] Ollama → ${OLLAMA_URL} | chars=${input.length}`);
  return embedTextOllama(input, expectedDim, options);
}

/**
 * Batch embeddings (upload indexing).
 * @param {string[]} texts
 * @param {Function} [onProgress]
 * @param {{ isTrial?: boolean, trialMode?: boolean }} [options]
 */
async function embedTexts(texts, onProgress, options = {}) {
  const inputs = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ""));
  if (inputs.length === 0) return [];

  const expectedDim = getConfiguredEmbedDim();

  if (shouldUseOpenAIEmbeddings(options)) {
    if (!hasOpenAIKey()) {
      throw new Error(
        "Cloud embeddings require OPENAI_API_KEY (trial and Render deployments cannot use local Ollama)."
      );
    }
    return embedTextsOpenAI(inputs, onProgress, expectedDim);
  }

  console.log(`[EMBED] Ollama sequential batch | count=${inputs.length}`);
  const vectors = [];
  const total = inputs.length;

  try {
    for (let i = 0; i < inputs.length; i++) {
      vectors.push(await embedTextOllama(inputs[i], expectedDim, options));
      if (onProgress) {
        const current = i + 1;
        onProgress({
          current,
          total,
          percent: Math.round((current / total) * 100),
        });
      }
    }
    return vectors;
  } catch (error) {
    if (!hasOpenAIKey()) {
      throw error;
    }
    console.warn("[EMBED] Ollama batch failed — falling back to OpenAI:", error.message);
    return embedTextsOpenAI(inputs, onProgress, expectedDim);
  }
}

module.exports = {
  getEmbeddingProvider,
  getEffectiveEmbeddingProvider,
  isOpenAIProvider,
  shouldUseOpenAIEmbeddings,
  hasOpenAIKey,
  getOpenAIEmbedModel,
  getConfiguredEmbedDim,
  getPrimaryEmbedModel,
  embedText,
  embedTexts,
};
