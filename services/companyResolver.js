const {
  getCompanyById: getTenantCompanyById,
  listCompanies: listTenantCompanies,
} = require("./tenantStore");
const {
  getCompanyById: getLegacyCompanyById,
  listCompaniesSafe,
  decryptExternalApiKey,
} = require("./admin");
const {
  isTrialModeRequest,
  getTrialCompanyIdForRequest,
  isValidTrialCompanyId,
} = require("./trialTracker");

function headerCompanyId(req) {
  const raw = req.headers["x-company-id"];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Resolve active company id from JWT user, headers, or body.
 */
async function resolveCompanyId(req) {
  if (isTrialModeRequest(req)) {
    const trialCompanyId = getTrialCompanyIdForRequest(req);
    if (isValidTrialCompanyId(trialCompanyId)) {
      return trialCompanyId;
    }
    return null;
  }

  if (req.auth?.user?.company_id) {
    return String(req.auth.user.company_id).trim();
  }

  let companyId =
    req.body?.company_id ||
    req.query?.company_id ||
    headerCompanyId(req) ||
    req.auth?.company_id ||
    null;

  if (companyId != null) {
    companyId = String(companyId).trim() || null;
  }

  if (!companyId || companyId === "default") {
    const fromEnv = String(process.env.DEFAULT_COMPANY_ID || "").trim();
    if (fromEnv) {
      return fromEnv;
    }

    const tenantCompanies = await Promise.resolve(listTenantCompanies());
    if (tenantCompanies.length > 0) {
      return tenantCompanies[0].id;
    }

    const legacyCompanies = await listCompaniesSafe();
    if (legacyCompanies.length > 0) {
      return legacyCompanies[0].id;
    }

    return companyId || "default";
  }

  return companyId;
}

/**
 * Unified company record for handlers: { id, name, openai_api_key }.
 */
async function resolveCompanyRecord(companyId) {
  const id = String(companyId || "").trim();
  if (!id) return null;

  const tenant = await Promise.resolve(getTenantCompanyById(id));
  if (tenant) {
    return {
      id: tenant.id,
      name: tenant.company_name,
      company_name: tenant.company_name,
      openai_api_key: tenant.openai_api_key || "",
      storage_limit_mb: tenant.storage_limit_mb,
      max_users: tenant.max_users,
      status: tenant.status,
    };
  }

  const legacy = await getLegacyCompanyById(id);
  if (!legacy) return null;

  let openaiKey = "";
  try {
    openaiKey = decryptExternalApiKey(legacy.external_api_key_encrypted) || "";
  } catch {
    openaiKey = "";
  }

  return {
    id: legacy.id,
    name: legacy.name,
    company_name: legacy.name,
    openai_api_key: openaiKey,
    storage_limit_mb: 512,
    max_users: 10,
    status: "active",
  };
}

module.exports = {
  resolveCompanyId,
  resolveCompanyRecord,
};
