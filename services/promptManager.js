/**
 * Grounding-enforced RAG prompts — zero hallucination, context-only answers.
 */

const CRITICAL_LANGUAGE_RULE = `CRITICAL LANGUAGE RULE: You MUST always draft the official letter, summary, and full response using the EXACT SAME language that the user asked their query in (e.g., if the user asks in English, respond in English; if in French, respond in French; if in Arabic, respond in Arabic). Do not mix languages unless the user explicitly requests bilingual output.`;

const RAG_OCR_FLEXIBILITY_INSTRUCTION = `CRITICAL MULTILINGUAL OCR FLEXIBILITY RULE:
1. The provided context excerpts are extracted via OCR and speech-to-text tools, which means they may contain typographical errors, spelling mistakes, character omissions, or noisy artifacts in ANY language (e.g., Arabic, English, Spanish, French, etc.).
2. You must apply strict semantic matching rather than exact keyword or string matching. If a word or entity is slightly misspelled, deformed, or contains OCR noise but the semantic meaning and context point clearly to the entity (e.g., 'البحلوله' for 'البطولة', 'coorporation' for 'corporation', 'enviroment' for 'environment'), you MUST evaluate it as a valid match.
3. Under no circumstances should you reject a context or output an "Information not available" refusal solely due to spelling variations, translation artifacts, or noisy OCR text, provided that related core entities, places, names, or meanings are present in the chunks.
4. Synthesize your answer intelligently based on the closest logical meaning of the retrieved text.`;

const PRIVA_CORE_INSTRUCTION = `You are PRIVA AI, a secure corporate assistant. Your task is to summarize documents or draft formal letters/emails based STRICTLY and ONLY on the provided document contexts.
- NEVER assume, hallucinate, or extrapolate facts outside the retrieved context.
- ${CRITICAL_LANGUAGE_RULE}
- If the user asks for an official letter to a government entity based on the files, draft it professionally using 100% factual data from the retrieved texts.
- Use only facts that appear in the retrieved excerpts (including partial OCR lines). Prefer quoting or closely paraphrasing the source text.
- Only state that information is unavailable (e.g., Arabic: 'عذراً، هذه المعلومة غير متوفرة في الملفات المرفوعة'; English: "Sorry, this information is not available in the uploaded files.") when the excerpts are empty OR contain zero meaningful overlap with the user's question — not because of minor OCR noise or wording differences.
- Write the answer body only. Do NOT append a "## Sources" / "## المصادر" section, file lists, page numbers, or chunk tags — the application shows source filenames separately.
- Do not include inline markers like [Source 1] unless the user explicitly asks for in-text citations.`;

const CITATION_RULES = PRIVA_CORE_INSTRUCTION;

/** Lean grounding for global synthesis — avoids conflicting with letter/summary tasks. */
const PRIVA_GLOBAL_SUMMARY_CORE = `You are PRIVA AI, a secure corporate assistant.
- Base every statement ONLY on the provided excerpts. Do not invent names, dates, figures, diagnoses, or events.
- ${CRITICAL_LANGUAGE_RULE}
- Write the answer body only. Do NOT append "## Sources" / "## المصادر", file lists, or inline [Source N] tags.`;

const FOLDER_STRICT_INSTRUCTION = `FOLDER CHAT — STRICT FOLDER CONTEXT

The user is chatting from inside a specific folder workspace. The excerpts below were retrieved from files in that folder (or the closest semantic match available).

RULES:
- Answer directly from these excerpts. Treat OCR typos and scanning artifacts as normal — infer the intended words from context.
- If entity names, places, or dates related to the question appear anywhere in the excerpts (even partially), answer confidently from that evidence.
- Do NOT refuse with an "information not available" message when related text is present but imperfectly spelled.`;

const FOLDER_GLOBAL_FALLBACK_INSTRUCTION = `FOLDER CHAT — COMPANY-WIDE CONTEXT FALLBACK

The user is chatting from inside a specific folder workspace, but the retrieved excerpts below were found across their entire company knowledge base (root files and other folders), because the answer was not available only inside the active folder.

RULES:
- You MUST answer using the provided excerpts, including files stored outside the active folder, when they contain the answer.
- Do NOT say the information is unavailable if the excerpts clearly contain related entities, places, dates, or partial OCR lines that answer the question.
- You may briefly note that the file lives outside the current folder when helpful, but still answer fully from the excerpts.
- Apply the same OCR flexibility: minor artifacts must not block a substantive answer.`;

