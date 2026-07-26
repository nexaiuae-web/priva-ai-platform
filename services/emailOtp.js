const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const EmailOTP = require("../models/EmailOTP");
const EmailTrialUser = require("../models/EmailTrialUser");

const OTP_LENGTH = 6;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RATE_LIMIT_MAX = 3;
const OTP_RATE_WINDOW_MS = 10 * 60 * 1000;
const TRIAL_JWT_EXPIRES_IN = "24h";

function getJwtSecret() {
  const secret = String(process.env.JWT_SECRET || process.env.MASTER_KEY || "").trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET or MASTER_KEY must be configured for authentication.");
  }
  return "priva-dev-jwt-secret-change-me";
}

function generateOtp() {
  const bytes = crypto.randomBytes(OTP_LENGTH);
  let code = "";
  for (let i = 0; i < OTP_LENGTH; i++) {
    code += String(bytes[i] % 10);
  }
  return code;
}

function isEmailValid(email) {
  if (!email || typeof email !== "string") return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function buildTrialCompanyId(email) {
  const hash = crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
  return `trial_${hash.slice(0, 24)}`;
}

async function checkOtpRateLimit(email) {
  const normalized = normalizeEmail(email);
  const since = new Date(Date.now() - OTP_RATE_WINDOW_MS);
  const count = await EmailOTP.countDocuments({
    email: normalized,
    created_at: { $gte: since },
  });
  if (count >= OTP_RATE_LIMIT_MAX) {
    const oldest = await EmailOTP.findOne({ email: normalized, created_at: { $gte: since } })
      .sort({ created_at: 1 })
      .lean();
    const retryAfterMs = oldest
      ? Math.max(0, Date.parse(oldest.created_at) + OTP_RATE_WINDOW_MS - Date.now())
      : OTP_RATE_WINDOW_MS;
    return { allowed: false, retryAfterMs };
  }
  return { allowed: true };
}

async function storeOtp(email) {
  const normalized = normalizeEmail(email);
  const code = generateOtp();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);

  await EmailOTP.updateMany(
    { email: normalized, used: false },
    { $set: { used: true } }
  );

  await EmailOTP.create({
    email: normalized,
    code,
    expires_at: expiresAt,
    used: false,
    created_at: now,
  });

  return { code, expiresAt };
}

async function verifyOtp(email, otpCode) {
  const normalized = normalizeEmail(email);
  const codeStr = String(otpCode || "").trim();

  if (!/^\d{6}$/.test(codeStr)) {
    return { valid: false, reason: "OTP must be a 6-digit code." };
  }

  const now = new Date();
  const record = await EmailOTP.findOne({
    email: normalized,
    code: codeStr,
    used: false,
    expires_at: { $gt: now },
  }).sort({ created_at: -1 }).lean();

  if (!record) {
    return { valid: false, reason: "Invalid or expired OTP." };
  }

  await EmailOTP.updateOne(
    { _id: record._id },
    { $set: { used: true } }
  );

  return { valid: true };
}

async function sendOtpEmail(email, code) {
  const brevoKey = String(process.env.BREVO_API_KEY || process.env.SMTP_PASS || "").trim();

  if (!brevoKey) {
    console.log(`[OTP] ═══════════════════════════════════════════════`);
    console.log(`[OTP] BREVO_API_KEY not configured — MOCK MODE`);
    console.log(`[OTP] To: ${email}`);
    console.log(`[OTP] OTP Code: ${code}`);
    console.log(`[OTP] Expires in: 10 minutes`);
    console.log(`[OTP] ═══════════════════════════════════════════════`);
    return { sent: true, mock: true };
  }

  try {
    const payload = {
      sender: { name: process.env.SENDER_NAME || "PRIVA AI", email: process.env.SENDER_EMAIL || "privaai.uae@gmail.com" },
      to: [{ email }],
      subject: "Your Verification Code - PRIVA AI",
      htmlContent:
        `<p>Your verification code is: <strong>${code}</strong></p>`,
    };

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": brevoKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[SMTP ERROR] Brevo API ${response.status} ${response.statusText} —`,
        errorBody
      );
      throw new Error(`Brevo API error: ${response.status}`);
    }

    console.log(`[OTP] Email sent to ${email}`);
    return { sent: true, mock: false };
  } catch (err) {
    console.error(`[SMTP ERROR]`, err);
    console.log(`[OTP] ═══════════════════════════════════════════════`);
    console.log(`[OTP] Falling back to MOCK MODE`);
    console.log(`[OTP] To: ${email}`);
    console.log(`[OTP] OTP Code: ${code}`);
    console.log(`[OTP] Expires in: 10 minutes`);
    console.log(`[OTP] ═══════════════════════════════════════════════`);
    return { sent: true, mock: true };
  }
}

async function signTrialToken(email) {
  const normalized = normalizeEmail(email);
  const trialCompanyId = buildTrialCompanyId(normalized);
  const jti = `jwt_${crypto.randomBytes(12).toString("hex")}`;

  const payload = {
    sub: normalized,
    email: normalized,
    token_type: "trial_access",
    is_trial: true,
    company_id: trialCompanyId,
    jti,
  };

  const token = jwt.sign(payload, getJwtSecret(), { expiresIn: TRIAL_JWT_EXPIRES_IN });
  const decoded = jwt.decode(token);
  const expiresAt = decoded?.exp
    ? new Date(decoded.exp * 1000).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  return { token, jti, expiresAt, company_id: trialCompanyId };
}

function isTrialAccessToken(payload) {
  return payload?.token_type === "trial_access" && payload?.is_trial === true;
}

module.exports = {
  OTP_LENGTH,
  OTP_TTL_MS,
  OTP_RATE_LIMIT_MAX,
  OTP_RATE_WINDOW_MS,
  generateOtp,
  isEmailValid,
  normalizeEmail,
  buildTrialCompanyId,
  checkOtpRateLimit,
  storeOtp,
  verifyOtp,
  sendOtpEmail,
  signTrialToken,
  isTrialAccessToken,
  getJwtSecret,
};
