const { mongoose } = require("../config/database");

const userSessionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    user_id: { type: String, required: true, index: true },
    company_id: { type: String, required: true, index: true },
    jti: { type: String, required: true, unique: true, index: true },
    created_at: { type: Date, default: Date.now },
    expires_at: { type: Date, required: true, index: true },
  },
  { collection: "user_sessions", versionKey: false, strict: true }
);

module.exports =
  mongoose.models.UserSession || mongoose.model("UserSession", userSessionSchema);
