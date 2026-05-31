const { mongoose } = require("../config/database");

const folderSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    user_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    company_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
      // No hard ref constraint: allows premium + trial_* contexts.
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
    collection: "folders",
    versionKey: false,
    strict: true,
  }
);

folderSchema.index({ user_id: 1, company_id: 1, name: 1 }, { unique: true });

folderSchema.pre("save", function syncUpdatedAt() {
  this.updated_at = new Date();
});

module.exports = mongoose.models.Folder || mongoose.model("Folder", folderSchema);
