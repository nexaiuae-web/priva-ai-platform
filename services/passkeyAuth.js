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
  const rpId = process.env.RP_ID || req.hostname || "localhost";
  const origin = process.env.FRONTEND_URL || req.headers.origin || `http://localhost:5173`;
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
