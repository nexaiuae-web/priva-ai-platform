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
  const rawOrigin = req.headers.origin || req.headers.referer || "http://localhost:3000";
  const parsedUrl = new URL(rawOrigin);
  const rpId = process.env.RP_ID || parsedUrl.hostname;
  const origin = process.env.FRONTEND_URL || parsedUrl.origin;
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
