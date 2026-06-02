const { defineConfig } = require("@playwright/test");

const baseURL = process.env.E2E_BASE_URL || "http://localhost:5173";

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120000,
  expect: {
    timeout: 20000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-failures",
  use: {
    baseURL,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
