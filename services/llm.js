// services/llm.js
// ============================================
// LLM Streaming — OpenAI (gpt-4o-mini) or Ollama fallback
// ============================================

require("dotenv").config();

const { getChatModel } = require("./ollamaConfig");
const {
  getChatProvider,
  getOpenAIChatModel,
  getOpenAIChatApiKey,
  isOpenAIChatEnabled,
} = require("./chatConfig");
const {
  fitMessagesToTokenBudget,
  estimateMessagesTokens,
  MAX_COMPLETION_TOKENS,
} = require("./contextBudget");

const OLLAMA_URL = (process.env.OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const OLLAMA_MODEL = getChatModel();

/** Undici default connect timeout is 10s — too low for large Arabic OCR payloads. */
const OPENAI_CONNECT_TIMEOUT_MS = parseInt(
  process.env.OPENAI_CONNECT_TIMEOUT_MS || "30000",
  10
);
const OPENAI_REQUEST_TIMEOUT_MS = parseInt(
  process.env.OPENAI_REQUEST_TIMEOUT_MS || "120000",
  10
);

let openAiUndiciAgent = null;

function getOpenAiFetchDispatcher() {
  if (openAiUndiciAgent) return openAiUndiciAgent;
  try {
    const { Agent } = require("undici");
    openAiUndiciAgent = new Agent({
      connectTimeout: OPENAI_CONNECT_TIMEOUT_MS,
      headersTimeout: OPENAI_REQUEST_TIMEOUT_MS,
      bodyTimeout: OPENAI_REQUEST_TIMEOUT_MS,
    });
    console.log("[LLM] OpenAI fetch dispatcher", {
      connectTimeoutMs: OPENAI_CONNECT_TIMEOUT_MS,
      requestTimeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
    });
    return openAiUndiciAgent;
  } catch (err) {
    console.warn("[LLM] undici Agent unavailable, using default fetch:", err.message);
    return undefined;
  }
}

/**
 * Deflate OCR-heavy message bodies: strip control chars, collapse whitespace/newlines.
 */
function sanitizeLlmMessageContent(content) {
  let text = String(content ?? "");
  if (!text) return "";

  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFEFF]/g, "");
  text = text.replace(/[ \t\u00A0]{2,}/g, " ");
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/^[ \t]+/g, ""))
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function prepareOpenAiMessages(messages) {
  const prepared = (messages || []).map((m) => ({
    role: m.role,
    content: sanitizeLlmMessageContent(m.content),
  }));

  const beforeChars = (messages || []).reduce(
    (sum, m) => sum + String(m.content ?? "").length,
    0
  );
  const afterChars = prepared.reduce((sum, m) => sum + m.content.length, 0);
  if (beforeChars > 0 && afterChars < beforeChars) {
    console.log("[LLM] OpenAI message content sanitized", {
      beforeChars,
      afterChars,
      savedChars: beforeChars - afterChars,
    });
  }

  return prepared;
}

function isInvalidExternalKey(apiKey) {
  if (apiKey == null || apiKey === "null" || apiKey === "undefined") return true;
  const s = String(apiKey).trim();
  if (!s) return true;
  const lower = s.toLowerCase();
  return lower.includes("placeholder") || lower.includes("sk-place");
}

/**
 * Streaming chat — OpenAI when CHAT_PROVIDER=openai, else Ollama.
 * @param {{ messages: Array<{role:string,content:string}>, apiKey?: string|null, signal?: AbortSignal }} opts
 * @param {(delta: string) => void} onDelta
 * @returns {Promise<{ provider: string, model: string }>}
 */
function resolveOpenAIApiKey(apiKey) {
  if (!isInvalidExternalKey(apiKey)) {
    return String(apiKey).trim();
  }
  return getOpenAIChatApiKey();
}

async function streamChatCompletion({ messages, apiKey = null, signal }, onDelta) {
  const provider = getChatProvider();

  if (provider === "openai") {
    const resolvedKey = resolveOpenAIApiKey(apiKey);
    if (!resolvedKey) {
      throw new Error(
        "OpenAI API key is not configured for this company. Set openai_api_key on the company or OPENAI_API_KEY in .env."
      );
    }
    console.log("[LLM] ☁️ OpenAI chat stream | model:", getOpenAIChatModel());
    return streamOpenAI({ messages, signal, apiKey: resolvedKey }, onDelta);
  }

  console.log("[LLM] 🏠 Local Ollama chat | model:", OLLAMA_MODEL);
  return streamOllama({ messages, signal }, onDelta);
}

