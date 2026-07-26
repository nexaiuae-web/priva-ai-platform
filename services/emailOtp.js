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
      htmlContent: `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#0f172a;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f172a;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#1e293b;border-radius:16px;border:1px solid #334155;overflow:hidden;">

        <!-- Header -->
        <tr><td style="padding:36px 40px 24px;text-align:center;">
          <div style="font-size:26px;font-weight:700;letter-spacing:1px;background:linear-gradient(135deg,#60a5fa,#a78bfa,#f472b6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">
            PRIVA AI
          </div>
          <div style="margin-top:6px;font-size:12px;color:#64748b;letter-spacing:3px;text-transform:uppercase;">
            Secure Verification
          </div>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:0 40px;">
          <div style="height:1px;background:linear-gradient(90deg,transparent,#334155,transparent);"></div>
        </td></tr>

        <!-- Title -->
        <tr><td style="padding:32px 40px 8px;text-align:center;">
          <h1 style="margin:0;font-size:22px;font-weight:600;color:#f1f5f9;">
            Verification Code
          </h1>
          <p style="margin:6px 0 0;font-size:15px;color:#94a3b8;">
            رمز التحقق
          </p>
        </td></tr>

        <!-- Subtext -->
        <tr><td style="padding:12px 40px 0;text-align:center;">
          <p style="margin:0;font-size:14px;line-height:22px;color:#94a3b8;">
            Use the code below to activate your free trial. This code is required to verify your email address and unlock full access.
          </p>
        </td></tr>

        <!-- OTP Box -->
        <tr><td style="padding:28px 40px 0;" align="center">
          <div style="display:inline-block;padding:18px 44px;background-color:#0f172a;border:2px solid #60a5fa;border-radius:12px;box-shadow:0 0 20px rgba(96,165,250,0.15);">
            <span style="font-family:'Courier New',Courier,monospace;font-size:36px;font-weight:700;letter-spacing:14px;color:#f1f5f9;">
              ${code}
            </span>
          </div>
        </td></tr>

        <!-- Expiry -->
        <tr><td style="padding:20px 40px 0;text-align:center;">
          <p style="margin:0;font-size:13px;color:#64748b;">
            This code expires in <strong style="color:#94a3b8;">10 minutes</strong>.
          </p>
        </td></tr>

        <!-- Divider -->
        <tr><td style="padding:28px 40px 0;">
          <div style="height:1px;background:linear-gradient(90deg,transparent,#334155,transparent);"></div>
        </td></tr>

        <!-- Security Note -->
        <tr><td style="padding:20px 40px 0;" align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" style="background-color:#0f172a;border-radius:8px;border:1px solid #334155;">
            <tr><td style="padding:12px 20px;">
              <p style="margin:0;font-size:12px;line-height:18px;color:#64748b;text-align:center;">
                &#9888; If you didn&rsquo;t request this code, please ignore this email. Your account will not be affected.
              </p>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:24px 40px 32px;text-align:center;">
          <p style="margin:0;font-size:11px;color:#475569;">
            &copy; 2026 PRIVA AI &mdash; All rights reserved.
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`.trim(),
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
