#!/usr/bin/env node
require("dotenv").config();
const path = require("path");
const fs = require("fs-extra");
const { connectDatabase, disconnectDatabase } = require("../config/database");
const TrialTracker = require("../models/TrialTracker");
const Document = require("../models/Document");
const DocumentParent = require("../models/DocumentParent");
const Folder = require("../models/Folder");

const DB_JSON_PATH = path.join(__dirname, "..", "data", "db.json");

function toDateOrNow(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return new Date();
  return new Date(ms);
}

async function migrateCollection(name, items, upsertFn) {
  let migrated = 0;
  for (const item of items) {
    await upsertFn(item);
    migrated += 1;
  }
  console.log(`[MIGRATE] ${name}: ${migrated} record(s) processed`);
}

(async () => {
  try {
    if (!(await fs.pathExists(DB_JSON_PATH))) {
      throw new Error(`Source file not found: ${DB_JSON_PATH}`);
    }

    await connectDatabase();
    const db = await fs.readJson(DB_JSON_PATH);

    const documents = Array.isArray(db.documents) ? db.documents : [];
    const parents = Array.isArray(db.document_parents) ? db.document_parents : [];
    const folders = Array.isArray(db.folders) ? db.folders : [];
    const trialTrackers = Array.isArray(db.trial_trackers) ? db.trial_trackers : [];

    await migrateCollection("documents", documents, async (doc) => {
      const id = String(doc.id || "").trim();
      if (!id) return;
      await Document.updateOne(
        { id },
        {
          $set: {
            ...doc,
            id,
            company_id: String(doc.company_id || "").trim(),
            created_at: toDateOrNow(doc.created_at),
            updated_at: toDateOrNow(doc.updated_at || doc.created_at),
          },
        },
        { upsert: true }
      );
    });

    await migrateCollection("document_parents", parents, async (parent) => {
      const id = String(parent.id || "").trim();
      if (!id) return;
      await DocumentParent.updateOne(
        { id },
        {
          $set: {
            ...parent,
            id,
            company_id: String(parent.company_id || "").trim(),
            document_id: String(parent.document_id || "").trim(),
            created_at: toDateOrNow(parent.created_at),
          },
        },
        { upsert: true }
      );
    });

    await migrateCollection("folders", folders, async (folder) => {
      const id = String(folder.id || "").trim();
      if (!id) return;
      await Folder.updateOne(
        { id },
        {
          $set: {
            ...folder,
            id,
            user_id: String(folder.user_id || "").trim(),
            company_id: String(folder.company_id || "").trim(),
            created_at: toDateOrNow(folder.created_at),
            updated_at: toDateOrNow(folder.updated_at || folder.created_at),
          },
        },
        { upsert: true }
      );
    });

    await migrateCollection("trial_trackers", trialTrackers, async (tracker) => {
      const fingerprint = String(tracker.device_fingerprint || "").trim();
      if (!fingerprint) return;
      await TrialTracker.updateOne(
        { device_fingerprint: fingerprint },
        {
          $set: {
            device_fingerprint: fingerprint,
            request_count: Math.max(0, Number(tracker.request_count) || 0),
            storage_used_bytes: Math.max(0, Number(tracker.storage_used_bytes) || 0),
            first_request_at: toDateOrNow(tracker.first_request_at),
            updated_at: toDateOrNow(tracker.updated_at || tracker.first_request_at),
          },
        },
        { upsert: true }
      );
    });

    console.log("[MIGRATE] Completed JSON -> Mongo migration successfully.");
  } catch (error) {
    console.error("[MIGRATE] Failed:", error.message);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
})();