async function streamOpenAI({ messages, signal, apiKey }, onDelta) {
  try {
    const resolvedKey = resolveOpenAIApiKey(apiKey);
    const model = getOpenAIChatModel();
    const url = "https://api.openai.com/v1/chat/completions";

    const { messages: safeMessages, stats: fitStats } =
      fitMessagesToTokenBudget(messages);
    if (fitStats.trimmed) {
      console.log("[LLM] OpenAI payload trimmed:", JSON.stringify(fitStats));
    }
    console.log(
      "[LLM] Estimated input tokens:",
      estimateMessagesTokens(safeMessages),
      "| completion reserve:",
      MAX_COMPLETION_TOKENS
    );

    const preparedMessages = prepareOpenAiMessages(safeMessages);

    const timeoutSignal = AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS);
    const combinedSignal =
      signal != null ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    const dispatcher = getOpenAiFetchDispatcher();
    const fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolvedKey}`,
      },
      body: JSON.stringify({
        model,
        messages: preparedMessages,
        stream: true,
        temperature: 0.1,
        max_tokens: MAX_COMPLETION_TOKENS,
      }),
      signal: combinedSignal,
    };
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `OpenAI stream HTTP ${response.status}: ${errorText.slice(0, 500)}`
      );
    }

    if (!response.body) {
      throw new Error("OpenAI stream: response body is empty.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            onDelta(delta);
          }
        } catch {
          /* ignore partial SSE lines */
        }
      }
    }

    return {
      provider: "openai",
      model,
    };
  } catch (error) {
    console.error("[LLM STREAM ERROR]: Failed to fetch from OpenAI", error);
    const streamError = new Error(
      "Failed to communicate with LLM provider. Please check your network connection or reduce payload size."
    );
    streamError.code = "LLM_STREAM_ERROR";
    streamError.cause = error;
    throw streamError;
  }
}

async function streamOllama({ messages, signal }, onDelta) {
  const url = `${OLLAMA_URL}/api/chat`;

  console.log("[LLM] Ollama URL:", url);
  console.log("[LLM] Ollama Model:", OLLAMA_MODEL);

  const timeoutSignal = AbortSignal.timeout(600000);
  const combinedSignal =
    signal != null ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Connection: "keep-alive",
    },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
      keep_alive: -1,
      options: {
        temperature: 0.1,
        num_ctx: 2048,
        num_predict: 512,
        top_p: 0.9,
        num_thread: 8,
      },
    }),
    signal: combinedSignal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Ollama stream HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }

  if (!response.body) {
    throw new Error("Ollama stream: response body is empty.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const data = JSON.parse(trimmed);
        const delta = data.message?.content;
        if (typeof delta === "string" && delta.length > 0) {
          onDelta(delta);
        }
      } catch {
        /* ignore malformed NDJSON */
      }
    }
  }

  const tail = buffer.trim();
  if (tail) {
    try {
      const data = JSON.parse(tail);
      const delta = data.message?.content;
      if (typeof delta === "string" && delta.length > 0) {
        onDelta(delta);
      }
    } catch {
      /* ignore */
    }
  }

  return {
    provider: "ollama-local",
    model: OLLAMA_MODEL,
  };
}

/**
 * Non-streaming chat (legacy).
 */
async function chatComplete({ messages, apiKey = null }) {
  if (isOpenAIChatEnabled()) {
    const apiKeyEnv = getOpenAIChatApiKey();
    const model = getOpenAIChatModel();
    const preparedMessages = prepareOpenAiMessages(messages);
    const dispatcher = getOpenAiFetchDispatcher();
    const fetchOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKeyEnv}`,
      },
      body: JSON.stringify({
        model,
        messages: preparedMessages,
        stream: false,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
    };
    if (dispatcher) {
      fetchOptions.dispatcher = dispatcher;
    }
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      fetchOptions
    );
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    }
    const json = await response.json();
    const text = json.choices?.[0]?.message?.content || "";
    if (!text) throw new Error("OpenAI empty response.");
    return { text, provider: "openai", raw: json };
  }

  const url = `${OLLAMA_URL}/api/chat`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      keep_alive: -1,
      options: { temperature: 0.1, num_ctx: 2048, num_predict: 512 },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Ollama HTTP ${response.status}: ${errorText.slice(0, 500)}`);
  }

  const json = await response.json();
  const text = json.message?.content || "";
  if (!text) {
    throw new Error(`Ollama empty response: ${JSON.stringify(json).slice(0, 300)}`);
  }

  return { text, provider: "ollama-local", raw: json };
}

module.exports = {
  streamChatCompletion,
  chatComplete,
  streamOpenAI,
  streamOllama,
  OLLAMA_URL,
  OLLAMA_MODEL,
  getChatProvider,
  isOpenAIChatEnabled,
};
