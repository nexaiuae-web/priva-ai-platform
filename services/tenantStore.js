const { useMongoTenants } = require("./runtimeConfig");

module.exports = useMongoTenants()
  ? require("./mongoTenantStore")
  : require("./tenantStoreSqlite");
