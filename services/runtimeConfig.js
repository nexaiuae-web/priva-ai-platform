const os = require("os");
const path = require("path");

function isRenderPlatform() {
  return (
    String(process.env.RENDER || "").toLowerCase() === "true" ||
    Boolean(process.env.RENDER_SERVICE_ID) ||
    String(process.env.DEPLOY_TARGET || "").toLowerCase() === "render"
  );
}

function isEphemeralFilesystem() {
  if (isRenderPlatform()) return true;
  const flag = String(process.env.EPHEMERAL_FILESYSTEM || "").toLowerCase();
  return flag === "1" || flag === "true" || flag === "yes";
}

function useMongoVectorStore() {
  const mode = String(process.env.VECTOR_STORE || "").trim().toLowerCase();
  if (mode === "mongo") return true;
  if (mode === "chroma") return false;
  return isRenderPlatform();
}

function useMongoTenants() {
  const mode = String(process.env.TENANT_STORE || "").trim().toLowerCase();
  if (mode === "mongo") return true;
  if (mode === "sqlite") return false;
  return isRenderPlatform();
}

function getUploadStagingDir() {
  if (process.env.UPLOAD_STAGING_DIR) {
    return path.resolve(process.env.UPLOAD_STAGING_DIR);
  }
  if (isEphemeralFilesystem()) {
    return path.join(os.tmpdir(), "priva-upload-staging");
  }
  return path.join(process.cwd(), "data", "upload_staging");
}

module.exports = {
  isRenderPlatform,
  isEphemeralFilesystem,
  useMongoVectorStore,
  useMongoTenants,
  getUploadStagingDir,
};
