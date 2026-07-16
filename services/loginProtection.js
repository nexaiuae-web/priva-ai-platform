/**
 * Login brute-force / credential-stuffing protection (per IP).
 * Soft lockout (CAPTCHA) after 3 failures; hard lockout (429) after 5+ with escalating cooldown.
 */

const SOFT_LOCK_THRESHOLD = 3;
const HARD_LOCK_THRESHOLD = 5;
const BASE_LOCK_MINUTES = 5;
const ENTRY_TTL_MS = 60 * 60 * 1000;

/** @type {Map<string, { failures: number, lockedUntil: number, lastFailureAt: number }>} */
const attemptStore = new Map();

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const first = String(Array.isArray(forwarded) ? forwarded[0] : forwarded)
      .split(",")[0]
      .trim();
    if (first) return first;
  }

  const realIp = req.headers["x-real-ip"];
  if (realIp) {
    const value = String(Array.isArray(realIp) ? realIp[0] : realIp).trim();
    if (value) return value;
  }

  return req.ip || req.socket?.remoteAddress || "unknown";
}

function pruneExpiredEntries(now = Date.now()) {
  for (const [ip, record] of attemptStore.entries()) {
    const locked = record.lockedUntil > now;
    const idleMs = now - (record.lastFailureAt || 0);
    if (!locked && idleMs > ENTRY_TTL_MS) {
      attemptStore.delete(ip);
    }
  }
}

function getAttemptRecord(ip) {
  let record = attemptStore.get(ip);
  if (!record) {
    record = { failures: 0, lockedUntil: 0, lastFailureAt: 0 };
    attemptStore.set(ip, record);
  }
  return record;
}

/**
 * Lock duration: 5 min at 5 failures, 10 min at 10, 15 min at 15, etc.
 */
function getHardLockDurationMs(failures) {
  const blocks = Math.floor(failures / HARD_LOCK_THRESHOLD);
  return Math.max(blocks, 1) * BASE_LOCK_MINUTES * 60 * 1000;
}

/**
 * Gate before credential checks. Returns blocked status or captcha requirement.
 */
function assertLoginAllowed(ip) {
  pruneExpiredEntries();
  const record = getAttemptRecord(ip);
  const now = Date.now();

  if (record.lockedUntil > now) {
    const retryAfterSec = Math.ceil((record.lockedUntil - now) / 1000);
    console.warn(
      "[LOGIN/PROTECT] Hard lockout active | ip:",
      ip,
      "| retryAfterSec:",
      retryAfterSec,
      "| failures:",
      record.failures
    );
    return {
      blocked: true,
      status: 429,
      retryAfterSec,
      body: {
        success: false,
        message: "Too many failed login attempts. Please try again later.",
        retryAfterSec,
      },
    };
  }

  if (record.lockedUntil && record.lockedUntil <= now) {
    record.lockedUntil = 0;
  }

  return {
    blocked: false,
    requireCaptcha: record.failures >= SOFT_LOCK_THRESHOLD,
    failures: record.failures,
  };
}

function recordLoginFailure(ip) {
  const record = getAttemptRecord(ip);
  record.failures += 1;
  record.lastFailureAt = Date.now();

  let isHardLocked = false;
  if (
    record.failures >= HARD_LOCK_THRESHOLD &&
    record.failures % HARD_LOCK_THRESHOLD === 0
  ) {
    const durationMs = getHardLockDurationMs(record.failures);
    record.lockedUntil = Date.now() + durationMs;
    isHardLocked = true;
    console.warn(
      "[LOGIN/PROTECT] Hard lockout applied | ip:",
      ip,
      "| failures:",
      record.failures,
      "| lockMinutes:",
      durationMs / 60000
    );
  } else if (record.failures >= SOFT_LOCK_THRESHOLD) {
    console.warn(
      "[LOGIN/PROTECT] Soft lockout (CAPTCHA required) | ip:",
      ip,
      "| failures:",
      record.failures
    );
  }

  return {
    failures: record.failures,
    requireCaptcha: record.failures >= SOFT_LOCK_THRESHOLD,
    lockedUntil: record.lockedUntil,
    isHardLocked: isHardLocked || record.lockedUntil > Date.now(),
  };
}

