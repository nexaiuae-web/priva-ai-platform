const crypto = require("crypto");
const { extractBearerToken } = require("./jwtAuth");
const TrialTracker = require("../models/TrialTracker");

const TRIAL_MAX_REQUESTS_PER_24H = 5;
const TRIAL_MAX_STORAGE_BYTES = 5 * 1024 * 1024;
const TRIAL_WINDOW_MS = 24 * 60 * 60 * 1000;

const INVALID_FINGERPRINT_VALUES = new Set([
  "",
  "undefined",
  "null",
  "trial_undefined",
  "nocanvas",
  "canvaserr",
]);

function readPlanModeHeader(req) {
  const raw = req.headers["x-plan-mode"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || "").trim().toLowerCase();
}

function isTrialGuestToken(req) {
  const token = extractBearerToken(req);
  return token === "trial_guest";
}

function isTrialModeRequest(req) {
  const mode = readPlanModeHeader(req);
  if (mode === "free_trial" || mode === "trial") return true;
  return isTrialGuestToken(req);
}

function isValidTrialCompanyId(companyId) {
  const id = String(companyId || "").trim();
  if (!id) return false;
  if (id === "default" || id === "trial_undefined") return false;
  if (!id.startsWith("trial_")) return false;
  if (id.includes("undefined")) return false;
  return true;
}

