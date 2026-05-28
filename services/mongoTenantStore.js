const crypto = require("crypto");
const Company = require("../models/Company");
const User = require("../models/User");
const UserSession = require("../models/UserSession");
const sqliteHelpers = require("./tenantStoreSqlite");

const DEFAULT_ADMIN_USERNAME = sqliteHelpers.DEFAULT_ADMIN_USERNAME;
const DEFAULT_ADMIN_PASSWORD = sqliteHelpers.DEFAULT_ADMIN_PASSWORD;

function mapCompanyDoc(doc) {
  if (!doc) return null;
  return sqliteHelpers.mapCompanyRow({
    id: doc.id,
    company_name: doc.company_name,
    openai_api_key: doc.openai_api_key,
    storage_limit_mb: doc.storage_limit_mb,
    max_users: doc.max_users,
    status: doc.status,
    created_at: doc.created_at,
  });
}

function mapUserDoc(doc) {
  if (!doc) return null;
  return sqliteHelpers.mapUserRow({
    id: doc.id,
    username: doc.username,
    password_hash: doc.password_hash,
    company_id: doc.company_id,
    role: doc.role,
    storage_limit_mb: doc.storage_limit_mb,
    created_at: doc.created_at,
  });
}

async function getCompanyById(companyId) {
  const doc = await Company.findOne({ id: String(companyId || "").trim() }).lean();
  return mapCompanyDoc(doc);
}

async function listCompanies() {
  const docs = await Company.find({}).sort({ created_at: 1 }).lean();
  return docs.map(mapCompanyDoc);
}

async function countUsersByCompanyId(companyId) {
  return User.countDocuments({ company_id: String(companyId || "").trim() });
}

async function findUserById(userId) {
  const doc = await User.findOne({ id: String(userId || "").trim() }).lean();
  return mapUserDoc(doc);
}

async function findUserByUsername(username) {
  const uname = String(username || "").trim().toLowerCase();
  const doc = await User.findOne({ username: uname }).lean();
  return mapUserDoc(doc);
}

async function createCompany({
  company_name,
  openai_api_key = "",
  storage_limit_mb = 512,
  status = "active",
}) {
  const company = {
    id: `cmp_${crypto.randomBytes(6).toString("hex")}`,
    company_name: String(company_name || "").trim(),
    openai_api_key: String(openai_api_key || "").trim(),
    storage_limit_mb: Math.max(1, Number.parseInt(storage_limit_mb, 10) || 512),
    max_users: 10,
    status: String(status || "active").trim() || "active",
    created_at: new Date(),
  };
  await Company.create(company);
  return mapCompanyDoc(company);
}

async function sumUserStorageLimitsForCompany(companyId, { excludeUserId = null } = {}) {
  const users = await User.find({
    company_id: String(companyId || "").trim(),
    role: "user",
  }).lean();
  return users.reduce((sum, row) => {
    if (excludeUserId && row.id === excludeUserId) return sum;
    const mb = Number(row.storage_limit_mb);
    if (!Number.isFinite(mb) || mb < 1) return sum;
    return sum + mb;
  }, 0);
}

async function getUnallocatedCompanyStorageMb(companyId, { excludeUserId = null } = {}) {
  const company = await getCompanyById(companyId);
  if (!company) return 0;
  const companyLimit = Math.max(1, Number(company.storage_limit_mb) || 512);
  const allocated = await sumUserStorageLimitsForCompany(companyId, { excludeUserId });
  return Math.max(0, companyLimit - allocated);
}

async function resolveDefaultUserStorageLimitMb(companyId, { excludeUserId = null } = {}) {
  const unallocated = await getUnallocatedCompanyStorageMb(companyId, { excludeUserId });
  if (unallocated >= 1) return unallocated;
  const company = await getCompanyById(companyId);
  return Math.max(1, Number(company?.storage_limit_mb) || 1);
}

async function parseUserStorageLimitMb(raw, companyId, { excludeUserId = null } = {}) {
  if (raw === undefined || raw === null || raw === "") {
    return resolveDefaultUserStorageLimitMb(companyId, { excludeUserId });
  }
  const parsed = Number.parseFloat(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("storage_limit_mb must be a positive number.");
  }
  const company = await getCompanyById(companyId);
  if (!company) throw new Error("Company not found.");
  const companyLimit = Math.max(1, Number(company.storage_limit_mb) || 512);
  const otherAllocated = await sumUserStorageLimitsForCompany(companyId, { excludeUserId });
  const requested = Math.max(1, Math.round(parsed * 100) / 100);
  if (otherAllocated + requested > companyLimit) {
    throw new Error(
      `User storage quota (${requested} MB) exceeds the company pool. ` +
        `${otherAllocated} MB already assigned; company limit is ${companyLimit} MB.`
    );
  }
  return requested;
}

async function createUser({
  username,
  password,
  company_id,
  role = "user",
  storage_limit_mb = undefined,
}) {
  const uname = String(username || "").trim();
  const companyId = String(company_id || "").trim();
  const userRole = String(role || "user").trim();

  if (!uname || !password) throw new Error("username and password are required.");
  if (!companyId) throw new Error("company_id is required.");

  const company = await getCompanyById(companyId);
  if (!company) throw new Error("Company not found.");

  const existing = await User.findOne({ username: uname.toLowerCase() }).lean();
  if (existing) throw new Error(`Username "${uname}" is already taken.`);

  let resolvedStorageMb = null;
  if (userRole === "user") {
    resolvedStorageMb = await parseUserStorageLimitMb(storage_limit_mb, companyId);
  }

  const user = {
    id: `usr_${crypto.randomBytes(6).toString("hex")}`,
    username: uname.toLowerCase(),
    password_hash: sqliteHelpers.hashPassword(password),
    company_id: companyId,
    role: userRole,
    storage_limit_mb: resolvedStorageMb,
    created_at: new Date(),
  };

  await User.create(user);
  return sqliteHelpers.publicUser(user);
}

