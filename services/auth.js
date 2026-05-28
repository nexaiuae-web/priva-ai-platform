const dotenv = require("dotenv");
const crypto = require("crypto");
const { isJwtToken, isAdminRole, extractBearerToken } = require("./jwtAuth");

dotenv.config();

function extractCompanyId(req) {
  const companyIdHeader = req.headers["x-company-id"];
  if (companyIdHeader) {
    return Array.isArray(companyIdHeader) ? companyIdHeader[0] : companyIdHeader;
  }

  const token = extractBearerToken(req);
  if (token && isJwtToken(token)) {
    return null;
  }

  const authHeader = req.headers.authorization ?? req.headers.Authorization;
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }

  const [scheme, companyToken] = authHeader.split(" ");
  if (!scheme || !companyToken || scheme.toLowerCase() !== "bearer") {
    return null;
  }

  const trimmed = companyToken.trim();
  if (isJwtToken(trimmed)) {
    return null;
  }

  if (trimmed.startsWith("cmp_")) {
    return trimmed;
  }

  if (trimmed.startsWith("company:")) {
    return trimmed.slice("company:".length);
  }

  return null;
}

function isApiRequest(req) {
  const urlPath = String(req.originalUrl || req.url || "").split("?")[0];
  return urlPath.startsWith("/api") || urlPath.startsWith("/admin");
}

function attachCompanyContext(req, _res, next) {
  if (!isApiRequest(req)) {
    return next();
  }
  req.auth = req.auth || {};
  req.auth.company_id = extractCompanyId(req);
  return next();
}

/** Company + optional JWT parsing — mount only on /api and /admin routers. */
function attachApiAuth(req, res, next) {
  attachCompanyContext(req, res, (err) => {
    if (err) return next(err);
    const { attachJwtUser } = require("./jwtAuth");
    return attachJwtUser(req, res, next);
  });
}

/** Paths that skip x-master-key (local frontend dev). */
const MASTER_KEY_BYPASS_PATHS = [
  "/api/login",
  "/api/chat",
  "/api/upload",
  "/api/documents",
  "/api/admin/companies",
  "/admin/upload-doc",
  "/admin/docs",
];

function isMasterKeyBypassed(req) {
  const path = String(req.originalUrl || req.url || "").split("?")[0];
  return MASTER_KEY_BYPASS_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
}

function requireMasterKey(req, res, next) {
  if (isMasterKeyBypassed(req)) {
    console.log("[AUTH] requireMasterKey bypassed:", req.method, req.originalUrl);
    return next();
  }

  if (req.auth?.user?.id && isAdminRole(req.auth.user.role)) {
    return next();
  }

  const rawHeader = req.headers["x-master-key"];
  const providedRaw = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const configuredKey = String(process.env.MASTER_KEY || "").trim();
  const providedKey = providedRaw != null ? String(providedRaw).trim() : "";

  if (!configuredKey) {
    return res.status(500).json({ error: "MASTER_KEY is not configured." });
  }

  if (!providedKey) {
    console.warn("[AUTH] requireMasterKey: missing x-master-key header");
    return res.status(401).json({ error: "Unauthorized request." });
  }

  const providedBuffer = Buffer.from(providedKey);
  const configuredBuffer = Buffer.from(configuredKey);
  const isMatch =
    providedBuffer.length === configuredBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, configuredBuffer);

  if (!isMatch) {
    console.warn("[AUTH] requireMasterKey: x-master-key does not match MASTER_KEY");
    return res.status(401).json({ error: "Unauthorized request." });
  }

  return next();
}

module.exports = {
  attachCompanyContext,
  attachApiAuth,
  extractCompanyId,
  isApiRequest,
  requireMasterKey,
};
