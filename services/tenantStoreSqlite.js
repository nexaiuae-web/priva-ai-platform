const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { getDb } = require("./tenantDb");

const BCRYPT_ROUNDS = 10;
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "password123";
const DEFAULT_COMPANY_NAME = "Default Company";

function mapCompanyRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_name: row.company_name,
    openai_api_key: row.openai_api_key || "",
    storage_limit_mb: Number(row.storage_limit_mb ?? 512),
    max_users: Number(row.max_users ?? 10),
    status: row.status || "active",
    created_at: row.created_at,
  };
}

function mapUserRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    password_hash: row.password_hash,
    company_id: row.company_id,
    role: row.role,
    storage_limit_mb:
      row.storage_limit_mb == null || row.storage_limit_mb === ""
        ? null
        : Number(row.storage_limit_mb),
    created_at: row.created_at,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    company_id: user.company_id,
    role: user.role,
    storage_limit_mb:
      user.storage_limit_mb == null || user.storage_limit_mb === ""
        ? null
        : Number(user.storage_limit_mb),
    created_at: user.created_at,
  };
}

function sumUserStorageLimitsForCompany(companyId, { excludeUserId = null } = {}) {
  const db = getDb();
  const id = String(companyId || "").trim();
  const exclude = excludeUserId ? String(excludeUserId) : null;
  const rows = db
    .prepare(
      `SELECT id, storage_limit_mb FROM users WHERE company_id = ? AND role = 'user'`
    )
    .all(id);

  return rows.reduce((sum, row) => {
    if (exclude && row.id === exclude) return sum;
    const mb = Number(row.storage_limit_mb);
    if (!Number.isFinite(mb) || mb < 1) return sum;
    return sum + mb;
  }, 0);
}

/**
 * Unallocated slice of the company pool (sum of user sub-quotas must not exceed company limit).
 */
function getUnallocatedCompanyStorageMb(companyId, { excludeUserId = null } = {}) {
  const company = getCompanyById(companyId);
  if (!company) return 0;
  const companyLimit = Math.max(1, Number(company.storage_limit_mb) || 512);
  const allocated = sumUserStorageLimitsForCompany(companyId, { excludeUserId });
  return Math.max(0, companyLimit - allocated);
}

function resolveDefaultUserStorageLimitMb(companyId, { excludeUserId = null } = {}) {
  const unallocated = getUnallocatedCompanyStorageMb(companyId, { excludeUserId });
  if (unallocated >= 1) return unallocated;
  const company = getCompanyById(companyId);
  return Math.max(1, Number(company?.storage_limit_mb) || 1);
}

function parseUserStorageLimitMb(raw, companyId, { excludeUserId = null } = {}) {
  if (raw === undefined || raw === null || raw === "") {
    return resolveDefaultUserStorageLimitMb(companyId, { excludeUserId });
  }
  const parsed = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("storage_limit_mb must be a positive number.");
  }
  return Math.max(1, Math.round(parsed * 100) / 100);
}

function assertUserStorageAllocationFitsCompany(companyId, storageLimitMb, { excludeUserId = null } = {}) {
  const company = getCompanyById(companyId);
  if (!company) {
    throw new Error("Company not found.");
  }
  const companyLimit = Math.max(1, Number(company.storage_limit_mb) || 512);
  const otherAllocated = sumUserStorageLimitsForCompany(companyId, { excludeUserId });
  const requested = Math.max(1, Number(storageLimitMb) || 1);
  if (otherAllocated + requested > companyLimit) {
    throw new Error(
      `User storage quota (${requested} MB) exceeds the company pool. ` +
        `${otherAllocated} MB already assigned; company limit is ${companyLimit} MB.`
    );
  }
  return requested;
}

function hashPassword(plainPassword) {
  return bcrypt.hashSync(String(plainPassword), BCRYPT_ROUNDS);
}

function verifyPassword(plainPassword, passwordHash) {
  return bcrypt.compareSync(String(plainPassword), String(passwordHash));
}

