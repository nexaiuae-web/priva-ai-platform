const path = require("path");
const fs = require("fs");
const { getDb } = require("./tenantDb");
const { useMongoTenants } = require("./runtimeConfig");

const FACE_PROFILES_DIR = path.join(__dirname, "..", "data", "face_profiles");

function useMongoFaceStore() {
  return useMongoTenants();
}

function getLegacyReferenceImagePath(userId) {
  return path.join(FACE_PROFILES_DIR, `${String(userId || "").trim()}.jpg`);
}

function normalizeDescriptorsPayload(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry) => Array.isArray(entry) && entry.length > 0);
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureSqliteFaceProfilesTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_face_profiles (
      user_id TEXT PRIMARY KEY,
      descriptors_json TEXT NOT NULL DEFAULT '[]',
      reference_images_json TEXT NOT NULL DEFAULT '[]',
      enrolled_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  migrateLegacyFaceProfilesSchema(db);
}

function migrateLegacyFaceProfilesSchema(db) {
  const columns = db.prepare(`PRAGMA table_info(user_face_profiles)`).all();
  const columnNames = columns.map((col) => col.name);
  if (!columnNames.length) return;

  if (columnNames.includes("descriptors_json")) {
    return;
  }

  if (!columnNames.includes("descriptor_json")) {
    return;
  }

  console.log("[FACE] Migrating user_face_profiles to multi-reference schema…");
  const rows = db.prepare(`SELECT * FROM user_face_profiles`).all();

  db.exec(`
    CREATE TABLE user_face_profiles_migrated (
      user_id TEXT PRIMARY KEY,
      descriptors_json TEXT NOT NULL DEFAULT '[]',
      reference_images_json TEXT NOT NULL DEFAULT '[]',
      enrolled_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const insert = db.prepare(
    `INSERT INTO user_face_profiles_migrated
     (user_id, descriptors_json, reference_images_json, enrolled_at, updated_at)
     VALUES (@user_id, @descriptors_json, @reference_images_json, @enrolled_at, @updated_at)`
  );

  for (const row of rows) {
    let legacyDescriptorRaw = [];
    try {
      legacyDescriptorRaw = JSON.parse(row.descriptor_json || "[]");
    } catch {
      legacyDescriptorRaw = [];
    }
    const descriptors = normalizeDescriptorsPayload(legacyDescriptorRaw);
    const legacyPath = row.reference_image_path || getLegacyReferenceImagePath(row.user_id);
    const imagePaths = legacyPath && fs.existsSync(legacyPath) ? [legacyPath] : [];
    insert.run({
      user_id: row.user_id,
      descriptors_json: JSON.stringify(descriptors),
      reference_images_json: JSON.stringify(imagePaths),
      enrolled_at: row.enrolled_at,
      updated_at: row.updated_at,
    });
  }

  db.exec(`DROP TABLE user_face_profiles`);
  db.exec(`ALTER TABLE user_face_profiles_migrated RENAME TO user_face_profiles`);
  console.log("[FACE] Multi-reference migration complete:", rows.length, "profile(s)");
}

async function assertMongoUserExists(userId) {
  const User = require("../models/User");
  const exists = await User.exists({ id: String(userId || "").trim() });
  if (!exists) {
    throw new Error(`Cannot save face profile: user ${userId} not found in tenant store.`);
  }
}

async function loadFaceProfileRow(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;

  if (useMongoFaceStore()) {
    const UserFaceProfile = require("../models/UserFaceProfile");
    return UserFaceProfile.findOne({ user_id: id }).lean();
  }

  ensureSqliteFaceProfilesTable();
  const db = getDb();
  return db.prepare(`SELECT * FROM user_face_profiles WHERE user_id = ?`).get(id) || null;
}

async function upsertFaceProfileRow(record) {
  const id = String(record.user_id || "").trim();
  if (!id) {
    throw new Error("user_id is required for face profile persistence.");
  }

  if (useMongoFaceStore()) {
    await assertMongoUserExists(id);
    const UserFaceProfile = require("../models/UserFaceProfile");
    await UserFaceProfile.findOneAndUpdate(
      { user_id: id },
      {
        $set: {
          user_id: id,
          descriptors_json: record.descriptors_json,
          reference_images_json: record.reference_images_json,
          enrolled_at: record.enrolled_at,
          updated_at: record.updated_at,
        },
      },
      { upsert: true, new: true }
    );
    return;
  }

  ensureSqliteFaceProfilesTable();
  const db = getDb();
  const existing = db
    .prepare(`SELECT user_id FROM user_face_profiles WHERE user_id = ?`)
    .get(id);

  if (existing) {
    db.prepare(
      `UPDATE user_face_profiles
       SET descriptors_json = @descriptors_json,
           reference_images_json = @reference_images_json,
           updated_at = @updated_at
       WHERE user_id = @user_id`
    ).run(record);
  } else {
    db.prepare(
      `INSERT INTO user_face_profiles (user_id, descriptors_json, reference_images_json, enrolled_at, updated_at)
       VALUES (@user_id, @descriptors_json, @reference_images_json, @enrolled_at, @updated_at)`
    ).run(record);
  }
}

async function deleteFaceProfileRow(userId) {
  const id = String(userId || "").trim();
  if (!id) return;

  if (useMongoFaceStore()) {
    const UserFaceProfile = require("../models/UserFaceProfile");
    await UserFaceProfile.deleteOne({ user_id: id });
    return;
  }

  ensureSqliteFaceProfilesTable();
  const db = getDb();
  db.prepare(`DELETE FROM user_face_profiles WHERE user_id = ?`).run(id);
}

module.exports = {
  useMongoFaceStore,
  ensureSqliteFaceProfilesTable,
  loadFaceProfileRow,
  upsertFaceProfileRow,
  deleteFaceProfileRow,
};
