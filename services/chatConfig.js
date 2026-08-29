/**
 * Chat LLM provider — OpenAI cloud (default) or Ollama local fallback.
 * Embeddings / Chroma stay on EMBEDDING_PROVIDER (local).
 */

require("dotenv").config();

function getChatProvider() {
  return String(process.env.CHAT_PROVIDER || "openai").trim().toLowerCase();
}

function getOpenAIChatModel() {
  return (process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini").trim();
}

function getOpenAIChatApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function isOpenAIChatEnabled() {
  return getChatProvider() === "openai" && getOpenAIChatApiKey().length > 0;
}

function getGroqApiKey() {
  return String(process.env.GROQ_API_KEY || "").trim();
}

function getGroqChatModel() {
  return (process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile").trim();
}

function isGroqConfigured() {
  return getGroqApiKey().length > 0;
}

module.exports = {
  getChatProvider,
  getOpenAIChatModel,
  getOpenAIChatApiKey,
  isOpenAIChatEnabled,
  getGroqApiKey,
  getGroqChatModel,
  isGroqConfigured,
};
