const { mongoose } = require("../config/database");

const trialTrackerSchema = new mongoose.Schema(
  {
    device_fingerprint: {
      type: String,
      required: true,
      trim: true,
      index: true,
      unique: true,
    },
    request_count: {
      type: Number,
      default: 0,
      min: 0,
    },
    storage_used_bytes: {
      type: Number,
      default: 0,
      min: 0,
    },
    first_request_at: {
      type: Date,
      default: Date.now,
    },
    updated_at: {
      type: Date,
      default: Date.now,
    },
  },
  {
    collection: "trial_trackers",
    versionKey: false,
    strict: true,
  }
);

trialTrackerSchema.index({ device_fingerprint: 1 }, { unique: true });

module.exports = mongoose.models.TrialTracker || mongoose.model("TrialTracker", trialTrackerSchema);