function getFingerprintFromRequest(req) {
  const raw = req.headers["x-device-fingerprint"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const fingerprint = String(value || "").trim();
  if (!fingerprint) return null;
  if (INVALID_FINGERPRINT_VALUES.has(fingerprint.toLowerCase())) return null;
  if (fingerprint.length < 16) return null;
  return fingerprint;
}

function hashFingerprint(fingerprint) {
  return crypto.createHash("sha256").update(String(fingerprint)).digest("hex");
}

function buildTrialCompanyIdFromFingerprint(fingerprint) {
  const hash = hashFingerprint(fingerprint);
  return `trial_${hash.slice(0, 24)}`;
}

function getTrialCompanyIdForRequest(req) {
  if (!isTrialModeRequest(req)) return null;
  const fingerprint = getFingerprintFromRequest(req);
  if (!fingerprint) return null;
  return buildTrialCompanyIdFromFingerprint(fingerprint);
}

function sanitizeStorageBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function createTrialTrackerRecord(fingerprint, nowIso) {
  return {
    device_fingerprint: String(fingerprint),
    request_count: 0,
    storage_used_bytes: 0,
    first_request_at: nowIso,
    updated_at: nowIso,
  };
}

function applyTrialWindowResetIfNeeded(record, nowMs, nowIso) {
  const firstMs = Date.parse(String(record.first_request_at || ""));
  if (!Number.isFinite(firstMs) || nowMs - firstMs >= TRIAL_WINDOW_MS) {
    record.request_count = 0;
    record.first_request_at = nowIso;
  }
}

function safeIsoOrNull(value) {
  const ms = Date.parse(String(value || ""));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function normalizeTrackerRecord(tracker) {
  return {
    ...tracker,
    request_count: Math.max(0, Number.parseInt(String(tracker.request_count || 0), 10) || 0),
    storage_used_bytes: sanitizeStorageBytes(tracker.storage_used_bytes),
    first_request_at: safeIsoOrNull(tracker.first_request_at),
    updated_at: safeIsoOrNull(tracker.updated_at),
  };
}

async function getOrCreateTrialTrackerByFingerprint(fingerprint) {
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const fingerprintStr = String(fingerprint);
  let trackerDoc = await TrialTracker.findOne({ device_fingerprint: fingerprintStr }).lean();

  if (!trackerDoc) {
    const created = await TrialTracker.create(createTrialTrackerRecord(fingerprintStr, nowIso));
    trackerDoc = created.toObject();
  }

  const tracker = normalizeTrackerRecord(trackerDoc);
  applyTrialWindowResetIfNeeded(tracker, nowMs, nowIso);
  tracker.updated_at = nowIso;

  await TrialTracker.updateOne(
    { device_fingerprint: fingerprintStr },
    {
      $set: {
        request_count: tracker.request_count,
        storage_used_bytes: tracker.storage_used_bytes,
        first_request_at: tracker.first_request_at,
        updated_at: tracker.updated_at,
      },
    }
  );
  return tracker;
}

function buildTrialSnapshot(tracker) {
  const usedRequests = Math.max(0, Number(tracker.request_count) || 0);
  const usedStorageBytes = sanitizeStorageBytes(tracker.storage_used_bytes);
  return {
    request_count: usedRequests,
    request_limit: TRIAL_MAX_REQUESTS_PER_24H,
    remaining_requests: Math.max(0, TRIAL_MAX_REQUESTS_PER_24H - usedRequests),
    storage_used_bytes: usedStorageBytes,
    storage_limit_bytes: TRIAL_MAX_STORAGE_BYTES,
    storage_remaining_bytes: Math.max(0, TRIAL_MAX_STORAGE_BYTES - usedStorageBytes),
    first_request_at: tracker.first_request_at || null,
    window_reset_at: tracker.first_request_at
      ? new Date(Date.parse(tracker.first_request_at) + TRIAL_WINDOW_MS).toISOString()
      : null,
  };
}

async function enforceTrialChatLimit(req, res) {
  if (!isTrialModeRequest(req)) return { ok: true, tracker: null };

  const fingerprint = getFingerprintFromRequest(req);
  if (!fingerprint) {
    return {
      ok: false,
      response: res.status(400).json({
        error: "TRIAL_FINGERPRINT_REQUIRED",
        code: "TRIAL_FINGERPRINT_REQUIRED",
        message:
          "Free Trial requires a verified device fingerprint header (x-device-fingerprint).",
      }),
    };
  }

  const tracker = await getOrCreateTrialTrackerByFingerprint(fingerprint);
  if (tracker.request_count >= TRIAL_MAX_REQUESTS_PER_24H) {
    return {
      ok: false,
      response: res.status(429).json({
        error: "TRIAL_LIMIT_REACHED",
        code: "TRIAL_LIMIT_REACHED",
        message: "Free Trial daily question limit reached (5 per 24 hours).",
        trial: buildTrialSnapshot(tracker),
      }),
    };
  }

  const nextRequestCount =
    Math.max(0, Number.parseInt(String(tracker.request_count || 0), 10) || 0) + 1;
  const updatedAt = new Date().toISOString();
  await TrialTracker.updateOne(
    { device_fingerprint: String(fingerprint) },
    {
      $set: {
        request_count: nextRequestCount,
        updated_at: updatedAt,
      },
    }
  );

  return {
    ok: true,
    tracker: {
      ...tracker,
      request_count: nextRequestCount,
      updated_at: updatedAt,
    },
  };
}

async function enforceTrialUploadStorageLimit(req, res, incomingBytes) {
  if (!isTrialModeRequest(req)) return { ok: true, tracker: null };
  const fingerprint = getFingerprintFromRequest(req);
  if (!fingerprint) {
    return {
      ok: false,
      response: res.status(400).json({
        error: "TRIAL_FINGERPRINT_REQUIRED",
        code: "TRIAL_FINGERPRINT_REQUIRED",
        message:
          "Free Trial requires a verified device fingerprint header (x-device-fingerprint).",
      }),
    };
  }

  const tracker = await getOrCreateTrialTrackerByFingerprint(fingerprint);
  const nextUsed = sanitizeStorageBytes(tracker.storage_used_bytes) + sanitizeStorageBytes(incomingBytes);
  if (nextUsed > TRIAL_MAX_STORAGE_BYTES) {
    return {
      ok: false,
      response: res.status(400).json({
        error: "TRIAL_STORAGE_EXCEEDED",
        code: "TRIAL_STORAGE_EXCEEDED",
        message: "Free Trial storage quota exceeded (5MB max).",
        trial: buildTrialSnapshot(tracker),
      }),
    };
  }

  const updatedAt = new Date().toISOString();
  await TrialTracker.updateOne(
    { device_fingerprint: String(fingerprint) },
    {
      $set: {
        storage_used_bytes: nextUsed,
        updated_at: updatedAt,
      },
    }
  );
  return {
    ok: true,
    tracker: {
      ...tracker,
      storage_used_bytes: nextUsed,
      updated_at: updatedAt,
    },
  };
}

async function getTrialStatusFromRequest(req) {
  const trialRequest = isTrialModeRequest(req);
  const fingerprint = getFingerprintFromRequest(req);
  if (!trialRequest || !fingerprint) {
    return {
      is_trial_mode: trialRequest,
      fingerprint_hash: fingerprint ? hashFingerprint(fingerprint) : null,
      trial: {
        request_count: 0,
        request_limit: TRIAL_MAX_REQUESTS_PER_24H,
        remaining_requests: TRIAL_MAX_REQUESTS_PER_24H,
        storage_used_bytes: 0,
        storage_limit_bytes: TRIAL_MAX_STORAGE_BYTES,
        storage_remaining_bytes: TRIAL_MAX_STORAGE_BYTES,
        first_request_at: null,
        window_reset_at: null,
      },
    };
  }

  const tracker = await getOrCreateTrialTrackerByFingerprint(fingerprint);
  return {
    is_trial_mode: true,
    fingerprint_hash: hashFingerprint(fingerprint),
    trial: buildTrialSnapshot(tracker),
  };
}

function attachTrialAuthContext(req, trialCompanyId) {
  req.auth = req.auth || {};
  req.auth.company_id = trialCompanyId;
  req.auth.trial = {
    is_trial: true,
    fingerprint: getFingerprintFromRequest(req),
    company_id: trialCompanyId,
  };
}

module.exports = {
  TRIAL_MAX_REQUESTS_PER_24H,
  TRIAL_MAX_STORAGE_BYTES,
  isTrialModeRequest,
  isTrialGuestToken,
  isValidTrialCompanyId,
  getFingerprintFromRequest,
  buildTrialCompanyIdFromFingerprint,
  getTrialCompanyIdForRequest,
  attachTrialAuthContext,
  enforceTrialChatLimit,
  enforceTrialUploadStorageLimit,
  getTrialStatusFromRequest,
};
