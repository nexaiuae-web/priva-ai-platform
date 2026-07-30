const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");

const challenges = new Map();

function storeChallenge(key, challenge) {
  challenges.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
}

function getAndClearChallenge(key) {
  const entry = challenges.get(key);
  if (!entry) return null;
  challenges.delete(key);
  if (Date.now() > entry.expiresAt) return null;
  return entry.challenge;
}

function getWebAuthnConfig(req) {
  const rpName = "PRIVA AI";
  const rawOrigin = (req.headers.origin || req.headers.referer || "http://localhost:3000").replace(/\/+$/, "");
  const parsedUrl = new URL(rawOrigin);
  const rpId = process.env.RP_ID || parsedUrl.hostname;

  const origins = [parsedUrl.origin.replace(/\/+$/, "")];
  if (req.headers.origin) {
    const clean = req.headers.origin.replace(/\/+$/, "");
    if (!origins.includes(clean)) origins.push(clean);
  }
  if (req.headers.referer) {
    try {
      const parsedReferer = new URL(req.headers.referer.replace(/\/+$/, ""));
      const refererOrigin = parsedReferer.origin.replace(/\/+$/, "");
      if (!origins.includes(refererOrigin)) origins.push(refererOrigin);
    } catch (_) { /* ignore invalid referer */ }
  }

  const origin = process.env.FRONTEND_URL || origins;

  console.log("[PASSKEY DEBUG] Request Headers Origin:", req.headers.origin, "Referer:", req.headers.referer);
  console.log("[PASSKEY DEBUG] Computed Config:", { rpId, origin });

  return { rpName, rpId, origin };
}

module.exports = {
  getWebAuthnConfig,
  storeChallenge,
  getAndClearChallenge,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};
