#!/usr/bin/env node
/**
 * Export db.json collections to NDJSON files for Atlas/mongoimport when direct
 * Node migration is blocked by local DNS (ENOTFOUND).
 *
 * Usage:
 *   node scripts/exportJsonForAtlasImport.js
 *
 * Output: data/atlas-import/<collection>.ndjson
 *
 * Import on a machine with working Atlas DNS (e.g. your VPS):
 *   mongoimport --uri "<MONGODB_URI>" --collection documents --file data/atlas-import/documents.ndjson
 */
const path = require("path");
const fs = require("fs-extra");

const DB_JSON_PATH = path.join(__dirname, "..", "data", "db.json");
const OUT_DIR = path.join(__dirname, "..", "data", "atlas-import");

const COLLECTIONS = [
  { key: "documents", file: "documents.ndjson" },
  { key: "document_parents", file: "document_parents.ndjson" },
  { key: "folders", file: "folders.ndjson" },
  { key: "trial_trackers", file: "trial_trackers.ndjson" },
];

function toIso(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return new Date().toISOString();
  return new Date(ms).toISOString();
}

function normalizeDoc(doc) {
  return {
    ...doc,
    created_at: toIso(doc.created_at),
    updated_at: toIso(doc.updated_at || doc.created_at),
  };
}

function normalizeParent(parent) {
  return {
    ...parent,
    created_at: toIso(parent.created_at),
  };
}

function normalizeFolder(folder) {
  return {
    ...folder,
    created_at: toIso(folder.created_at),
    updated_at: toIso(folder.updated_at || folder.created_at),
  };
}

function normalizeTrialTracker(tracker) {
  return {
    device_fingerprint: String(tracker.device_fingerprint || "").trim(),
    request_count: Math.max(0, Number(tracker.request_count) || 0),
    storage_used_bytes: Math.max(0, Number(tracker.storage_used_bytes) || 0),
    first_request_at: toIso(tracker.first_request_at),
    updated_at: toIso(tracker.updated_at || tracker.first_request_at),
  };
}

async function writeNdjson(filePath, rows) {
  const lines = rows.map((row) => JSON.stringify(row));
  await fs.writeFile(filePath, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
}

(async () => {
  try {
    if (!(await fs.pathExists(DB_JSON_PATH))) {
      throw new Error(`Missing source file: ${DB_JSON_PATH}`);
    }

    const db = await fs.readJson(DB_JSON_PATH);
    await fs.ensureDir(OUT_DIR);

    const documents = (Array.isArray(db.documents) ? db.documents : []).map(normalizeDoc);
    const parents = (Array.isArray(db.document_parents) ? db.document_parents : []).map(
      normalizeParent
    );
    const folders = (Array.isArray(db.folders) ? db.folders : []).map(normalizeFolder);
    const trackers = (Array.isArray(db.trial_trackers) ? db.trial_trackers : [])
      .map(normalizeTrialTracker)
      .filter((t) => t.device_fingerprint);

    await writeNdjson(path.join(OUT_DIR, "documents.ndjson"), documents);
    await writeNdjson(path.join(OUT_DIR, "document_parents.ndjson"), parents);
    await writeNdjson(path.join(OUT_DIR, "folders.ndjson"), folders);
    await writeNdjson(path.join(OUT_DIR, "trial_trackers.ndjson"), trackers);

    console.log("[EXPORT] Wrote Atlas import files to:", OUT_DIR);
    console.log("[EXPORT] documents:", documents.length);
    console.log("[EXPORT] document_parents:", parents.length);
    console.log("[EXPORT] folders:", folders.length);
    console.log("[EXPORT] trial_trackers:", trackers.length);
    console.log("\nNext: copy data/atlas-import/ to your VPS and run mongoimport, or use Compass Import.");
  } catch (error) {
    console.error("[EXPORT] Failed:", error.message);
    process.exitCode = 1;
  }
})();
