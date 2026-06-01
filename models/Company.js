const { mongoose } = require("../config/database");

const companySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    company_name: { type: String, required: true, trim: true },
    openai_api_key: { type: String, default: "" },
    storage_limit_mb: { type: Number, default: 512, min: 1 },
    monthly_question_limit: { type: Number, default: 500, min: 1 },
    current_month_question_count: { type: Number, default: 0, min: 0 },
    question_quota_month: { type: String, default: "" },
    max_users: { type: Number, default: 10, min: 1 },
    status: { type: String, default: "active", index: true },
    created_at: { type: Date, default: Date.now },
  },
  { collection: "companies", versionKey: false, strict: true }
);

module.exports = mongoose.models.Company || mongoose.model("Company", companySchema);
