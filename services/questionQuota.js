/**
 * Monthly question quota — company pool with optional per-user cap.
 */
const { useMongoTenants } = require("./runtimeConfig");
const Company = require("../models/Company");
const User = require("../models/User");
const { getDb } = require("./tenantDb");

const QUESTION_QUOTA_EXCEEDED_MESSAGE =
  "لقد استهلكت كامل حصتك من الأسئلة لهذا الشهر. يرجى ترقية الباقة.";

function currentQuotaMonth() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getDefaultMonthlyQuestionLimit() {
  return Math.max(
    1,
    Number.parseInt(process.env.DEFAULT_MONTHLY_QUESTION_LIMIT || "500", 10) || 500
  );
}

function parseMonthlyQuestionLimitInput(raw, fallback = getDefaultMonthlyQuestionLimit()) {
  if (raw === undefined || raw === null || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("monthly_question_limit must be a positive integer.");
  }
  return parsed;
}

function normalizeQuotaRow(row) {
  if (!row) return null;
  const month = currentQuotaMonth();
  let count = Math.max(0, Number(row.current_month_question_count) || 0);
  let quotaMonth = row.question_quota_month || null;
  if (quotaMonth !== month) {
    count = 0;
    quotaMonth = month;
  }
  const limit = Math.max(
    1,
    Number(row.monthly_question_limit) || getDefaultMonthlyQuestionLimit()
  );
  return {
    monthly_question_limit: limit,
    current_month_question_count: count,
    question_quota_month: quotaMonth,
  };
}

async function loadCompanyQuotaRow(companyId) {
  const id = String(companyId || "").trim();
  if (!id) return null;

  if (useMongoTenants()) {
    let doc = await Company.findOne({ id }).lean();
    if (!doc) return null;
    const normalized = normalizeQuotaRow(doc);
    if (
      doc.question_quota_month !== normalized.question_quota_month ||
      Number(doc.current_month_question_count) !== normalized.current_month_question_count
    ) {
      await Company.updateOne(
        { id },
        {
          $set: {
            current_month_question_count: normalized.current_month_question_count,
            question_quota_month: normalized.question_quota_month,
          },
        }
      );
    }
    return { id, ...normalized };
  }

  const db = getDb();
  const row = db.prepare(`SELECT * FROM companies WHERE id = ?`).get(id);
  if (!row) return null;
  const normalized = normalizeQuotaRow(row);
  if (
    row.question_quota_month !== normalized.question_quota_month ||
    Number(row.current_month_question_count) !== normalized.current_month_question_count
  ) {
    db.prepare(
      `UPDATE companies SET current_month_question_count = @count, question_quota_month = @month WHERE id = @id`
    ).run({
      id,
      count: normalized.current_month_question_count,
      month: normalized.question_quota_month,
    });
  }
  return { id, ...normalized };
}

async function loadUserQuotaRow(userId) {
  const id = String(userId || "").trim();
  if (!id) return null;

  if (useMongoTenants()) {
    let doc = await User.findOne({ id }).lean();
    if (!doc) return null;
    const hasUserLimit =
      doc.monthly_question_limit != null &&
      Number.isFinite(Number(doc.monthly_question_limit)) &&
      Number(doc.monthly_question_limit) >= 1;
    if (!hasUserLimit) {
      return {
        id,
        monthly_question_limit: null,
        current_month_question_count: 0,
        question_quota_month: currentQuotaMonth(),
        uses_company_pool: true,
      };
    }
    const normalized = normalizeQuotaRow(doc);
    if (
      doc.question_quota_month !== normalized.question_quota_month ||
      Number(doc.current_month_question_count) !== normalized.current_month_question_count
    ) {
      await User.updateOne(
        { id },
        {
          $set: {
            current_month_question_count: normalized.current_month_question_count,
            question_quota_month: normalized.question_quota_month,
          },
        }
      );
    }
    return { id, ...normalized, uses_company_pool: false };
  }

  const db = getDb();
  const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!row) return null;
  const hasUserLimit =
    row.monthly_question_limit != null &&
    row.monthly_question_limit !== "" &&
    Number(row.monthly_question_limit) >= 1;
  if (!hasUserLimit) {
    return {
      id,
      monthly_question_limit: null,
      current_month_question_count: 0,
      question_quota_month: currentQuotaMonth(),
      uses_company_pool: true,
    };
  }
  const normalized = normalizeQuotaRow(row);
  if (
    row.question_quota_month !== normalized.question_quota_month ||
    Number(row.current_month_question_count) !== normalized.current_month_question_count
  ) {
    db.prepare(
      `UPDATE users SET current_month_question_count = @count, question_quota_month = @month WHERE id = @id`
    ).run({
      id,
      count: normalized.current_month_question_count,
      month: normalized.question_quota_month,
    });
  }
  return { id, ...normalized, uses_company_pool: false };
}

