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
    console.log("[DB] MongoDB already connected:", mongoose.connection.host || "(unknown-host)");
    return mongoose.connection;
  }

  const serverSelectionTimeoutMS =
    Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS) || 15000;
  const connectTimeoutMS = Number(process.env.MONGODB_CONNECT_TIMEOUT_MS) || 15000;

  console.log(
    "[DB] Connecting to MongoDB…",
    `(serverSelectionTimeoutMS=${serverSelectionTimeoutMS})`
  );

  try {
    await mongoose.connect(uri, {
      autoIndex: true,
      maxPoolSize: 10,
      serverSelectionTimeoutMS,
      connectTimeoutMS,
    });
    console.log("[DB] MongoDB connected successfully:", mongoose.connection.host || "(unknown-host)");
    return mongoose.connection;
  } catch (error) {
    const message = error?.message || String(error);
    console.error("[DB] MongoDB connection FAILED:", message);
    if (error?.reason) {
      console.error("[DB] MongoDB failure reason:", error.reason);
    }
    throw error;
  }
}

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}

module.exports = {
  mongoose,
  connectDatabase,
  disconnectDatabase,
  isDatabaseConnected,
};
