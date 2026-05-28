const { mongoose } = require("../config/database");

const companySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    company_name: { type: String, required: true, trim: true },
    openai_api_key: { type: String, default: "" },
    storage_limit_mb: { type: Number, default: 512, min: 1 },
    max_users: { type: Number, default: 10, min: 1 },
    status: { type: String, default: "active", index: true },
    created_at: { type: Date, default: Date.now },
  },
  { collection: "companies", versionKey: false, strict: true }
);

module.exports = mongoose.models.Company || mongoose.model("Company", companySchema);
