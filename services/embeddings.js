/**
 * Embedding providers — OpenAI (cloud, fast) or Ollama (local).
 * Chat stays on Ollama; indexing/retrieval use this module.
 */

require("dotenv").config();

const { OpenAIEmbeddings } = require("@langchain/openai");
const {
  EMBED_DIM_DEFAULT,
  getEmbedModelCandidates,
  getPrimaryEmbedModel,
} = require("./ollamaConfig");

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");

let openaiEmbeddingsClient = null;

function getEmbeddingProvider() {
  return String(process.env.EMBEDDING_PROVIDER || "ollama").trim().toLowerCase();
}

function isOpenAIProvider() {
  return getEmbeddingProvider() === "openai";
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
        "OPENAI_API_KEY is not set. Add it to .env for EMBEDDING_PROVIDER=openai."
      );
    }
    openaiEmbeddingsClient = new OpenAIEmbeddings({
      apiKey,
      model: getOpenAIEmbedModel(),
    });
    console.log("[EMBED] OpenAI client ready | model:", getOpenAIEmbedModel());
  }
  return openaiEmbeddingsClient;
}

async function embedTextOllama(text, expectedDim) {
  const candidates = getEmbedModelCandidates();
  const prompt = String(text ?? "");
  let lastMismatch = null;

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
      console.warn(`[EMBED] Ollama ${model} failed:`, e.message);
    }
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
 */
async function embedText(text) {
  const provider = getEmbeddingProvider();
  const input = String(text ?? "");

  if (isOpenAIProvider()) {
    console.log(`[EMBED] OpenAI → ${getOpenAIEmbedModel()} | chars=${input.length}`);
    const vector = await getOpenAIClient().embedQuery(input);
    if (vector.length !== EMBED_DIM_DEFAULT) {
      console.warn(
        `[EMBED] OpenAI returned ${vector.length} dims (CHROMA_EMBED_DIM=${EMBED_DIM_DEFAULT})`
      );
    }
    return vector;
  }

  console.log(`[EMBED] Ollama → ${OLLAMA_URL} | chars=${input.length}`);
  return embedTextOllama(input, EMBED_DIM_DEFAULT);
}

/**
 * Batch embeddings (upload indexing) — one OpenAI API call per batch when possible.
 */
async function embedTexts(texts, onProgress) {
  const inputs = (Array.isArray(texts) ? texts : []).map((t) => String(t ?? ""));
  if (inputs.length === 0) return [];

  if (isOpenAIProvider()) {
    console.log(
      `[EMBED] OpenAI batch → ${getOpenAIEmbedModel()} | count=${inputs.length}`
    );
    const vectors = await getOpenAIClient().embedDocuments(inputs);
    if (onProgress) {
      onProgress({
        current: inputs.length,
        total: inputs.length,
        percent: 100,
      });
    }
    return vectors;
  }

  console.log(`[EMBED] Ollama sequential batch | count=${inputs.length}`);
  const vectors = [];
  const total = inputs.length;
  for (let i = 0; i < inputs.length; i++) {
    vectors.push(await embedTextOllama(inputs[i], EMBED_DIM_DEFAULT));
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
}

module.exports = {
  getEmbeddingProvider,
  isOpenAIProvider,
  getOpenAIEmbedModel,
  getConfiguredEmbedDim,
  getPrimaryEmbedModel,
  embedText,
  embedTexts,
};
