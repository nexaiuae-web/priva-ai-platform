const { mongoose } = require("../config/database");

const uploadJobSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    user_id: { type: String, default: null, index: true },
    folder_id: { type: String, default: null },
    company_id: { type: String, required: true, index: true },
    filename: { type: String, default: null },
    mime_type: { type: String, default: null },
    file_path: { type: String, default: null },
    file_size_bytes: { type: Number, default: 0 },
    status: { type: String, default: "pending", index: true },
    percent: { type: Number, default: 0 },
    phase: { type: String, default: "pending" },
    current: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    message: { type: String, default: "" },
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    error_message: { type: String, default: null },
    retry_count: { type: Number, default: 0 },
    max_retries: { type: Number, default: 3 },
    is_trial: { type: Boolean, default: false },
    trial_fingerprint: { type: String, default: null },
    storage_provider: { type: String, default: "local", index: true },
    cloudinary_public_id: { type: String, default: null, index: true },
    cloudinary_secure_url: { type: String, default: null },
    created_at: { type: Date, default: Date.now },
    updated_at: { type: Date, default: Date.now },
  },
  { collection: "upload_jobs", versionKey: false, strict: false }
);

uploadJobSchema.index({ company_id: 1, status: 1 });

module.exports = mongoose.models.UploadJob || mongoose.model("UploadJob", uploadJobSchema);
