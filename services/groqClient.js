/**
 * Groq chat provider — private, zero-cost OpenAI-compatible fallback.
 *
 * Uses the groq-sdk with `llama-3.3-70b-versatile`. Groq's API is
 * OpenAI-compatible, so the exact same system/user/assistant message array
 * (including the Chain-of-Thought + OCR/table-tolerant system prompt and the
 * RAG Markdown context) is forwarded verbatim with no role conversion.
 */

const Groq = require("groq-sdk");
const {
  getGroqChatModel,
  getGroqApiKey,
} = require("./chatConfig");

let _client = null;

function getGroqClient() {
  if (_client) return _client;
  const apiKey = getGroqApiKey();
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not configured for Groq fallback.");
  }
  _client = new Groq({ apiKey });
  return _client;
}

/**
 * Resolve the model to use, defaulting to llama-3.3-70b-versatile.
 */
function resolveGroqModel(preferred) {
  const configured = String(preferred || getGroqChatModel() || "").trim();
  return configured || "llama-3.3-70b-versatile";
}

/**
 * Stream a Groq chat completion using OpenAI-compatible message roles.
 *
 * @param {{ messages: Array<{role:string,content:string}> }} opts
 * @param {(delta: string) => void} onDelta
 * @returns {Promise<{ provider: string, model: string }>}
 */
async function streamGroqChatCompletion({ messages }, onDelta) {
  const client = getGroqClient();
  const model = resolveGroqModel();

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Groq fallback: no messages to send.");
  }

  console.log(
    "[LLM] 🟢 Groq fallback stream | model:",
    model,
    "| messages:",
    messages.length
  );

  const stream = await client.chat.completions.create({
    model,
    messages,
    stream: true,
    temperature: 0.1,
    max_tokens: 2048,
  });

  for await (const chunk of stream) {
    const delta = chunk?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      onDelta(delta);
    }
  }

  return { provider: "groq", model };
}

module.exports = {
  streamGroqChatCompletion,
  getGroqClient,
  resolveGroqModel,
};