function createCompany({
  company_name,
  openai_api_key = "",
  storage_limit_mb = 512,
  status = "active",
}) {
  const name = String(company_name || "").trim();
  if (!name) {
    throw new Error("company_name is required.");
  }

  const storageMb = Math.max(1, Number.parseInt(storage_limit_mb, 10) || 512);
  const companyStatus = String(status || "active").trim() || "active";

  const db = getDb();
  const company = {
    id: `cmp_${crypto.randomBytes(6).toString("hex")}`,
    company_name: name,
    openai_api_key: String(openai_api_key || "").trim(),
    storage_limit_mb: storageMb,
    max_users: 10,
    status: companyStatus,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO companies (id, company_name, openai_api_key, storage_limit_mb, max_users, status, created_at)
     VALUES (@id, @company_name, @openai_api_key, @storage_limit_mb, @max_users, @status, @created_at)`
  ).run(company);

  return company;
}

function createUser({
  username,
  password,
  company_id,
  role = "user",
  storage_limit_mb = undefined,
}) {
  const uname = String(username || "").trim();
  const companyId = String(company_id || "").trim();
  const userRole = String(role || "user").trim();

  if (!uname || !password) {
    throw new Error("username and password are required.");
  }
  if (!companyId) {
    throw new Error("company_id is required.");
  }
  if (userRole !== "admin" && userRole !== "user") {
    throw new Error("role must be 'admin' or 'user'.");
  }

  const db = getDb();
  const company = getCompanyById(companyId);
  if (!company) {
    throw new Error("Company not found.");
  }

  const existing = db
    .prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`)
    .get(uname);
  if (existing) {
    throw new Error(`Username "${uname}" is already taken.`);
  }

  let resolvedStorageMb = null;
  if (userRole === "user") {
    resolvedStorageMb = parseUserStorageLimitMb(storage_limit_mb, companyId);
  }

  const user = {
    id: `usr_${crypto.randomBytes(6).toString("hex")}`,
    username: uname,
    password_hash: hashPassword(password),
    company_id: companyId,
    role: userRole,
    storage_limit_mb: resolvedStorageMb,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO users (id, username, password_hash, company_id, role, storage_limit_mb, created_at)
     VALUES (@id, @username, @password_hash, @company_id, @role, @storage_limit_mb, @created_at)`
  ).run(user);

  return publicUser(user);
}

function updateUserById(userId, { storage_limit_mb } = {}) {
  const id = String(userId || "").trim();
  if (!id) {
    throw new Error("User id is required.");
  }

  const existing = findUserById(id);
  if (!existing) {
    return null;
  }

  if (storage_limit_mb === undefined) {
    return publicUser(existing);
  }

  if (existing.role !== "user") {
    throw new Error("Storage quota applies only to workspace users.");
  }

  const resolved = parseUserStorageLimitMb(storage_limit_mb, existing.company_id, {
    excludeUserId: id,
  });

  const db = getDb();
  db.prepare(`UPDATE users SET storage_limit_mb = @storage_limit_mb WHERE id = @id`).run({
    id,
    storage_limit_mb: resolved,
  });

  return publicUser({
    ...existing,
    storage_limit_mb: resolved,
  });
}

function getUserStorageLimitMbResolved(userId) {
  const user = findUserById(userId);
  if (!user) return null;
  if (user.role !== "user") return null;
  if (user.storage_limit_mb != null && Number(user.storage_limit_mb) >= 1) {
    return Number(user.storage_limit_mb);
  }
  return resolveDefaultUserStorageLimitMb(user.company_id, { excludeUserId: user.id });
}

function getCompanyById(companyId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(String(companyId || ""));
  return mapCompanyRow(row);
}

function listCompanies() {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM companies ORDER BY datetime(created_at) ASC`)
    .all();
  return rows.map(mapCompanyRow);
}

