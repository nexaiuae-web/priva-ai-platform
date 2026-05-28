const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "tenants.db");

let db = null;

function getDb() {
  if (db) {
    return db;
  }

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      openai_api_key TEXT NOT NULL DEFAULT '',
      storage_limit_mb INTEGER NOT NULL DEFAULT 512,
      max_users INTEGER NOT NULL DEFAULT 10,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      password_hash TEXT NOT NULL,
      company_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      storage_limit_mb INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_users_company_id ON users(company_id);

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      company_id TEXT NOT NULL,
      jti TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_user_sessions_company_id ON user_sessions(company_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS user_face_profiles (
      user_id TEXT PRIMARY KEY,
      descriptor_json TEXT NOT NULL,
      reference_image_path TEXT,
      enrolled_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const companyColumns = db.prepare(`PRAGMA table_info(companies)`).all();
  const columnNames = new Set(companyColumns.map((col) => col.name));
  if (!columnNames.has("storage_limit_mb")) {
    db.exec(`ALTER TABLE companies ADD COLUMN storage_limit_mb INTEGER NOT NULL DEFAULT 512`);
  }
  if (!columnNames.has("max_users")) {
    db.exec(`ALTER TABLE companies ADD COLUMN max_users INTEGER NOT NULL DEFAULT 10`);
  }
  if (!columnNames.has("status")) {
    db.exec(`ALTER TABLE companies ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  }

  const userColumns = db.prepare(`PRAGMA table_info(users)`).all();
  const userColumnNames = new Set(userColumns.map((col) => col.name));
  if (!userColumnNames.has("storage_limit_mb")) {
    db.exec(`ALTER TABLE users ADD COLUMN storage_limit_mb INTEGER`);
  }

  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  getDb,
  closeDb,
  DB_PATH,
};
