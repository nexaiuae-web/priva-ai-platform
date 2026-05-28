const { mongoose } = require("../config/database");

const vectorChunkSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    company_id: { type: String, required: true, index: true },
    document_id: { type: String, required: true, index: true },
    uploaded_by_user_id: { type: String, default: "", index: true },
    folder_id: { type: String, default: "", index: true },
    parent_id: { type: String, default: "" },
    parent_sequence: { type: Number, default: 0 },
    child_sequence: { type: Number, default: 0 },
    is_child: { type: Boolean, default: true },
    document: { type: String, default: "" },
    embedding: { type: [Number], required: true },
  },
  {
    collection: "vector_chunks",
    versionKey: false,
    strict: true,
  }
);

vectorChunkSchema.index({ company_id: 1, document_id: 1 });
vectorChunkSchema.index({ company_id: 1, folder_id: 1 });

module.exports = mongoose.models.VectorChunk || mongoose.model("VectorChunk", vectorChunkSchema);
