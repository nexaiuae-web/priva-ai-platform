const crypto = require("crypto");
const jwt = require("jsonwebtoken");

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || process.env.MASTER_KEY || "").trim();
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET or MASTER_KEY must be configured for authentication.");
  }
  console.warn(
    "[AUTH] JWT_SECRET / MASTER_KEY not set — using development-only JWT secret."
  );
  return "priva-dev-jwt-secret-change-me";
}

function getJwtExpiresIn() {
  return process.env.JWT_EXPIRES_IN || "24h";
}

function isJwtToken(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function isAdminRole(role) {
  const normalized = String(role || "").trim().toLowerCase();
  return normalized === "admin" || normalized === "administrator";
}

function getAuthorizationHeader(req) {
  const raw = req.headers.authorization ?? req.headers.Authorization;
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return raw;
}

/** Parse Bearer JWT from Authorization (handles extra whitespace). */
function extractBearerToken(req) {
  const authHeader = getAuthorizationHeader(req);
  if (!authHeader || typeof authHeader !== "string") {
    return null;
  }

  const trimmed = authHeader.trim();
  const bearerMatch = /^Bearer\s+(.+)$/i.exec(trimmed);
  if (bearerMatch) {
    return bearerMatch[1].trim();
  }

  if (isJwtToken(trimmed)) {
    return trimmed;
  }

  return null;
}

function signUserToken(user, company) {
  const jti = `jwt_${crypto.randomBytes(12).toString("hex")}`;
  const token = jwt.sign(
    {
      sub: user.id,
      username: user.username,
      role: user.role,
      company_id: user.company_id,
      company_name: company.company_name,
      jti,
    },
    getJwtSecret(),
    { expiresIn: getJwtExpiresIn() }
  );

  const decoded = jwt.decode(token);
  const expiresAt =
    decoded?.exp != null
      ? new Date(decoded.exp * 1000).toISOString()
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return { token, jti, expiresAt };
}

function verifyUserToken(token) {
  return jwt.verify(token, getJwtSecret());
}

/** True when the request targets a JSON API route (not static/HTML). */
function isApiRequest(req) {
  const urlPath = String(req.originalUrl || req.url || "").split("?")[0];
  if (urlPath.startsWith("/api") || urlPath.startsWith("/admin")) {
    return true;
  }
  const mounted = `${req.baseUrl || ""}${req.path || ""}`.split("?")[0];
  return mounted.startsWith("/api") || mounted.startsWith("/admin");
}

function attachJwtUser(req, _res, next) {
  if (!isApiRequest(req)) {
    return next();
  }

  const token = extractBearerToken(req);
  if (!token || !isJwtToken(token)) {
    return next();
  }

  try {
    const payload = verifyUserToken(token);
    req.auth = req.auth || {};
    req.auth.user = {
      id: payload.sub,
      username: payload.username,
      role: payload.role,
      company_id: payload.company_id,
      company_name: payload.company_name,
    };
    req.auth.company_id = payload.company_id;
  } catch (error) {
    console.warn("[AUTH] Invalid JWT:", error.message);
  }

  return next();
}

function requireAuth(req, res, next) {
  if (!req.auth?.user?.id) {
    return res.status(401).json({
      error: "Authentication required.",
      hint: "Send Authorization: Bearer <token> from POST /api/login",
    });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.auth?.user?.id) {
    return res.status(401).json({
      error: "Authentication required.",
      hint: "Send Authorization: Bearer <token> from POST /api/login",
    });
  }
  if (!isAdminRole(req.auth.user.role)) {
    return res.status(403).json({
      error: "Admin role required.",
      role: req.auth.user.role,
    });
  }
  return next();
}

module.exports = {
  attachJwtUser,
  requireAuth,
  requireAdmin,
  signUserToken,
  verifyUserToken,
  isJwtToken,
  isApiRequest,
  isAdminRole,
  extractBearerToken,
};
