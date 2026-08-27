/**
 * Structured Markdown formatting for OCR / PDF-extracted document text.
 *
 * Applies on top of OCRCleaner normalisation to:
 *  1. Collapse messy line noise into coherent paragraphs and list items.
 *  2. Turn tab-/pipe-/cell-delimited runs into real Markdown tables.
 *  3. Detect section headings (Arabic numerals, "المادة", "أولاً", etc.)
 *     and render them as Markdown headings / list items.
 */

const { countTokens } = require("./tokenChunker");

/** A run of lines that look like a table (pipe or consistent tab separators). */
function isTableRow(line) {
  const s = String(line || "");
  if (!s.trim()) return false;
  const pipeCount = (s.match(/\|/g) || []).length;
  if (pipeCount >= 2) return true;
  if (s.split("\t").length >= 3) return true;
  return false;
}

/** Candidates that look like a section heading. */
const HEADING_PATTERNS = [
  /^\s*\d{1,3}\s*[.)\-–—:]/,
  /^\s*المادة\s*[\u0600-\u06FF\d]/,
  /^\s*البند\s*[\u0600-\u06FF\d]/,
  /^\s*الطرف\s*[\u0600-\u06FF\d]/,
  /^\s*أولاً|^\s*أولا|^\s*ثانياً|^\s*ثانيا|^\s*ثالثاً|^\s*ثالثا|^\s*رابعاً|^\s*خامساً|^\s*سادساً/,
  /^\s*مقدمة|^\s*المقدمة|^\s*الخاتمة|^\s*الخلاصة|^\s*ملحق/,
  /^\s*(?:Appendix|Section)\s+\d+\s*[:.]?/i,
];
const HEADING_REGEX = new RegExp(HEADING_PATTERNS.map((r) => r.source).join("|"));

/**
 * Convert a block of raw table-like rows into a Markdown table.
 * Rows are split by pipe or tab; columns are padded; a header separator is
 * emitted after the first non-empty row.
 */
function rowsToMarkdownTable(rows) {
  const cells = rows
    .filter((r) => String(r || "").trim())
    .map((r) =>
      String(r)
        .split(/\s*\|\s*|\t+/)
        .map((c) => c.trim())
        .filter((c, idx, arr) => !(c === "" && arr.length === 1))
    );

  if (cells.length === 0) return "";

  const width = Math.max(...cells.map((c) => c.length));
  if (width < 2) return rows.join("\n");

  const normalize = (row) => {
    const out = Array.from({ length: width }, (_, i) => row[i] || "");
    return out;
  };

  const lines = [];
  lines.push("| " + normalize(cells[0]).join(" | ") + " |");
  lines.push("| " + normalize(cells[0]).map(() => "---").join(" | ") + " |");

  for (let i = 1; i < cells.length; i++) {
    lines.push("| " + normalize(cells[i]).join(" | ") + " |");
  }

  return lines.join("\n");
}

/**
 * Detect table-like runs in a block of consecutive lines and expand them into
 * Markdown tables. Non-table lines are left untouched.
 */
function expandTables(block) {
  const lines = String(block || "").split("\n");
  const out = [];
  let tableBuffer = [];

  const flushTable = () => {
    if (tableBuffer.length) {
      out.push(rowsToMarkdownTable(tableBuffer));
      tableBuffer = [];
    }
  };

  for (const line of lines) {
    if (isTableRow(line)) {
      tableBuffer.push(line);
    } else {
      flushTable();
      if (String(line).trim()) out.push(line);
    }
  }
  flushTable();

  return out.join("\n");
}

/**
 * Decide whether an isolated line should become a Markdown heading.
 * Short-ish lines that end with a sentence terminator (or are pure numbers)
 * are treated as body text; others are promoted to headings.
 */
function maybeHeading(line, nextLine) {
  if (!HEADING_REGEX.test(line)) return null;
  const text = String(line).trim();
  const chars = text.replace(/\d/g, "").length;
  if (chars < 4) return null;
  if (nextLine && /[.]$/.test(text) && String(nextLine).trim() === "") {
    return text;
  }
  if (!/[.!؟۔]$/.test(text)) return text;
  return null;
}

/**
 * Format a cleaned document string into structured Markdown.
 *
 * @param {string} input Raw (already normalised) document text.
 * @returns {string} Structured Markdown with paragraphs, headings, and tables.
 */
function formatAsMarkdown(input) {
  const raw = String(input || "");
  const normalized = raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!normalized) return "";

  const lines = normalized.split("\n");
  const out = [];
  let listDepth = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (out.length > 0 && String(out[out.length - 1]).trim() !== "") {
        out.push("");
      }
      continue;
    }

    const isBullet = /^\s*[-*+•]\s+/.test(trimmed);
    const isNumbered = /^\s*\d{1,2}\s*[.)]\s+/.test(trimmed);
    const heading = maybeHeading(trimmed, lines[i + 1]);

    if (heading) {
      if (out.length > 0 && String(out[out.length - 1]).trim() !== "") {
        out.push("");
      }
      out.push(`## ${heading}`);
      listDepth = -1;
      continue;
    }

    if (isBullet || isNumbered) {
      const sep = isBullet ? /^(\s*)[-*+•]\s+/ : /^(\s*)\d{1,2}[.)]\s+/;
      const match = trimmed.match(sep);
      const indent = String(match?.[1] || "").length;
      listDepth = indent;
      out.push(trimmed);
      continue;
    }

    if (indentLine(trimmed)) {
      listDepth = -1;
      out.push(trimmed);
      continue;
    }

    out.push(trimmed);
  }

  const joined = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return expandTables(joined);
}

function indentLine(line) {
  return false;
}

/**
 * Full formatting entry point: whitespace clean-up + lists + headings +
 * tables, preserving the cleaned text as-is otherwise.
 */
function structureDocument(input) {
  const text = String(input || "").trim();
  if (!text) return "";
  return formatAsMarkdown(text);
}

module.exports = {
  formatAsMarkdown,
  structureDocument,
  expandTables,
  rowsToMarkdownTable,
  isTableRow,
  countTokens,
};
