const { mongoose } = require("../config/database");

const chatMessageSchema = new mongoose.Schema(
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
    },
    user_id: {
      type: String,
      default: null,
      index: true,
    },
    role: {
      type: String,
      required: true,
      enum: ["user", "assistant"],
      index: true,
    },
    content: {
      type: String,
      default: "",
    },
    sources: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    created_at: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    collection: "chat_messages",
    versionKey: false,
    strict: false,
  }
);

chatMessageSchema.index({ company_id: 1, user_id: 1, created_at: 1 });

module.exports = mongoose.models.ChatMessage || mongoose.model("ChatMessage", chatMessageSchema);
