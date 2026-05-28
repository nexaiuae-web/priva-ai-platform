/**
 * Arabic OCR cleaning: normalization, numeral conversion, noise removal,
 * and optional dictionary-based fixes (Kimi-style pipeline).
 */

const EASTERN_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const WESTERN_DIGITS = "0123456789";

/** Common OCR substitutions for Arabic / mixed layouts */
const OCR_DICTIONARY = [
  [/‏/g, ""],
  [/‎/g, ""],
  [/\u200c|\u200d|\u200e|\u200f|\u061c|\u202a-\u202e/g, ""],
  [/[\u0640\uFEFF]/g, ""],
  [/[£€$]{2,}/g, " "],
];

/** Strip combining marks (harakat) */
const DIACRITICS_REGEX =
  /[\u064B-\u065F\u0670\u06D6-\u06ED\u08D4-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;

/** Lines that are mostly noise (OCR garbage) */
const NOISE_LINE_REGEX =
  /^[\s\-_=+*|\\/:;,.<>?[\]{}()`~!@#%^&"'0-9٠-٩a-zA-Z]{0,4}$/u;

class OCRCleaner {
  constructor(options = {}) {
    this.extraReplacements = options.extraReplacements || [];
  }

  normalizeArabic(text) {
    let s = String(text || "");

    s = s.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627");
    s = s.replace(/\u0649/g, "\u064A");
    s = s.replace(/\u0629/g, "\u0647");
    s = s.replace(DIACRITICS_REGEX, "");
    s = s.replace(/\u0640/g, "");

    for (let i = 0; i < EASTERN_DIGITS.length; i++) {
      const re = new RegExp(EASTERN_DIGITS[i], "g");
      s = s.replace(re, WESTERN_DIGITS[i]);
    }

    for (const [pattern, replacement] of OCR_DICTIONARY) {
      s = s.replace(pattern, replacement);
    }

    for (const rule of this.extraReplacements) {
      if (Array.isArray(rule) && rule.length >= 2) {
        s = s.replace(rule[0], rule[1]);
      }
    }

    s = s.replace(/[^\S\n\r]+/g, " ");
    s = s.replace(/[ \t]+\n/g, "\n");
    s = s.replace(/\n{3,}/g, "\n\n");

    return s.trim();
  }

  removeNoiseSymbols(text) {
    let s = String(text || "");

    s = s.replace(/[^\w\s\u0600-\u06FF.,:;!?()\[\]{}«»\u201c\u201d''\-–—/\\]/gi, " ");
    s = s.replace(/(?:\b[a-zA-Z]\b\s*){3,}/g, " ");
    s = s.replace(/\s{2,}/g, " ");

    return s;
  }

  removeMeaninglessLines(text) {
    const lines = String(text || "").split(/\r?\n/);
    const kept = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.length < 2 && !/[\u0600-\u06FF]/.test(trimmed)) continue;
      if (NOISE_LINE_REGEX.test(trimmed) && !/[\u0600-\u06FF]{2,}/.test(trimmed)) continue;
      kept.push(trimmed);
    }

    return kept.join("\n");
  }

  /**
   * Full pipeline: noise → line filter → Arabic normalize.
   * @param {string} rawText
   * @returns {string}
   */
  clean(rawText) {
    let s = String(rawText || "");
    s = this.removeNoiseSymbols(s);
    s = this.removeMeaninglessLines(s);
    s = this.normalizeArabic(s);
    return s.trim();
  }
}

module.exports = {
  OCRCleaner,
};
