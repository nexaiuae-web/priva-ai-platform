#!/usr/bin/env node
require("dotenv").config();
const dns = require("dns").promises;
const { connectDatabase, disconnectDatabase } = require("../config/database");

function hostsFromUri(uri) {
  const hosts = new Set();
  if (!uri) return hosts;

  const srvMatch = /^mongodb\+srv:\/\/[^@]+@([^/?]+)/i.exec(uri);
  if (srvMatch) {
    hosts.add(srvMatch[1]);
    return hosts;
  }

  const stdMatch = /^mongodb:\/\/(?:[^@]+@)?([^/?]+)/i.exec(uri);
  if (stdMatch) {
    for (const part of stdMatch[1].split(",")) {
      hosts.add(part.split(":")[0]);
    }
  }
  return hosts;
}

(async () => {
  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) {
    console.error("[TEST] MONGODB_URI is not set in .env");
    process.exit(1);
  }

  console.log("[TEST] URI scheme:", uri.startsWith("mongodb+srv://") ? "srv" : "standard");
  if (uri.includes("atlas-xxxxxx")) {
    console.warn(
      "[TEST] WARNING: replicaSet placeholder 'atlas-xxxxxx' detected — copy the full URI from Atlas Connect."
    );
  }

  const hosts = [...hostsFromUri(uri)];
  console.log("[TEST] Hosts to resolve:", hosts.join(", ") || "(none)");

  for (const host of hosts) {
    try {
      const result = await dns.lookup(host);
      console.log("[TEST] DNS OK:", host, "->", result.address);
    } catch (error) {
      console.error("[TEST] DNS FAIL:", host, error.code, error.message);
    }
  }

  try {
    await connectDatabase();
    console.log("[TEST] MongoDB connection: SUCCESS");
  } catch (error) {
    console.error("[TEST] MongoDB connection: FAILED");
    console.error("[TEST]", error.message);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
})();
