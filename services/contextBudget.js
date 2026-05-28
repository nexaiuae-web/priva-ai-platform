/**
 * Defensive context-window management for chat / RAG payloads.
 * Rich per-chunk excerpts by default; aggregate caps trigger dynamic scaling only when needed.
 */

require("dotenv").config();

const CHARS_PER_TOKEN = parseFloat(process.env.CHAT_CHARS_PER_TOKEN || "3.5");

const MAX_CONTEXT_CHARS = parseInt(process.env.CHAT_MAX_CONTEXT_CHARS || "300000", 10);
const MAX_CONTEXT_TOKENS = parseInt(process.env.CHAT_MAX_CONTEXT_TOKENS || "85000", 10);
const MAX_PAYLOAD_TOKENS = parseInt(process.env.CHAT_MAX_PAYLOAD_TOKENS || "120000", 10);
const MAX_COMPLETION_TOKENS = parseInt(
  process.env.CHAT_MAX_COMPLETION_TOKENS || "2048",
  10
);
const MAX_HISTORY_MESSAGES = parseInt(
  process.env.CHAT_HISTORY_MAX_MESSAGES || "6",
  10
);
const CHAT_MAX_CHUNKS = Math.max(
  1,
  parseInt(process.env.CHAT_MAX_CHUNKS || "12", 10)
);
const MAX_PARENT_EXCERPT_CHARS = parseInt(
  process.env.CHAT_PARENT_EXCERPT_CHARS || "2500",
  10
);
const MAX_CHILD_EXCERPT_CHARS = parseInt(
  process.env.CHAT_CHILD_EXCERPT_CHARS || "4000",
  10
);

/** Floors used only when aggregate budget forces proportional shrink */
const MIN_PARENT_SHRINK_CHARS = Math.max(
  400,
  Math.floor(MAX_PARENT_EXCERPT_CHARS * 0.2)
);
const MIN_CHILD_SHRINK_CHARS = Math.max(
  600,
  Math.floor(MAX_CHILD_EXCERPT_CHARS * 0.2)
);

const TRUNC_SUFFIX = "\n…[truncated]";

function estimateTokens(text) {
  const len = String(text ?? "").length;
  if (!len) return 0;
  return Math.ceil(len / CHARS_PER_TOKEN);
}

function truncateText(text, maxChars) {
  const s = String(text ?? "");
  if (maxChars <= 0 || !s) return "";
  if (s.length <= maxChars) return s;
  const keep = Math.max(0, maxChars - TRUNC_SUFFIX.length);
  return s.slice(0, keep) + TRUNC_SUFFIX;
}

/**
 * Apply per-chunk excerpt caps (used only when aggregate budget requires it).
 */
function capContextExcerpt(ctx, limits = {}) {
  const childMax = limits.childMax ?? MAX_CHILD_EXCERPT_CHARS;
  const parentMax = limits.parentMax ?? MAX_PARENT_EXCERPT_CHARS;

  const child = truncateText(ctx.child_text || ctx.content || "", childMax);
  let parent = String(ctx.parent_text || "");
  if (parent && parent === child) {
    parent = "";
  } else if (parent) {
    parent = truncateText(parent, parentMax);
  }
  return {
    ...ctx,
    child_text: child,
    parent_text: parent,
    content: child,
  };
}

function excerptCharSize(ctx) {
  const child = ctx.child_text || ctx.content || "";
  const parent = ctx.parent_text || "";
  let size = child.length;
  if (parent && parent !== child) {
    size += parent.length + 20;
  }
  return size + 120;
}

function excerptTokenSize(ctx) {
  return Math.ceil(excerptCharSize(ctx) / CHARS_PER_TOKEN);
}

function measureAggregate(contexts) {
  const chars = contexts.reduce((n, c) => n + excerptCharSize(c), 0);
  const tokens = contexts.reduce((n, c) => n + excerptTokenSize(c), 0);
  return { chars, tokens };
}

function isWithinBudget(contexts, maxChars, maxTokens) {
  const { chars, tokens } = measureAggregate(contexts);
  return chars <= maxChars && tokens <= maxTokens;
}