function countUsersByCompanyId(companyId) {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM users WHERE company_id = ?`)
    .get(String(companyId || ""));
  return Number(row?.count || 0);
}

function createUserSession({ user_id, company_id, jti, expires_at }) {
  const db = getDb();
  const session = {
    id: `ses_${crypto.randomBytes(6).toString("hex")}`,
    user_id: String(user_id),
    company_id: String(company_id),
    jti: String(jti),
    created_at: new Date().toISOString(),
    expires_at: String(expires_at),
  };

  db.prepare(
    `INSERT INTO user_sessions (id, user_id, company_id, jti, created_at, expires_at)
     VALUES (@id, @user_id, @company_id, @jti, @created_at, @expires_at)`
  ).run(session);

  return session;
}

function listCompaniesWithStats() {
  return listCompanies().map((company) => ({
    ...company,
    user_count: countUsersByCompanyId(company.id),
  }));
}

function getTenantMetrics() {
  const companies = listCompaniesWithStats();
  const activeCompanies = companies.filter((company) => company.status === "active");
  return {
    total_active_companies: activeCompanies.length,
    total_storage_mb: companies.reduce(
      (sum, company) => sum + Number(company.storage_limit_mb || 0),
      0
    ),
    total_system_users: companies.reduce(
      (sum, company) => sum + Number(company.user_count || 0),
      0
    ),
  };
}

function updateCompanyLimits(companyId, { storage_limit_mb }) {
  const id = String(companyId || "").trim();
  if (!id) {
    throw new Error("Company id is required.");
  }

  const existing = getCompanyById(id);
  if (!existing) {
    return null;
  }

  if (storage_limit_mb === undefined || storage_limit_mb === null || storage_limit_mb === "") {
    throw new Error("storage_limit_mb is required.");
  }

  const parsed = Number.parseInt(storage_limit_mb, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("storage_limit_mb must be a positive integer.");
  }

  const db = getDb();
  db.prepare(`UPDATE companies SET storage_limit_mb = @storage_limit_mb WHERE id = @id`).run({
    id,
    storage_limit_mb: parsed,
  });

  const userCount = countUsersByCompanyId(id);
  return {
    ...getCompanyById(id),
    user_count: userCount,
  };
}

function listUserIdsByCompanyId(companyId) {
  const db = getDb();
  const id = String(companyId || "").trim();
  if (!id) return [];
  const rows = db.prepare(`SELECT id FROM users WHERE company_id = ?`).all(id);
  return rows.map((row) => row.id).filter(Boolean);
}

function deleteUserById(userId) {
  const db = getDb();
  const id = String(userId || "").trim();
  if (!id) return false;

  const existing = findUserById(id);
  if (!existing) return false;

  db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(id);
  db.prepare(`DELETE FROM user_face_profiles WHERE user_id = ?`).run(id);
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  return true;
}

function deleteCompanyById(companyId) {
  const db = getDb();
  const id = String(companyId || "").trim();
  if (!id) return false;

  const existing = getCompanyById(id);
  if (!existing) return false;

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM user_sessions WHERE company_id = ?`).run(id);
    db.prepare(`DELETE FROM user_face_profiles WHERE user_id IN (SELECT id FROM users WHERE company_id = ?)`).run(
      id
    );
    db.prepare(`DELETE FROM users WHERE company_id = ?`).run(id);
    db.prepare(`DELETE FROM companies WHERE id = ?`).run(id);
  });
  tx();
  return true;
}

function findUserById(userId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(String(userId || "").trim());
  return mapUserRow(row);
}

function findUserByUsername(username) {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`)
    .get(String(username || "").trim());
  return mapUserRow(row);
}

function isSystemAdminAccount(user) {
  if (!user) return false;
  const username = String(user.username || "").trim().toLowerCase();
  return username === DEFAULT_ADMIN_USERNAME.toLowerCase();
}

/** Workspace employees only — excludes central admin and company portal admins. */
function listUsersForAdmin() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.company_id, u.role, u.storage_limit_mb, u.created_at, c.company_name
       FROM users u
       INNER JOIN companies c ON c.id = u.company_id
       WHERE LOWER(TRIM(u.username)) != LOWER(?)
         AND u.role = 'user'
       ORDER BY datetime(c.created_at) ASC, u.username ASC`
    )
    .all(DEFAULT_ADMIN_USERNAME);

  return rows.map((row) => {
    const mapped = mapUserRow(row);
    return {
      ...publicUser(mapped),
      company_name: row.company_name,
      storage_limit_mb: getUserStorageLimitMbResolved(mapped.id),
    };
  });
}

function verifyUserCredentials(username, password) {
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return null;
  }

  const company = getCompanyById(user.company_id);
  if (!company) {
    return null;
  }

  return { user: publicUser(user), company };
}

