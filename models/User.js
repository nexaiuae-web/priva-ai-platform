const { mongoose } = require("../config/database");

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password_hash: { type: String, required: true },
    company_id: { type: String, required: true, index: true },
    role: { type: String, required: true, enum: ["admin", "user"], index: true },
    storage_limit_mb: { type: Number, default: null },
    created_at: { type: Date, default: Date.now },
  },
  { collection: "users", versionKey: false, strict: true }
);

userSchema.index({ company_id: 1, role: 1 });

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
