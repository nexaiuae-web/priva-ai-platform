const { useMongoTenants } = require("./runtimeConfig");

const impl = useMongoTenants() ? require("./mongoUploadJobs") : require("./uploadJobsSqlite");

async function createUploadJob(meta = {}) {
  return impl.createUploadJob(meta);
}

async function updateUploadJob(id, patch = {}) {
  return impl.updateUploadJob(id, patch);
}

async function getUploadJob(id) {
  return impl.getUploadJob(id);
}

async function listUploadJobsByCompany(companyId, options = {}) {
  return impl.listUploadJobsByCompany(companyId, options);
}

function ensureUploadJobsTable() {
  return impl.ensureUploadJobsTable();
}

async function getReservedUploadStorageBytes(company_id, options = {}) {
  if (typeof impl.getReservedUploadStorageBytes === "function") {
    return impl.getReservedUploadStorageBytes(company_id, options);
  }
  return 0;
}

async function getUserReservedUploadStorageBytes(user_id, options = {}) {
  if (typeof impl.getUserReservedUploadStorageBytes === "function") {
    return impl.getUserReservedUploadStorageBytes(user_id, options);
  }
  return 0;
}

module.exports = {
  ensureUploadJobsTable,
  createUploadJob,
  updateUploadJob,
  getUploadJob,
  listUploadJobsByCompany,
  getReservedUploadStorageBytes,
  getUserReservedUploadStorageBytes,
};
