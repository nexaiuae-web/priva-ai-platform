const EmailTrialUser = require("../models/EmailTrialUser");
const { normalizeEmail, buildTrialCompanyId } = require("./emailOtp");

const TRIAL_QUERIES_LIMIT = 5;
const TRIAL_MAX_STORAGE_BYTES = 5 * 1024 * 1024;
const TRIAL_WINDOW_MS = 24 * 60 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function applyWindowResetIfNeeded(user, nowMs) {
  const resetAt = Date.parse(String(user.queries_reset_at || ""));
  if (!Number.isFinite(resetAt) || nowMs - resetAt >= TRIAL_WINDOW_MS) {
    user.queries_used = 0;
    user.queries_reset_at = new Date(nowMs);
  }
}

async function getOrCreateTrialUser(email) {
  const normalized = normalizeEmail(email);
  const now = new Date();
  let doc = await EmailTrialUser.findOne({ email: normalized }).lean();

  if (!doc) {
    const created = await EmailTrialUser.create({
      email: normalized,
      queries_used: 0,
      queries_reset_at: now,
      storage_used_bytes: 0,
      created_at: now,
      updated_at: now,
    });
    doc = created.toObject();
  }

  const user = { ...doc };
  applyWindowResetIfNeeded(user, Date.now());
  return user;
}

async function getQuota(email) {
  const normalized = normalizeEmail(email);
  const nowMs = Date.now();
  let doc = await EmailTrialUser.findOne({ email: normalized }).lean();

  if (!doc) {
    return {
      email: normalized,
      queries_used: 0,
      queries_limit: TRIAL_QUERIES_LIMIT,
      remaining_queries: TRIAL_QUERIES_LIMIT,
      storage_used_bytes: 0,
      max_storage_bytes: TRIAL_MAX_STORAGE_BYTES,
      storage_remaining_bytes: TRIAL_MAX_STORAGE_BYTES,
      queries_reset_at: nowIso(),
      window_reset_at: new Date(nowMs + TRIAL_WINDOW_MS).toISOString(),
      company_id: buildTrialCompanyId(normalized),
    };
  }

  const user = { ...doc };
  applyWindowResetIfNeeded(user, nowMs);

  if (user.queries_used !== doc.queries_used || user.queries_reset_at !== doc.queries_reset_at) {
    await EmailTrialUser.updateOne(
      { email: normalized },
      {
        $set: {
          queries_used: user.queries_used,
          queries_reset_at: user.queries_reset_at,
          updated_at: nowIso(),
        },
      }
    );
  }

  const queriesUsed = Math.max(0, Number(user.queries_used) || 0);
  const storageUsed = Math.max(0, Number(user.storage_used_bytes) || 0);
  const resetAtMs = Date.parse(String(user.queries_reset_at || ""));

  return {
    email: normalized,
    queries_used: queriesUsed,
    queries_limit: TRIAL_QUERIES_LIMIT,
    remaining_queries: Math.max(0, TRIAL_QUERIES_LIMIT - queriesUsed),
    storage_used_bytes: storageUsed,
    max_storage_bytes: TRIAL_MAX_STORAGE_BYTES,
    storage_remaining_bytes: Math.max(0, TRIAL_MAX_STORAGE_BYTES - storageUsed),
    queries_reset_at: user.queries_reset_at ? new Date(resetAtMs).toISOString() : nowIso(),
    window_reset_at: new Date(resetAtMs + TRIAL_WINDOW_MS).toISOString(),
    company_id: buildTrialCompanyId(normalized),
  };
}

async function checkQueryAllowed(email) {
  const normalized = normalizeEmail(email);
  const nowMs = Date.now();
  const doc = await EmailTrialUser.findOne({ email: normalized }).lean();

  if (!doc) {
    return { allowed: true, remaining: TRIAL_QUERIES_LIMIT, retryAfterMs: 0 };
  }

  const user = { ...doc };
  applyWindowResetIfNeeded(user, nowMs);

  const queriesUsed = Math.max(0, Number(user.queries_used) || 0);
  if (queriesUsed >= TRIAL_QUERIES_LIMIT) {
    const resetAtMs = Date.parse(String(user.queries_reset_at || ""));
    const retryAfterMs = Math.max(0, resetAtMs + TRIAL_WINDOW_MS - nowMs);
    return { allowed: false, remaining: 0, retryAfterMs };
  }

  return {
    allowed: true,
    remaining: TRIAL_QUERIES_LIMIT - queriesUsed,
    retryAfterMs: 0,
  };
}

async function deductQuery(email) {
  const normalized = normalizeEmail(email);
  const nowMs = Date.now();
  const now = new Date(nowMs);

  let doc = await EmailTrialUser.findOne({ email: normalized });
  if (!doc) {
    doc = await EmailTrialUser.create({
      email: normalized,
      queries_used: 1,
      queries_reset_at: now,
      storage_used_bytes: 0,
      created_at: now,
      updated_at: now,
    });
    return { queriesUsed: 1, remaining: TRIAL_QUERIES_LIMIT - 1 };
  }

  applyWindowResetIfNeeded(doc, nowMs);
  const nextCount = (Number(doc.queries_used) || 0) + 1;
  doc.queries_used = nextCount;
  doc.updated_at = now;
  await doc.save();

  return {
    queriesUsed: nextCount,
    remaining: Math.max(0, TRIAL_QUERIES_LIMIT - nextCount),
  };
}