/**
 * Ensure the platform admin account always exists with known dev credentials.
 * Runs on every startup: upserts username/password (bcrypt) and role=admin.
 */
function ensureDefaultAdminUser() {
  const db = getDb();
  const passwordHash = hashPassword(DEFAULT_ADMIN_PASSWORD);

  let companyRow = db
    .prepare(`SELECT * FROM companies ORDER BY datetime(created_at) ASC LIMIT 1`)
    .get();

  let company;
  if (!companyRow) {
    company = createCompany({
      company_name: DEFAULT_COMPANY_NAME,
      openai_api_key: String(process.env.OPENAI_API_KEY || "").trim(),
      storage_limit_mb: 512,
      max_users: 10,
      status: "active",
    });
    console.log("[TENANT] Created default company for admin | id:", company.id);
  } else {
    company = mapCompanyRow(companyRow);
    if (company.status !== "active") {
      db.prepare(`UPDATE companies SET status = 'active' WHERE id = ?`).run(company.id);
      company.status = "active";
    }
  }

  const existing = findUserByUsername(DEFAULT_ADMIN_USERNAME);
  if (existing) {
    db.prepare(
      `UPDATE users
       SET password_hash = @password_hash,
           role = 'admin',
           company_id = @company_id
       WHERE id = @id`
    ).run({
      password_hash: passwordHash,
      company_id: company.id,
      id: existing.id,
    });

    console.log(
      "[TENANT] Default admin upserted | username:",
      DEFAULT_ADMIN_USERNAME,
      "| company_id:",
      company.id
    );

    return {
      company,
      user: publicUser({
        ...existing,
        password_hash: passwordHash,
        company_id: company.id,
        role: "admin",
      }),
      action: "updated",
    };
  }

  const user = {
    id: `usr_${crypto.randomBytes(6).toString("hex")}`,
    username: DEFAULT_ADMIN_USERNAME,
    password_hash: passwordHash,
    company_id: company.id,
    role: "admin",
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO users (id, username, password_hash, company_id, role, created_at)
     VALUES (@id, @username, @password_hash, @company_id, @role, @created_at)`
  ).run(user);

  console.log(
    "[TENANT] Default admin created | username:",
    DEFAULT_ADMIN_USERNAME,
    "| company_id:",
    company.id
  );

  return { company, user: publicUser(user), action: "created" };
}

function initTenantStore() {
  getDb();
  ensureDefaultAdminUser();
  const companies = listCompanies();
  console.log("[TENANT] SQLite store ready | companies:", companies.length);
  return { companies };
}

function getReservedUploadStorageBytes(company_id, { excludeJobId = null } = {}) {
  const { ensureUploadJobsTable } = require("./uploadJobsSqlite");
  ensureUploadJobsTable();
  const db = getDb();
  const id = String(company_id || "").trim();
  const excludeId = excludeJobId ? String(excludeJobId) : null;
  const placeholders = ["pending", "processing", "queued", "running"].map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, file_size_bytes FROM upload_jobs
       WHERE company_id = ?
         AND status IN (${placeholders})`
    )
    .all(id, "pending", "processing", "queued", "running");
  return rows.reduce((sum, row) => {
    if (excludeId && row.id === excludeId) return sum;
    return sum + Math.max(0, Number(row.file_size_bytes) || 0);
  }, 0);
}

module.exports = {
  initTenantStore,
  ensureDefaultAdminUser,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
  createCompany,
  createUser,
  updateUserById,
  getUserStorageLimitMbResolved,
  getUnallocatedCompanyStorageMb,
  resolveDefaultUserStorageLimitMb,
  getCompanyById,
  listCompanies,
  listCompaniesWithStats,
  getTenantMetrics,
  updateCompanyLimits,
  deleteCompanyById,
  deleteUserById,
  listUserIdsByCompanyId,
  findUserById,
  findUserByUsername,
  listUsersForAdmin,
  isSystemAdminAccount,
  verifyUserCredentials,
  publicUser,
  createUserSession,
  hashPassword,
  verifyPassword,
  parseUserStorageLimitMb,
  assertUserStorageAllocationFitsCompany,
  mapCompanyRow,
  mapUserRow,
  getReservedUploadStorageBytes,
};
