const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const FACE_ID_REQUIRED_STEP = "FACE_ID_REQUIRED";
const FULL_AUTH_REQUIRED_MESSAGE = "Full authentication required";

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

/** Short-lived Stage-1 token TTL (default 5 minutes). */
function getPreAuthExpiresIn() {
  return process.env.JWT_PRE_AUTH_EXPIRES_IN || "5m";
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

function resolveUserIdFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const id = payload.userId ?? payload.sub ?? payload.user_id;
  if (id == null || id === "") return null;
  return String(id);
}

function isFaceVerifiedPayload(payload) {
  return payload?.isFaceVerified === true;
}

function isPreAuthPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.step === FACE_ID_REQUIRED_STEP) return true;
  if (payload.token_type === "pre_auth") return true;
  return payload.isFaceVerified === false;
}

function buildBaseClaims(user, company) {
  return {
    sub: user.id,
    userId: user.id,
    username: user.username,
    role: user.role,
    company_id: user.company_id,
    company_name: company?.company_name,
  };
}

function signTokenWithClaims(claims, expiresIn) {
  const jti = `jwt_${crypto.randomBytes(12).toString("hex")}`;
  const token = jwt.sign({ ...claims, jti }, getJwtSecret(), { expiresIn });

  const decoded = jwt.decode(token);
  const expiresAt =
    decoded?.exp != null
      ? new Date(decoded.exp * 1000).toISOString()
      : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return { token, jti, expiresAt };
}

/**
 * Stage 1 — short-lived pre-auth JWT.
 * Payload includes `{ step: "FACE_ID_REQUIRED", userId }` and MUST NOT grant chat access.
 */
function signPreAuthToken(user, company) {
  return signTokenWithClaims(
    {
      ...buildBaseClaims(user, company),
      step: FACE_ID_REQUIRED_STEP,
      token_type: "pre_auth",
      isFaceVerified: false,
    },
    getPreAuthExpiresIn()
  );
}

/**
 * Stage 2 — full access JWT after successful face verification.
 * Payload includes `{ userId, isFaceVerified: true }`.
 */
function signAccessToken(user, company) {
  return signTokenWithClaims(
    {
      ...buildBaseClaims(user, company),
      token_type: "access",
      isFaceVerified: true,
    },
    getJwtExpiresIn()
  );
}

/** @deprecated Prefer signAccessToken — kept for callers that expect the old name. */
function signUserToken(user, company) {
  return signAccessToken(user, company);
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

function attachAuthFromPayload(req, payload) {
  const userId = resolveUserIdFromPayload(payload);
  if (!userId) return;

  req.auth = req.auth || {};
  req.auth.user = {
    id: userId,
    username: payload.username,
    role: payload.role,
    company_id: payload.company_id,
    company_name: payload.company_name,
  };
  req.auth.company_id = payload.company_id;
  req.auth.jti = payload.jti ? String(payload.jti) : null;
  req.auth.token_type = payload.token_type || null;
  req.auth.step = payload.step || null;
  req.auth.isFaceVerified = isFaceVerifiedPayload(payload);
  req.auth.isPreAuth = isPreAuthPayload(payload);
  req.auth.jwtPayload = payload;
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
    attachAuthFromPayload(req, payload);
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
  // Pre-auth tokens must not unlock protected APIs (admin, etc.).
  if (req.auth.isPreAuth || !req.auth.isFaceVerified) {
    return res.status(401).json({
      error: FULL_AUTH_REQUIRED_MESSAGE,
      message: FULL_AUTH_REQUIRED_MESSAGE,
    });
  }
  return next();
}

/**
 * Stage 1 gate — verify-face only accepts a valid pre_auth_token.
 */
function requirePreAuth(req, res, next) {
  if (!req.auth?.user?.id) {
    return res.status(401).json({
      error: "Authentication required.",
      hint: "Send Authorization: Bearer <pre_auth_token> from POST /api/login",
    });
  }
  if (!req.auth.isPreAuth || req.auth.isFaceVerified) {
    return res.status(401).json({
      error: "Pre-authentication token required.",
      message: "A valid pre_auth_token is required for face verification.",
      hint: "Complete POST /api/login first and send the pre_auth_token.",
    });
  }
  return next();
}

/**
 * Face verification accepts Stage-1 pre_auth_token, or an already Stage-2 access_token
 * (idempotent — used when E2E/login already issued a face-verified token).
 */
function requireVerifyFaceToken(req, res, next) {
  if (!req.auth?.user?.id) {
    return res.status(401).json({
      error: "Authentication required.",
      hint: "Send Authorization: Bearer <pre_auth_token> from POST /api/login",
    });
  }
  if (req.auth.isFaceVerified === true) {
    req.auth.alreadyFaceVerified = true;
    return next();
  }
  if (req.auth.isPreAuth) {
    req.auth.alreadyFaceVerified = false;
    return next();
  }
  return res.status(401).json({
    error: "Pre-authentication token required.",
    message: "A valid pre_auth_token is required for face verification.",
    hint: "Complete POST /api/login first and send the pre_auth_token.",
  });
}

/**
 * Stage 2 gate — chat and related routes require isFaceVerified === true.
 */
function requireFaceVerified(req, res, next) {
  if (!req.auth?.user?.id || req.auth.isFaceVerified !== true) {
    return res.status(401).json({
      error: FULL_AUTH_REQUIRED_MESSAGE,
      message: FULL_AUTH_REQUIRED_MESSAGE,
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
  if (req.auth.isPreAuth || !req.auth.isFaceVerified) {
    return res.status(401).json({
      error: FULL_AUTH_REQUIRED_MESSAGE,
      message: FULL_AUTH_REQUIRED_MESSAGE,
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
  requirePreAuth,
  requireVerifyFaceToken,
  requireFaceVerified,
  signUserToken,
  signPreAuthToken,
  signAccessToken,
  verifyUserToken,
  isJwtToken,
  isApiRequest,
  isAdminRole,
  isFaceVerifiedPayload,
  isPreAuthPayload,
  extractBearerToken,
  FACE_ID_REQUIRED_STEP,
  FULL_AUTH_REQUIRED_MESSAGE,
};
