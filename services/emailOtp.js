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
  const smtpHost = String(process.env.SMTP_HOST || "").trim();
  const port = Number(process.env.SMTP_PORT) || 587;
  const smtpUser = String(process.env.SMTP_USER || "").trim();
  const smtpPass = String(process.env.SMTP_PASS || "").trim();
  const smtpFrom = String(process.env.SMTP_FROM || smtpUser || "noreply@priva-ai.com").trim();

  if (!smtpHost || !smtpUser) {
    console.log(`[OTP] ═══════════════════════════════════════════════`);
    console.log(`[OTP] SMTP not configured — MOCK MODE`);
    console.log(`[OTP] To: ${email}`);
    console.log(`[OTP] OTP Code: ${code}`);
    console.log(`[OTP] Expires in: 10 minutes`);
    console.log(`[OTP] ═══════════════════════════════════════════════`);
    return { sent: true, mock: true };
  }

  try {
    const nodemailer = require("nodemailer");
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port,
      secure: port === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
      connectionTimeout: 8000,
      greetingTimeout: 5000,
      socketTimeout: 8000,
    });

    await transporter.sendMail({
      from: smtpFrom,
      to: email,
      subject: "PRIVA-AI — Your Verification Code",
      text: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.\n\nIf you did not request this, please ignore this email.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #333;">PRIVA-AI Verification</h2>
          <p style="color: #555; font-size: 16px;">Your verification code is:</p>
          <div style="background: #f4f4f4; border-radius: 8px; padding: 16px; text-align: center; margin: 16px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #333;">${code}</span>
          </div>
          <p style="color: #888; font-size: 14px;">This code expires in 10 minutes.</p>
          <p style="color: #888; font-size: 14px;">If you did not request this, please ignore this email.</p>
        </div>
      `,
    });

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
