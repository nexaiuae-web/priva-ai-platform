const { mongoose } = require("../config/database");

const emailOtpSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    code: {
      type: String,
      required: true,
    },
    expires_at: {
      type: Date,
      required: true,
    },
    used: {
      type: Boolean,
      default: false,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "email_otps",
    versionKey: false,
    strict: true,
  }
);

emailOtpSchema.index({ email: 1, created_at: -1 });
emailOtpSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.EmailOTP ||
  mongoose.model("EmailOTP", emailOtpSchema);
