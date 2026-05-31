const { mongoose } = require("../config/database");

const documentSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    company_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
      // String-only tenant namespace. Keep relaxed for trial_* virtual tenants.
    },
    folder_id: {
      type: String,
      default: null,
      index: true,
    },
    uploaded_by_user_id: {
      type: String,
      default: null,
      index: true,
    },
    user_id: {
      type: String,
      default: null,
      index: true,
    },
    filename: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    mime_type: {
      type: String,
      default: "application/octet-stream",
      trim: true,
    },
    chunks: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    raw_ocr_text: {
      type: String,
      default: "",
    },
    cleaned_text: {
      type: String,
      default: "",
    },
    raw_text_length: {
      type: Number,
      default: 0,
      min: 0,
    },
    cleaned_text_length: {
      type: Number,
      default: 0,
      min: 0,
    },
    detected_document_type: {
      type: String,
      default: "general",
    },
    ocr_verification: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    file_size_bytes: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
    upload_job_id: {
      type: String,
      default: null,
      index: true,
    },
    status: {
      type: String,
      default: "complete",
      index: true,
    },
    text_extract: {
      type: String,
      default: "",
    },
    vector_indexed: {
      type: Boolean,
      default: false,
      index: true,
    },
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "documents",
    versionKey: false,
    strict: false,
  }
);

documentSchema.index({ company_id: 1, filename: 1, created_at: -1 });
documentSchema.index({ company_id: 1, folder_id: 1, created_at: -1 });

documentSchema.pre("save", function syncUpdatedAt() {
  this.updated_at = new Date();
});

module.exports = mongoose.models.Document || mongoose.model("Document", documentSchema);
