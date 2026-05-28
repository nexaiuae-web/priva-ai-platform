const { useMongoVectorStore } = require("./runtimeConfig");

module.exports = useMongoVectorStore()
  ? require("./mongoVectorStore")
  : require("./vectorStoreChroma");