async function getEffectiveQuestionQuota({ companyId, userId = null }) {
  const companyRow = await loadCompanyQuotaRow(companyId);
  if (!companyRow) {
    return null;
  }

  const userRow = userId ? await loadUserQuotaRow(userId) : null;
  const useUserPool =
    userRow && !userRow.uses_company_pool && userRow.monthly_question_limit != null;

  const limit = useUserPool
    ? userRow.monthly_question_limit
    : companyRow.monthly_question_limit;
  const used = useUserPool
    ? userRow.current_month_question_count
    : companyRow.current_month_question_count;

  return {
    scope: useUserPool ? "user" : "company",
    monthly_question_limit: limit,
    current_month_question_count: used,
    remaining_questions: Math.max(0, limit - used),
    question_quota_month: useUserPool
      ? userRow.question_quota_month
      : companyRow.question_quota_month,
  };
}

function buildQuestionQuotaExceededResponse(res) {
  return res.status(403).json({
    error: "QUESTION_QUOTA_EXCEEDED",
    code: "QUESTION_QUOTA_EXCEEDED",
    message: QUESTION_QUOTA_EXCEEDED_MESSAGE,
  });
}

async function assertMonthlyQuestionQuotaAllowed(req, res) {
  const { isTrialModeRequest } = require("./trialTracker");
  if (isTrialModeRequest(req)) {
    return { ok: true };
  }

  const companyId = req.auth?.company_id;
  if (!companyId) {
    return { ok: true };
  }

  const userId = req.auth?.user?.id || null;
  const quota = await getEffectiveQuestionQuota({ companyId, userId });
  if (!quota) {
    return { ok: true };
  }

  if (quota.current_month_question_count >= quota.monthly_question_limit) {
    return {
      ok: false,
      response: buildQuestionQuotaExceededResponse(res),
      quota,
    };
  }

  return { ok: true, quota };
}

async function incrementQuestionQuotaCounter({ companyId, userId = null }) {
  const companyRow = await loadCompanyQuotaRow(companyId);
  if (!companyRow) return;

  const userRow = userId ? await loadUserQuotaRow(userId) : null;
  const useUserPool =
    userRow && !userRow.uses_company_pool && userRow.monthly_question_limit != null;

  const month = currentQuotaMonth();

  if (useMongoTenants()) {
    if (useUserPool) {
      await User.updateOne(
        { id: userRow.id },
        {
          $set: { question_quota_month: month },
          $inc: { current_month_question_count: 1 },
        }
      );
      return;
    }
    await Company.updateOne(
      { id: companyRow.id },
      {
        $set: { question_quota_month: month },
        $inc: { current_month_question_count: 1 },
      }
    );
    return;
  }

  const db = getDb();
  if (useUserPool) {
    db.prepare(
      `UPDATE users SET current_month_question_count = current_month_question_count + 1, question_quota_month = ? WHERE id = ?`
    ).run(month, userRow.id);
    return;
  }
  db.prepare(
    `UPDATE companies SET current_month_question_count = current_month_question_count + 1, question_quota_month = ? WHERE id = ?`
  ).run(month, companyRow.id);
}

async function attachQuestionQuotaToSnapshot(snapshot, { companyId, userId = null }) {
  if (!snapshot) return snapshot;
  const quota = await getEffectiveQuestionQuota({ companyId, userId });
  if (!quota) return snapshot;
  return {
    ...snapshot,
    question_pool_scope: quota.scope,
    monthly_question_limit: quota.monthly_question_limit,
    current_month_question_count: quota.current_month_question_count,
    remaining_questions: quota.remaining_questions,
    question_quota_month: quota.question_quota_month,
  };
}

module.exports = {
  QUESTION_QUOTA_EXCEEDED_MESSAGE,
  getDefaultMonthlyQuestionLimit,
  parseMonthlyQuestionLimitInput,
  getEffectiveQuestionQuota,
  assertMonthlyQuestionQuotaAllowed,
  incrementQuestionQuotaCounter,
  attachQuestionQuotaToSnapshot,
};