function clearLoginFailures(ip) {
  if (attemptStore.has(ip)) {
    attemptStore.delete(ip);
    console.log("[LOGIN/PROTECT] Cleared failure counters | ip:", ip);
  }
}

/**
 * Verify Cloudflare Turnstile or Google reCAPTCHA v3 token from req.body.captchaToken.
 * Prefers TURNSTILE_SECRET_KEY; falls back to RECAPTCHA_SECRET_KEY.
 * CAPTCHA_DEV_BYPASS=true allows a pass-through when no secret is configured (local/E2E only).
 */
async function verifyCaptchaToken(token, ip) {
  const trimmed = String(token || "").trim();
  if (!trimmed) {
    return false;
  }

  const turnstileSecret = String(process.env.TURNSTILE_SECRET_KEY || "").trim();
  const recaptchaSecret = String(process.env.RECAPTCHA_SECRET_KEY || "").trim();
  const devBypass = /^true$/i.test(
    String(process.env.CAPTCHA_DEV_BYPASS || "").trim()
  );

  if (!turnstileSecret && !recaptchaSecret) {
    if (devBypass) {
      console.warn(
        "[LOGIN/PROTECT] CAPTCHA_DEV_BYPASS=true — accepting token without provider verify"
      );
      return true;
    }
    console.error(
      "[LOGIN/PROTECT] CAPTCHA required but neither TURNSTILE_SECRET_KEY nor RECAPTCHA_SECRET_KEY is set"
    );
    return false;
  }

  try {
    if (turnstileSecret) {
      return await verifyTurnstile(trimmed, turnstileSecret, ip);
    }
    return await verifyRecaptcha(trimmed, recaptchaSecret, ip);
  } catch (error) {
    console.error("[LOGIN/PROTECT] CAPTCHA verify error:", error.message);
    return false;
  }
}

async function verifyTurnstile(token, secret, ip) {
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (ip && ip !== "unknown") {
    body.set("remoteip", ip);
  }

  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }
  );

  if (!response.ok) {
    console.warn(
      "[LOGIN/PROTECT] Turnstile HTTP error:",
      response.status,
      response.statusText
    );
    return false;
  }

  const data = await response.json();
  if (!data.success) {
    console.warn(
      "[LOGIN/PROTECT] Turnstile rejected | codes:",
      data["error-codes"] || []
    );
  }
  return Boolean(data.success);
}

async function verifyRecaptcha(token, secret, ip) {
  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (ip && ip !== "unknown") {
    body.set("remoteip", ip);
  }

  const response = await fetch(
    "https://www.google.com/recaptcha/api/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }
  );

  if (!response.ok) {
    console.warn(
      "[LOGIN/PROTECT] reCAPTCHA HTTP error:",
      response.status,
      response.statusText
    );
    return false;
  }

  const data = await response.json();
  if (!data.success) {
    console.warn(
      "[LOGIN/PROTECT] reCAPTCHA rejected | codes:",
      data["error-codes"] || []
    );
    return false;
  }

  // reCAPTCHA v3 optional score gate (default 0.5)
  if (typeof data.score === "number") {
    const minScore = Number(process.env.RECAPTCHA_MIN_SCORE || 0.5);
    if (data.score < minScore) {
      console.warn(
        "[LOGIN/PROTECT] reCAPTCHA score too low:",
        data.score,
        "<",
        minScore
      );
      return false;
    }
  }

  return true;
}

module.exports = {
  getClientIp,
  assertLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
  verifyCaptchaToken,
  SOFT_LOCK_THRESHOLD,
  HARD_LOCK_THRESHOLD,
};