/**
 * Hard cap chunk count to CHAT_MAX_CHUNKS (never exceed env ceiling).
 */
function enforceMaxChunkCount(contexts) {
  if (!Array.isArray(contexts)) return [];
  return contexts.slice(0, CHAT_MAX_CHUNKS);
}

/**
 * Sliding window: keep only the last N user/assistant turns (excludes system).
 */
function normalizeHistoryMessages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = String(item.role || "").toLowerCase();
    if (role !== "user" && role !== "assistant") continue;
    const content = String(item.content ?? item.text ?? "").trim();
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
}

function truncateChatHistory(history, maxMessages = MAX_HISTORY_MESSAGES) {
  const valid = normalizeHistoryMessages(history);
  if (valid.length <= maxMessages) return valid;
  return valid.slice(-maxMessages);
}

/**
 * Preserve full retrieved excerpts until the aggregate hits the char/token ceiling.
 * Truncation is progressive: drop low-ranked chunks first, then scale excerpts proportionally.
 */
function budgetRetrievedContexts(contexts, options = {}) {
  const maxChars = options.maxChars ?? MAX_CONTEXT_CHARS;
  const maxTokens = options.maxTokens ?? MAX_CONTEXT_TOKENS;
  const maxChunks = Math.min(
    options.maxChunks ?? CHAT_MAX_CHUNKS,
    CHAT_MAX_CHUNKS
  );

  let working = enforceMaxChunkCount(contexts);
  const initialCount = working.length;
  let droppedChunks = 0;
  let shrinkPasses = 0;
  let appliedPerChunkCap = false;

  if (isWithinBudget(working, maxChars, maxTokens)) {
    const { chars, tokens } = measureAggregate(working);
    return {
      contexts: working,
      stats: {
        initialCount,
        finalCount: working.length,
        droppedChunks: 0,
        shrinkPasses: 0,
        appliedPerChunkCap: false,
        totalChars: chars,
        totalTokens: tokens,
        maxChars,
        maxTokens,
        maxChunks,
        parentExcerptLimit: MAX_PARENT_EXCERPT_CHARS,
        childExcerptLimit: MAX_CHILD_EXCERPT_CHARS,
      },
    };
  }

  while (working.length > 1 && !isWithinBudget(working, maxChars, maxTokens)) {
    working.pop();
    droppedChunks += 1;
  }

  while (
    !isWithinBudget(working, maxChars, maxTokens) &&
    working.length > 0 &&
    shrinkPasses < 12
  ) {
    shrinkPasses += 1;
    const { chars } = measureAggregate(working);
    const charRatio = Math.min(1, maxChars / Math.max(chars, 1));
    const tokenRatio = Math.min(
      1,
      maxTokens /
        Math.max(
          working.reduce((n, c) => n + excerptTokenSize(c), 0),
          1
        )
    );
    const ratio = Math.min(charRatio, tokenRatio, 0.92);

    working = working.map((ctx) =>
      capContextExcerpt(ctx, {
        childMax: Math.max(
          MIN_CHILD_SHRINK_CHARS,
          Math.floor(MAX_CHILD_EXCERPT_CHARS * ratio)
        ),
        parentMax: Math.max(
          MIN_PARENT_SHRINK_CHARS,
          Math.floor(MAX_PARENT_EXCERPT_CHARS * ratio)
        ),
      })
    );
    appliedPerChunkCap = true;
  }

  if (!isWithinBudget(working, maxChars, maxTokens)) {
    working = working.map((ctx) => capContextExcerpt(ctx));
    appliedPerChunkCap = true;
  }

  const { chars: totalChars, tokens: totalTokens } = measureAggregate(working);

  return {
    contexts: working,
    stats: {
      initialCount,
      finalCount: working.length,
      droppedChunks,
      shrinkPasses,
      appliedPerChunkCap,
      totalChars,
      totalTokens,
      maxChars,
      maxTokens,
      maxChunks,
      parentExcerptLimit: MAX_PARENT_EXCERPT_CHARS,
      childExcerptLimit: MAX_CHILD_EXCERPT_CHARS,
    },
  };
}

