const { mongoose } = require("../config/database");

const userFaceProfileSchema = new mongoose.Schema(
  {
    user_id: { type: String, required: true, unique: true, index: true },
    descriptors_json: { type: String, required: true, default: "[]" },
    reference_images_json: { type: String, required: true, default: "[]" },
    enrolled_at: { type: String, required: true },
    updated_at: { type: String, required: true },
  },
  { collection: "user_face_profiles", versionKey: false, strict: true }
);

module.exports =
  mongoose.models.UserFaceProfile ||
  mongoose.model("UserFaceProfile", userFaceProfileSchema);
