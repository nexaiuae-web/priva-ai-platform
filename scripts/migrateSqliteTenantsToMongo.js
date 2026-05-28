#!/usr/bin/env node
/**
 * One-time migration: data/tenants.db (SQLite) → MongoDB Atlas (companies, users, sessions).
 * Run where Atlas DNS works (Render shell, VPS, or CI):
 *   node scripts/migrateSqliteTenantsToMongo.js
 */
require("dotenv").config();
const { connectDatabase, disconnectDatabase } = require("../config/database");
const { getDb, closeDb } = require("../services/tenantDb");
const Company = require("../models/Company");
const User = require("../models/User");
const UserSession = require("../models/UserSession");

function toDate(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

(async () => {
  try {
    await connectDatabase();
    const db = getDb();

    const companies = db.prepare("SELECT * FROM companies").all();
    for (const row of companies) {
      await Company.updateOne(
        { id: row.id },
        {
          $set: {
            id: row.id,
            company_name: row.company_name,
            openai_api_key: row.openai_api_key || "",
            storage_limit_mb: Number(row.storage_limit_mb ?? 512),
            max_users: Number(row.max_users ?? 10),
            status: row.status || "active",
            created_at: toDate(row.created_at),
          },
        },
        { upsert: true }
      );
    }
    console.log(`[MIGRATE] companies: ${companies.length}`);

    const users = db.prepare("SELECT * FROM users").all();
    for (const row of users) {
      await User.updateOne(
        { id: row.id },
        {
          $set: {
            id: row.id,
            username: String(row.username || "").toLowerCase(),
            password_hash: row.password_hash,
            company_id: row.company_id,
            role: row.role,
            storage_limit_mb:
              row.storage_limit_mb == null || row.storage_limit_mb === ""
                ? null
                : Number(row.storage_limit_mb),
            created_at: toDate(row.created_at),
          },
        },
        { upsert: true }
      );
    }
    console.log(`[MIGRATE] users: ${users.length}`);

    const sessions = db.prepare("SELECT * FROM user_sessions").all();
    for (const row of sessions) {
      await UserSession.updateOne(
        { id: row.id },
        {
          $set: {
            id: row.id,
            user_id: row.user_id,
            company_id: row.company_id,
            jti: row.jti,
            created_at: toDate(row.created_at),
            expires_at: toDate(row.expires_at),
          },
        },
        { upsert: true }
      );
    }
    console.log(`[MIGRATE] user_sessions: ${sessions.length}`);

    console.log("[MIGRATE] SQLite tenant migration complete.");
    console.log(
      "[MIGRATE] Note: user_face_profiles images in data/face_profiles/ are local-only; re-enroll on cloud if needed."
    );
  } catch (err) {
    console.error("[MIGRATE] Failed:", err.message);
    process.exitCode = 1;
  } finally {
    closeDb();
    await disconnectDatabase();
  }
})();
