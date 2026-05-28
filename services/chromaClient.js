/**
 * ChromaDB — local persistent storage only (no Docker, no external URL)
 * -----------------------------------------------------------------------
 * chromadb ^3 has no PersistentClient. `ChromaClient({ path })` is NOT filesystem
 * storage — it is parsed as a URL and breaks with "Failed to parse URL".
 *
 * Local mode: embedded Chroma (native bindings) → SQLite files in `chroma_data/`,
 * then ChromaClient to loopback localhost. CHROMA_URL / CHROMA_HOST are ignored.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { ChromaClient } = require("chromadb");

const CHROMA_DATA_DIR = path.join(process.cwd(), "chroma_data");
const CHROMA_PORT = 8000;
const LOCAL_HOST = "localhost";

if (process.env.CHROMA_URL) {
  console.log("[CHROMA] Ignoring CHROMA_URL from env — local embedded storage only");
  delete process.env.CHROMA_URL;
}
delete process.env.CHROMA_HOST;

if (!fs.existsSync(CHROMA_DATA_DIR)) {
  fs.mkdirSync(CHROMA_DATA_DIR, { recursive: true });
  console.log("[CHROMA] Created directory:", CHROMA_DATA_DIR);
}

let clientInstance = null;
let embeddedChild = null;
let serverStartPromise = null;

function localClientArgs() {
  return {
    ssl: false,
    host: LOCAL_HOST,
    port: CHROMA_PORT,
  };
}

function loadChromaBindings() {
  const platform = os.platform();
  const arch = os.arch();

  if (platform === "darwin") {
    if (arch === "arm64") return require("chromadb-js-bindings-darwin-arm64");
    if (arch === "x64") return require("chromadb-js-bindings-darwin-x64");
    throw new Error(`[CHROMA] Unsupported macOS architecture: ${arch}`);
  }
  if (platform === "linux") {
    if (arch === "arm64") return require("chromadb-js-bindings-linux-arm64-gnu");
    if (arch === "x64") return require("chromadb-js-bindings-linux-x64-gnu");
    throw new Error(`[CHROMA] Unsupported Linux architecture: ${arch}`);
  }
  if (platform === "win32") {
    if (arch === "x64") return require("chromadb-js-bindings-win32-x64-msvc");
    if (arch === "arm64") return require("chromadb-js-bindings-win32-arm64-msvc");
    throw new Error(`[CHROMA] Unsupported Windows architecture: ${arch}`);
  }
  throw new Error(`[CHROMA] Unsupported platform: ${platform}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHeartbeat(attempts = 40, delayMs = 500) {
  const probe = new ChromaClient(localClientArgs());
  for (let i = 0; i < attempts; i++) {
    try {
      await probe.heartbeat();
      return true;
    } catch (_e) {
      await sleep(delayMs);
    }
  }
  return false;
}

function spawnEmbeddedChromaServer() {
  if (embeddedChild) return;

  const dataPath = CHROMA_DATA_DIR;
  const port = String(CHROMA_PORT);

  const starter = `
const os = require("os");
const platform = os.platform();
const arch = os.arch();
let binding;
if (platform === "darwin") {
  binding = arch === "arm64"
    ? require("chromadb-js-bindings-darwin-arm64")
    : require("chromadb-js-bindings-darwin-x64");
} else if (platform === "linux") {
  binding = arch === "arm64"
    ? require("chromadb-js-bindings-linux-arm64-gnu")
    : require("chromadb-js-bindings-linux-x64-gnu");
} else if (platform === "win32") {
  binding = arch === "x64"
    ? require("chromadb-js-bindings-win32-x64-msvc")
    : require("chromadb-js-bindings-win32-arm64-msvc");
} else {
  throw new Error("Unsupported platform: " + platform);
}
binding.cli(["chroma", "run", "--path", ${JSON.stringify(dataPath)}, "--port", ${JSON.stringify(port)}]);
`;

  embeddedChild = spawn(process.execPath, ["-e", starter], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CHROMA_URL: undefined, CHROMA_HOST: undefined },
    windowsHide: true,
  });

  embeddedChild.stdout?.on("data", (buf) => {
    const line = String(buf).trim();
    if (line) console.log("[CHROMA-SERVER]", line.split("\n")[0]);
  });
  embeddedChild.stderr?.on("data", (buf) => {
    const line = String(buf).trim();
    if (line && !line.includes("tracing")) console.warn("[CHROMA-SERVER]", line.split("\n")[0]);
  });
  embeddedChild.on("exit", (code, signal) => {
    console.warn("[CHROMA] Embedded server exited", { code, signal });
    embeddedChild = null;
    serverStartPromise = null;
  });

  console.log("[CHROMA] Starting local embedded server →", dataPath);
}

async function ensureChromaServer() {
  if (await waitForHeartbeat(2, 200)) {
    return;
  }

  if (!serverStartPromise) {
    serverStartPromise = (async () => {
      try {
        loadChromaBindings();
      } catch (e) {
        throw new Error(
          `[CHROMA] Native bindings unavailable (${e.message}). Run: npm install chromadb@latest`
        );
      }

      spawnEmbeddedChromaServer();

      const ready = await waitForHeartbeat();
      if (!ready) {
        throw new Error(`[CHROMA] Local server did not start on ${LOCAL_HOST}:${CHROMA_PORT}`);
      }
    })();
  }

  await serverStartPromise;
}

function getChromaClient() {
  if (!clientInstance) {
    clientInstance = new ChromaClient(localClientArgs());
    console.log("[CHROMA] ✅ LOCAL client initialized at:", CHROMA_DATA_DIR);
  }
  return clientInstance;
}

async function getOrCreateCollection(name, metadata = {}) {
  await ensureChromaServer();
  const client = getChromaClient();

  try {
    const collection = await client.getCollection({
      name,
      embeddingFunction: null,
    });
    console.log("[CHROMA] Collection loaded:", name);
    return collection;
  } catch (_e) {
    const collection = await client.createCollection({
      name,
      metadata: {
        "hnsw:space": "cosine",
        ...metadata,
      },
      embeddingFunction: null,
    });
    console.log("[CHROMA] Collection created:", name);
    return collection;
  }
}

async function deleteCollection(name) {
  await ensureChromaServer();
  const client = getChromaClient();
  try {
    await client.deleteCollection({ name });
    console.log("[CHROMA] Collection deleted:", name);
  } catch (e) {
    console.warn("[CHROMA] Delete failed:", e.message);
  }
}

function shutdownEmbeddedChroma() {
  if (embeddedChild && !embeddedChild.killed) {
    embeddedChild.kill();
    embeddedChild = null;
    serverStartPromise = null;
    console.log("[CHROMA] Embedded server stopped");
  }
}

process.on("exit", shutdownEmbeddedChroma);
process.on("SIGINT", () => {
  shutdownEmbeddedChroma();
  process.exit(0);
});
process.on("SIGTERM", shutdownEmbeddedChroma);

module.exports = {
  getChromaClient,
  getOrCreateCollection,
  deleteCollection,
  ensureChromaServer,
  CHROMA_DATA_DIR,
};