async function deductStorage(email, bytes) {
  const normalized = normalizeEmail(email);
  const incoming = Math.max(0, Math.floor(Number(bytes) || 0));
  const now = new Date();

  let doc = await EmailTrialUser.findOne({ email: normalized });
  if (!doc) {
    doc = await EmailTrialUser.create({
      email: normalized,
      queries_used: 0,
      queries_reset_at: now,
      storage_used_bytes: incoming,
      created_at: now,
      updated_at: now,
    });
    return {
      storageUsedBytes: incoming,
      exceeded: incoming > TRIAL_MAX_STORAGE_BYTES,
    };
  }

  const nextUsed = (Number(doc.storage_used_bytes) || 0) + incoming;
  doc.storage_used_bytes = nextUsed;
  doc.updated_at = now;
  await doc.save();

  return {
    storageUsedBytes: nextUsed,
    exceeded: nextUsed > TRIAL_MAX_STORAGE_BYTES,
  };
}

async function enforceTrialChatQuota(req, res, next) {
  if (req.auth?.token_type !== "trial_access" || !req.auth?.jwtPayload?.is_trial) {
    return next();
  }

  const email = req.auth.jwtPayload?.email || req.auth.user?.id;
  if (!email) {
    return res.status(401).json({
      error: "TRIAL_EMAIL_REQUIRED",
      code: "TRIAL_EMAIL_REQUIRED",
      message: "Trial token must include a valid email.",
    });
  }

  try {
    const check = await checkQueryAllowed(email);
    if (!check.allowed) {
      return res.status(429).json({
        error: "TRIAL_LIMIT_REACHED",
        code: "TRIAL_LIMIT_REACHED",
        message: `Free Trial daily query limit reached (${TRIAL_QUERIES_LIMIT} per 24 hours).`,
        retry_after_ms: check.retryAfterMs,
        retry_after_seconds: Math.ceil(check.retryAfterMs / 1000),
      });
    }

    const result = await deductQuery(email);
    req.trialUser = {
      email,
      company_id: buildTrialCompanyId(email),
      queriesUsed: result.queriesUsed,
      remainingQueries: result.remaining,
    };

    return next();
  } catch (error) {
    console.error("[TRIAL-EMAIL] enforceTrialChatQuota error:", error.message);
    return res.status(500).json({
      error: "TRIAL_QUOTA_CHECK_FAILED",
      code: "TRIAL_QUOTA_CHECK_FAILED",
      message: "Trial quota check failed.",
    });
  }
}

async function enforceTrialUploadQuota(req, res, next) {
  if (req.auth?.token_type !== "trial_access" || !req.auth?.jwtPayload?.is_trial) {
    return next();
  }

  const email = req.auth.jwtPayload?.email || req.auth.user?.id;
  if (!email) {
    return res.status(401).json({
      error: "TRIAL_EMAIL_REQUIRED",
      code: "TRIAL_EMAIL_REQUIRED",
      message: "Trial token must include a valid email.",
    });
  }

  const incomingBytes = Number(req.file?.size || 0);

  try {
    const result = await deductStorage(email, incomingBytes);
    if (result.exceeded) {
      try {
        const fs = require("fs");
        if (req.file?.path && fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch { /* ignore */ }

      const quota = await getQuota(email);
      return res.status(400).json({
        error: "TRIAL_STORAGE_EXCEEDED",
        code: "TRIAL_STORAGE_EXCEEDED",
        message: "Free Trial storage quota exceeded (5MB max).",
        trial: {
          storage_used_bytes: quota.storage_used_bytes,
          max_storage_bytes: quota.max_storage_bytes,
          storage_remaining_bytes: quota.storage_remaining_bytes,
        },
      });
    }

    req.trialUser = {
      email,
      company_id: buildTrialCompanyId(email),
      storageUsedBytes: result.storageUsedBytes,
    };

    return next();
  } catch (error) {
    console.error("[TRIAL-EMAIL] enforceTrialUploadQuota error:", error.message);
    return res.status(500).json({
      error: "TRIAL_QUOTA_CHECK_FAILED",
      code: "TRIAL_QUOTA_CHECK_FAILED",
      message: "Trial upload quota check failed.",
    });
  }
}

module.exports = {
  TRIAL_QUERIES_LIMIT,
  TRIAL_MAX_STORAGE_BYTES,
  TRIAL_WINDOW_MS,
  getOrCreateTrialUser,
  getQuota,
  checkQueryAllowed,
  deductQuery,
  deductStorage,
  enforceTrialChatQuota,
  enforceTrialUploadQuota,
};
