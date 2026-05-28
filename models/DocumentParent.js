const { mongoose } = require("../config/database");

const documentParentSchema = new mongoose.Schema(
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
      // Keep plain string to support trial_* virtual tenants.
    },
    document_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    parent_index: {
      type: Number,
      default: 0,
      min: 0,
    },
    text: {
      type: String,
      default: "",
    },
    child_ids: {
      type: [String],
      default: [],
    },
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    collection: "document_parents",
    versionKey: false,
    strict: true,
  }
);

documentParentSchema.index({ document_id: 1, parent_index: 1 }, { unique: true });

module.exports =
  mongoose.models.DocumentParent || mongoose.model("DocumentParent", documentParentSchema);
