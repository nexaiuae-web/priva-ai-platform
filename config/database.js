const mongoose = require("mongoose");

let hasAttachedListeners = false;

function attachLifecycleListeners() {
  if (hasAttachedListeners) return;

  mongoose.connection.on("connected", () => {
    console.log("[DB] MongoDB connected:", mongoose.connection.host || "(unknown-host)");
  });

  mongoose.connection.on("error", (error) => {
    console.error("[DB] MongoDB connection error:", error.message);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] MongoDB disconnected");
  });

  hasAttachedListeners = true;
}

async function connectDatabase() {
  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) {
    throw new Error("MONGODB_URI is required to connect to MongoDB.");
  }

  attachLifecycleListeners();

  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  await mongoose.connect(uri, {
    autoIndex: true,
    maxPoolSize: 10,
  });

  return mongoose.connection;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}

module.exports = {
  mongoose,
  connectDatabase,
  disconnectDatabase,
};
