const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const DEFAULT_FRONTEND_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "priva-ai-workspace-main",
  "priva-ai-workspace-main"
);

/**
 * Optionally spawn the Vite dev server (localhost:8080) alongside the API.
 * Enable with START_FRONTEND_DEV=1 and set FRONTEND_DIR if needed.
 */
function startFrontendDevServer() {
  if (String(process.env.START_FRONTEND_DEV || "").trim() !== "1") {
    return null;
  }

  const frontendDir = path.resolve(
    process.env.FRONTEND_DIR || DEFAULT_FRONTEND_DIR
  );
  const packageJson = path.join(frontendDir, "package.json");

  if (!fs.existsSync(packageJson)) {
    console.warn(
      "[FRONTEND] START_FRONTEND_DEV=1 but FRONTEND_DIR is missing package.json:",
      frontendDir
    );
    console.warn(
      "[FRONTEND] Run the UI manually: cd <frontend> && npm run dev  (port 8080)"
    );
    return null;
  }

  const port = String(process.env.FRONTEND_PORT || "8080");
  console.log("[FRONTEND] Starting Vite dev server on http://localhost:" + port);
  console.log("[FRONTEND] cwd:", frontendDir);

  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCmd, ["run", "dev"], {
    cwd: frontendDir,
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      PORT: port,
    },
  });

  child.on("error", (err) => {
    console.error("[FRONTEND] Failed to start Vite:", err.message);
  });

  child.on("exit", (code, signal) => {
    if (code != null && code !== 0) {
      console.warn("[FRONTEND] Vite exited with code", code);
    } else if (signal) {
      console.warn("[FRONTEND] Vite exited via signal", signal);
    }
  });

  return child;
}

module.exports = {
  startFrontendDevServer,
  DEFAULT_FRONTEND_DIR,
};