const GLOBAL_SUMMARY_INSTRUCTION = `GLOBAL SYNTHESIS & OFFICIAL DRAFTING MODE

You are PRIVA AI. The context provided contains the raw contents of the user's uploaded files (e.g., student health records, technical automations, contracts, or operational logs).

The user is asking for a global summary or a professional/official letter based on these documents.

YOUR TASK:
- MUST synthesize, extract, and summarize the key facts, findings, observations, and logs present within the provided context.
- Format the extracted facts into the structure the user requested (formal administrative letter, corporate executive summary, technical report, or consolidated briefing) using a high-level professional tone in the user's query language.
- ${CRITICAL_LANGUAGE_RULE}
- Treat formatting and section headings as presentation layers — the substance underneath must still come from the excerpts.

CRITICAL INTERPRETATION RULES:
- Do NOT search inside the files for phrases like "خطاب رسمي", "ملخص", "ملفات طبية وقانونية", or "draft a letter". Those describe the USER'S request, not content that must appear verbatim in the source text.
- The file contents ARE the raw substance (health data, system behavior, legal clauses, etc.). Your job is to transform that substance into the requested output layout.
- Filenames (e.g., Student-Health-File.pdf) identify document type — use them to understand what each excerpt represents, not as proof that a label must appear inside the text.

FALLBACK POLICY (STRICT BUT NARROW):
- You are ONLY allowed to use the unavailable-information message in the user's query language if the injected context chunks are completely empty, unreadable, or corrupt.
- If there is readable text about health, legal matters, or technical systems — summarize and draft from what is there immediately. Never refuse because the user asked for a "letter" or "summary" while readable facts are present.
- You may note a specific missing detail (e.g., a date or signatory name) without rejecting the entire task.`;

function detectQueryLanguageLabel(question) {
  const q = String(question || "").trim();
  if (!q) return "English";
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(q)) return "Arabic";
  if (
    /[àâäéèêëïîôùûüçœæÀÂÄÉÈÊËÏÎÔÙÛÜÇŒÆ]/.test(q) ||
    /\b(le|la|les|des|une|un|pour|avec|résumé|resume|merci|bonjour)\b/i.test(q)
  ) {
    return "French";
  }
  return "English";
}

function formatPageLabel(meta, fallbackIndex) {
  if (meta.page != null && String(meta.page).trim()) {
    return String(meta.page);
  }
  if (meta.parent_sequence != null || meta.child_sequence != null) {
    const p =
      meta.parent_sequence != null ? Number(meta.parent_sequence) + 1 : 1;
    const c =
      meta.child_sequence != null ? Number(meta.child_sequence) + 1 : 1;
    return `section ${p}, chunk ${c}`;
  }
  return `chunk ${fallbackIndex + 1}`;
}