function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m?.content) + 4;
  }
  return total;
}

/**
 * Final safeguard before OpenAI: trim history, then shrink system context block.
 */
function fitMessagesToTokenBudget(messages, options = {}) {
  const maxPayload = options.maxPayloadTokens ?? MAX_PAYLOAD_TOKENS;
  const reservedCompletion =
    options.maxCompletionTokens ?? MAX_COMPLETION_TOKENS;
  const budget = maxPayload - reservedCompletion;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], stats: { trimmed: false } };
  }

  const fitted = messages.map((m) => ({
    role: m.role,
    content: String(m.content ?? ""),
  }));

  let inputTokens = estimateMessagesTokens(fitted);
  if (inputTokens <= budget) {
    return {
      messages: fitted,
      stats: {
        trimmed: false,
        inputTokens,
        budget,
        reservedCompletion,
      },
    };
  }

  const systemIdx = fitted.findIndex((m) => m.role === "system");
  const systemMsg = systemIdx >= 0 ? fitted[systemIdx] : null;
  const nonSystem = fitted.filter((_, i) => i !== systemIdx);

  let history = nonSystem.slice(0, -1);
  let lastUser = nonSystem[nonSystem.length - 1];

  while (
    history.length > 0 &&
    estimateMessagesTokens([
      ...(systemMsg ? [systemMsg] : []),
      ...history,
      ...(lastUser ? [lastUser] : []),
    ]) > budget
  ) {
    history = history.slice(2);
  }

  if (
    systemMsg &&
    estimateMessagesTokens([systemMsg, ...history, ...(lastUser ? [lastUser] : [])]) >
      budget
  ) {
    let systemContent = systemMsg.content;
    const marker = "=== RETRIEVED LOCAL CONTEXT";
    const ctxStart = systemContent.indexOf(marker);
    if (ctxStart >= 0) {
      const head = systemContent.slice(0, ctxStart);
      let ctxBlock = systemContent.slice(ctxStart);
      while (
        estimateTokens(head + ctxBlock) > budget * 0.85 &&
        ctxBlock.length > 2000
      ) {
        ctxBlock = truncateText(ctxBlock, Math.floor(ctxBlock.length * 0.85));
      }
      systemMsg.content = head + ctxBlock;
    } else {
      systemMsg.content = truncateText(
        systemContent,
        Math.floor(budget * CHARS_PER_TOKEN * 0.85)
      );
    }
  }

  const rebuilt = [];
  if (systemMsg) rebuilt.push(systemMsg);
  rebuilt.push(...history);
  if (lastUser) rebuilt.push(lastUser);

  inputTokens = estimateMessagesTokens(rebuilt);

  if (inputTokens > budget && lastUser) {
    lastUser = {
      ...lastUser,
      content: truncateText(
        lastUser.content,
        Math.floor(budget * CHARS_PER_TOKEN * 0.15)
      ),
    };
    rebuilt[rebuilt.length - 1] = lastUser;
    inputTokens = estimateMessagesTokens(rebuilt);
  }

  return {
    messages: rebuilt,
    stats: {
      trimmed: true,
      inputTokens,
      budget,
      reservedCompletion,
      historyKept: history.length,
    },
  };
}

function parseRequestHistory(body) {
  const raw =
    body?.history ?? body?.messages ?? body?.conversation ?? [];
  if (!Array.isArray(raw)) return [];
  return truncateChatHistory(raw);
}

module.exports = {
  CHARS_PER_TOKEN,
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_TOKENS,
  MAX_PAYLOAD_TOKENS,
  MAX_COMPLETION_TOKENS,
  MAX_HISTORY_MESSAGES,
  CHAT_MAX_CHUNKS,
  MAX_PARENT_EXCERPT_CHARS,
  MAX_CHILD_EXCERPT_CHARS,
  estimateTokens,
  truncateText,
  capContextExcerpt,
  enforceMaxChunkCount,
  normalizeHistoryMessages,
  truncateChatHistory,
  budgetRetrievedContexts,
  estimateMessagesTokens,
  fitMessagesToTokenBudget,
  parseRequestHistory,
};
