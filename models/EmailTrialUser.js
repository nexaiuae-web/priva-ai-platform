const { mongoose } = require("../config/database");

const emailTrialUserSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
      unique: true,
    },
    queries_used: {
      type: Number,
      default: 0,
      min: 0,
    },
    queries_reset_at: {
      type: Date,
      default: Date.now,
    },
    storage_used_bytes: {
      type: Number,
      default: 0,
      min: 0,
    },
    created_at: {
      type: Date,
      default: Date.now,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "email_trial_users",
    versionKey: false,
    strict: true,
  }
);

emailTrialUserSchema.index({ email: 1 }, { unique: true });

module.exports =
  mongoose.models.EmailTrialUser ||
  mongoose.model("EmailTrialUser", emailTrialUserSchema);