async function updateUserById(userId, { storage_limit_mb } = {}) {
  const existing = await findUserById(userId);
  if (!existing) return null;
  if (storage_limit_mb === undefined) return sqliteHelpers.publicUser(existing);

  const resolved = await parseUserStorageLimitMb(storage_limit_mb, existing.company_id, {
    excludeUserId: existing.id,
  });

  await User.updateOne({ id: existing.id }, { $set: { storage_limit_mb: resolved } });
  return sqliteHelpers.publicUser({ ...existing, storage_limit_mb: resolved });
}

async function getUserStorageLimitMbResolved(userId) {
  const user = await findUserById(userId);
  if (!user || user.role !== "user") return null;
  if (user.storage_limit_mb != null && Number(user.storage_limit_mb) >= 1) {
    return Number(user.storage_limit_mb);
  }
  return resolveDefaultUserStorageLimitMb(user.company_id, { excludeUserId: user.id });
}

async function listCompaniesWithStats() {
  const companies = await listCompanies();
  const stats = await Promise.all(
    companies.map(async (company) => ({
      ...company,
      user_count: await countUsersByCompanyId(company.id),
    }))
  );
  return stats;
}

async function getTenantMetrics() {
  const companies = await listCompaniesWithStats();
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

async function updateCompanyLimits(companyId, { storage_limit_mb }) {
  const existing = await getCompanyById(companyId);
  if (!existing) return null;
  const parsed = Number.parseInt(storage_limit_mb, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("storage_limit_mb must be a positive integer.");
  }
  await Company.updateOne({ id: existing.id }, { $set: { storage_limit_mb: parsed } });
  return {
    ...(await getCompanyById(existing.id)),
    user_count: await countUsersByCompanyId(existing.id),
  };
}

async function deleteUserById(userId) {
  const result = await User.deleteOne({ id: String(userId || "").trim() });
  return result.deletedCount > 0;
}

async function deleteCompanyById(companyId) {
  const id = String(companyId || "").trim();
  await User.deleteMany({ company_id: id });
  const result = await Company.deleteOne({ id });
  return result.deletedCount > 0;
}

async function listUsersForAdmin() {
  const companies = await listCompanies();
  const companyNameById = new Map(companies.map((c) => [c.id, c.company_name]));
  const users = await User.find({
    username: { $ne: DEFAULT_ADMIN_USERNAME.toLowerCase() },
    role: "user",
  })
    .sort({ username: 1 })
    .lean();

  const rows = [];
  for (const user of users) {
    const mapped = mapUserDoc(user);
    rows.push({
      ...sqliteHelpers.publicUser(mapped),
      company_name: companyNameById.get(mapped.company_id) || mapped.company_id,
      storage_limit_mb: await getUserStorageLimitMbResolved(mapped.id),
    });
  }
  return rows;
}

function isSystemAdminAccount(user) {
  return sqliteHelpers.isSystemAdminAccount(user);
}

async function verifyUserCredentials(username, password) {
  const user = await findUserByUsername(username);
  if (!user || !sqliteHelpers.verifyPassword(password, user.password_hash)) {
    return null;
  }
  const company = await getCompanyById(user.company_id);
  if (!company) return null;
  return { user: sqliteHelpers.publicUser(user), company };
}

async function createUserSession({ user_id, company_id, jti, expires_at }) {
  const session = {
    id: `ses_${crypto.randomBytes(6).toString("hex")}`,
    user_id: String(user_id),
    company_id: String(company_id),
    jti: String(jti),
    created_at: new Date(),
    expires_at: new Date(expires_at),
  };
  await UserSession.create(session);
  return session;
}

async function ensureDefaultAdminUser() {
  const passwordHash = sqliteHelpers.hashPassword(DEFAULT_ADMIN_PASSWORD);
  let company = (await listCompanies())[0];

  if (!company) {
    company = await createCompany({
      company_name: "Default Company",
      openai_api_key: String(process.env.OPENAI_API_KEY || "").trim(),
      storage_limit_mb: 512,
      max_users: 10,
      status: "active",
    });
    console.log("[TENANT/MONGO] Created default company for admin | id:", company.id);
  }

  const existing = await findUserByUsername(DEFAULT_ADMIN_USERNAME);
  if (existing) {
    await User.updateOne(
      { id: existing.id },
      {
        $set: {
          password_hash: passwordHash,
          role: "admin",
          company_id: company.id,
        },
      }
    );
    return {
      company,
      user: sqliteHelpers.publicUser({
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
    username: DEFAULT_ADMIN_USERNAME.toLowerCase(),
    password_hash: passwordHash,
    company_id: company.id,
    role: "admin",
    created_at: new Date(),
  };
  await User.create(user);
  return { company, user: sqliteHelpers.publicUser(user), action: "created" };
}

async function initTenantStore() {
  await ensureDefaultAdminUser();
  const companies = await listCompanies();
  console.log("[TENANT/MONGO] Mongo tenant store ready | companies:", companies.length);
  return { companies };
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
  findUserById,
  findUserByUsername,
  listUsersForAdmin,
  isSystemAdminAccount,
  verifyUserCredentials,
  publicUser: sqliteHelpers.publicUser,
  createUserSession,
};