function buildRagSystemPrompt(contextChunks, userQuery, options = {}) {
  const { isGlobalSummary = false, retrievalMode = null } = options;
  const contextText = contextChunks
    .map((chunk, idx) => {
      const meta = chunk.metadata || {};
      const content = chunk.child_text || chunk.content || chunk.document || "";
      const parent = chunk.parent_text || "";
      const filename =
        chunk.filename || meta.source || meta.filename || "unknown";
      const page =
        chunk.page_label || formatPageLabel(meta, idx);
      const tag = chunk.citationTag || `[Source ${idx + 1}]`;

      const includeParent =
        parent && parent !== content && parent.length > 0;
      return (
        `${tag} | file: ${filename} | page/section: ${page}\n` +
        `${content}` +
        (includeParent ? `\n\n[parent context]\n${parent}` : "")
      );
    })
    .join("\n\n---\n\n");

  const uniqueFiles = [
    ...new Set(
      contextChunks
        .map(
          (c) =>
            c.filename ||
            c.metadata?.filename ||
            c.metadata?.source ||
            null
        )
        .filter(Boolean)
    ),
  ];

  const coreInstruction = isGlobalSummary
    ? PRIVA_GLOBAL_SUMMARY_CORE
    : PRIVA_CORE_INSTRUCTION;

  // Mode-specific augmentations (folder_strict, folder_global_fallback, global summary).
  const modeBlocks = [
    isGlobalSummary ? GLOBAL_SUMMARY_INSTRUCTION : "",
    retrievalMode === "folder_strict" ? FOLDER_STRICT_INSTRUCTION : "",
    retrievalMode === "folder_global_fallback" ? FOLDER_GLOBAL_FALLBACK_INSTRUCTION : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const contextIntro = isGlobalSummary
    ? `The following ${contextChunks.length} excerpt(s) are the raw substance from ${uniqueFiles.length} uploaded file(s): ${uniqueFiles.join(", ") || "workspace documents"}.
Synthesize across ALL excerpts. Each file may cover a different domain (health, legal, technical) — combine them into one coherent response as the user requested.`
    : `The excerpts below are from ${uniqueFiles.length} active workspace file(s): ${uniqueFiles.join(", ") || "uploaded documents"}.
Use every relevant excerpt; do not ignore a file because the user's question uses category labels that do not appear verbatim inside the text.`;

  const queryLanguage = detectQueryLanguageLabel(userQuery);

  // Pipeline (English rule text; answer language follows the user query):
  // Core instructions -> multilingual OCR flexibility -> mode blocks -> context -> user question.
  const systemInstruction = [
    coreInstruction,
    RAG_OCR_FLEXIBILITY_INSTRUCTION,
    modeBlocks,
    contextIntro,
    `USER QUERY LANGUAGE: ${queryLanguage}`,
    CRITICAL_LANGUAGE_RULE,
    `=== RETRIEVED LOCAL CONTEXT (${contextChunks.length} chunks) ===`,
    contextText,
    `=== USER QUESTION ===`,
    userQuery,
  ]
    .filter((section) => section != null && String(section).trim().length > 0)
    .join("\n\n");

  return {
    role: "system",
    content: systemInstruction,
  };
}

function buildSystemPrompt() {
  return PRIVA_CORE_INSTRUCTION;
}

function buildUserPrompt({ question, contexts }) {
  const blocks = contexts.map((ctx, idx) => {
    const tag = ctx.citationTag || `[Source ${idx + 1}]`;
    const fname = ctx.filename || "unknown";
    const page = ctx.page_label || `chunk ${idx + 1}`;
    return (
      `${tag} | file: ${fname} | page/section: ${page}\n` +
      `--- excerpt ---\n${ctx.child_text}\n`
    );
  });

  return [
    "Answer using ONLY the retrieved context in the system message. Do not invent facts.",
    "",
    ...blocks,
    "",
    `User question:\n${question}`,
  ].join("\n");
}

function buildMessagesForChat({
  question,
  contexts,
  history = [],
  isGlobalSummary = false,
  retrievalMode = null,
}) {
  const { truncateChatHistory } = require("./contextBudget");
  const trimmedHistory = truncateChatHistory(history);

  const contextChunks = contexts.map((ctx, idx) => ({
    content: ctx.child_text,
    child_text: ctx.child_text,
    parent_text: ctx.parent_text,
    filename: ctx.filename,
    page_label: ctx.page_label,
    citationTag: ctx.citationTag || `[Source ${idx + 1}]`,
    metadata: {
      source: ctx.filename,
      filename: ctx.filename,
      page: ctx.page_label,
      parent_sequence: ctx.parent_sequence,
      child_sequence: ctx.child_sequence,
      chunkIndex: idx + 1,
    },
  }));

  const systemMsg = buildRagSystemPrompt(contextChunks, question, {
    isGlobalSummary,
    retrievalMode,
  });

  return [
    systemMsg,
    ...trimmedHistory,
    {
      role: "user",
      content: question,
    },
  ];
}

module.exports = {
  buildRagSystemPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  buildMessagesForChat,
  formatPageLabel,
  CITATION_RULES,
  PRIVA_CORE_INSTRUCTION,
  PRIVA_GLOBAL_SUMMARY_CORE,
  GLOBAL_SUMMARY_INSTRUCTION,
  RAG_OCR_FLEXIBILITY_INSTRUCTION,
  FOLDER_STRICT_INSTRUCTION,
  FOLDER_GLOBAL_FALLBACK_INSTRUCTION,
  CRITICAL_LANGUAGE_RULE,
  detectQueryLanguageLabel,
};
