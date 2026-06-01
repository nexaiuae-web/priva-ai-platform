const crypto = require("crypto");
const ChatMessage = require("../models/ChatMessage");

function newChatMessageId() {
  return `chat_${crypto.randomBytes(8).toString("hex")}`;
}

function normalizeScopeUserId(user_id) {
  const uid = String(user_id || "").trim();
  return uid || null;
}

function buildChatHistoryQuery(company_id, { user_id = null } = {}) {
  const companyId = String(company_id || "").trim();
  if (!companyId) {
    throw new Error("company_id is required for chat history queries.");
  }

  const query = { company_id: companyId };
  const uid = normalizeScopeUserId(user_id);
  if (uid) {
    query.user_id = uid;
  }
  return query;
}

async function listChatMessagesForCompany(company_id, { user_id = null, limit = 80 } = {}) {
  const query = buildChatHistoryQuery(company_id, { user_id });
  const cap = Math.min(Math.max(1, Number(limit) || 80), 200);

  const rows = await ChatMessage.find(query)
    .sort({ created_at: 1 })
    .limit(cap)
    .lean();

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: String(row.content || ""),
    sources: Array.isArray(row.sources) ? row.sources : [],
    created_at: row.created_at,
  }));
}

async function appendChatMessage({
  company_id,
  user_id = null,
  role,
  content,
  sources = [],
}) {
  const companyId = String(company_id || "").trim();
  if (!companyId) {
    throw new Error("company_id is required to save chat messages.");
  }

  const normalizedRole = String(role || "").trim();
  if (normalizedRole !== "user" && normalizedRole !== "assistant") {
    throw new Error("Chat message role must be user or assistant.");
  }

  const record = {
    id: newChatMessageId(),
    company_id: companyId,
    user_id: normalizeScopeUserId(user_id),
    role: normalizedRole,
    content: String(content || ""),
    sources: Array.isArray(sources) ? sources : [],
    created_at: new Date(),
  };

  await ChatMessage.create(record);
  return record;
}

async function appendChatExchange({
  company_id,
  user_id = null,
  user_message,
  assistant_message,
  sources = [],
}) {
  const userRecord = await appendChatMessage({
    company_id,
    user_id,
    role: "user",
    content: user_message,
  });

  const assistantRecord = await appendChatMessage({
    company_id,
    user_id,
    role: "assistant",
    content: assistant_message,
    sources,
  });

  return { user: userRecord, assistant: assistantRecord };
}

async function clearChatHistoryForCompany(company_id, { user_id = null } = {}) {
  const query = buildChatHistoryQuery(company_id, { user_id });
  const result = await ChatMessage.deleteMany(query);
  return result.deletedCount || 0;
}

function parseSanitizedRequestHistory(body, resolvedCompanyId) {
  const { parseRequestHistory } = require("./contextBudget");
  const requestCompanyId = String(
    body?.company_id ?? body?.companyId ?? body?.tenant_id ?? ""
  ).trim();

  if (requestCompanyId && requestCompanyId !== String(resolvedCompanyId || "").trim()) {
    console.warn("[CHAT] Discarding client history — company_id mismatch", {
      requestCompanyId,
      resolvedCompanyId,
    });
    return [];
  }

  return parseRequestHistory(body);
}

module.exports = {
  listChatMessagesForCompany,
  appendChatMessage,
  appendChatExchange,
  clearChatHistoryForCompany,
  parseSanitizedRequestHistory,
};
