const { test, expect } = require("@playwright/test");

const TEST_USERNAME = process.env.E2E_USERNAME || "test_user";
const TEST_PASSWORD = process.env.E2E_PASSWORD || "password123";
const QUOTA_BURN_COUNT = Number.parseInt(process.env.E2E_QUOTA_BURN_COUNT || "12", 10);
const QUOTA_ERROR_MESSAGE =
  process.env.E2E_QUOTA_ERROR_MESSAGE ||
  "لقد استهلكت كامل حصتك من الأسئلة لهذا الشهر. يرجى ترقية الباقة.";

const STRESS_PROMPT =
  "اكتب لي تقريراً مطولاً ومفصلاً من 5 فقرات عن تكنولوجيا المعلومات والذكاء الاصطناعي لتجربة الضغط على السيرفر";

function matchFirstVisible(page, selectors) {
  return page.locator(selectors.join(", ")).first();
}

async function loginToWorkspace(page) {
  let loginBypassFlag = false;
  page.on("response", async (response) => {
    try {
      if (!/\/api\/login$/i.test(response.url())) return;
      const payload = await response.json();
      loginBypassFlag = Boolean(payload?.face_verification_bypassed);
    } catch {
      /* ignore parse failures */
    }
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  const usernameInput = matchFirstVisible(page, [
    'input[name="username"]',
    'input[name="email"]',
    'input[placeholder*="User"]',
    'input[placeholder*="username"]',
  ]);
  await expect(usernameInput).toBeVisible();
  await usernameInput.fill(TEST_USERNAME);

  const passwordInput = matchFirstVisible(page, [
    'input[name="password"]',
    'input[type="password"]',
  ]);
  await expect(passwordInput).toBeVisible();
  await passwordInput.fill(TEST_PASSWORD);

  const loginButton = matchFirstVisible(page, [
    'button:has-text("Login")',
    'button:has-text("Sign In")',
    'button[type="submit"]',
  ]);
  await expect(loginButton).toBeVisible();
  await loginButton.click();

  await page.waitForFunction(() => Boolean(localStorage.getItem("priva_token")), null, {
    timeout: 30000,
  });
  const token = await page.evaluate(() => localStorage.getItem("priva_token"));
  if (!token) {
    throw new Error("Login did not persist auth token.");
  }

  if (loginBypassFlag) {
    await page.evaluate((savedToken) => {
      sessionStorage.setItem("priva_face_verified", savedToken);
    }, token);
  }

  await page.waitForURL(/\/(chat|verify-face)/, { timeout: 30000 }).catch(() => {});

  if (page.url().includes("/verify-face")) {
    await page.evaluate((savedToken) => {
      sessionStorage.setItem("priva_face_verified", savedToken);
    }, token);
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
  }

  await page.waitForURL(/\/chat/, { timeout: 30000 });
}

async function getChatInput(page) {
  const chatInput = matchFirstVisible(page, [
    'textarea[placeholder*="message"]',
    'textarea[placeholder*="رسالة"]',
    'textarea[placeholder*="Write"]',
    "textarea",
  ]);
  await expect(chatInput).toBeVisible();
  return chatInput;
}

async function getSendButton(page) {
  const sendButton = matchFirstVisible(page, [
    'button:has-text("Send")',
    'button:has-text("SEND")',
    'button:has-text("إرسال")',
    'button[type="submit"]',
  ]);
  await expect(sendButton).toBeVisible();
  return sendButton;
}

async function sendMessage(page, message) {
  const chatInput = await getChatInput(page);
  await chatInput.fill(message);
  const sendButton = await getSendButton(page);
  await sendButton.click();
}

async function waitForStreamToFinish(page) {
  const assistantMessages = page.locator(
    '[data-role="assistant"], .assistant-message, [class*="assistant"]'
  );

  let unchangedTicks = 0;
  let previousLength = -1;
  const maxTicks = 90;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    await page.waitForTimeout(500);
    const count = await assistantMessages.count();
    const latestText = count > 0 ? await assistantMessages.nth(count - 1).innerText() : "";
    const currentLength = latestText.trim().length;

    if (currentLength === previousLength && currentLength > 0) {
      unchangedTicks += 1;
    } else {
      unchangedTicks = 0;
      previousLength = currentLength;
    }

    if (unchangedTicks >= 4) {
      return;
    }
  }

  throw new Error("Stream did not stabilize in expected time window.");
}

test.describe("Chat stream and quota flow", () => {
  test("Authentication & stream verification", async ({ page }) => {
    const consoleProblems = [];
    const apiProblems = [];

    page.on("console", (msg) => {
      if (msg.type() !== "error") return;
      const text = msg.text();
      if (/react|hydration|error|exception/i.test(text)) {
        consoleProblems.push(text);
      }
    });

    page.on("response", (response) => {
      const url = response.url();
      if (!/\/api\//i.test(url)) return;
      const status = response.status();
      if (status >= 400) {
        apiProblems.push(`${status} ${url}`);
      }
    });

    await loginToWorkspace(page);
    await sendMessage(page, STRESS_PROMPT);
    await waitForStreamToFinish(page);

    expect(
      consoleProblems,
      `React/Hydration/browser errors detected:\n${consoleProblems.join("\n")}`
    ).toEqual([]);
    expect(apiProblems, `4xx/5xx API responses detected:\n${apiProblems.join("\n")}`).toEqual([]);
  });

  test("Quota error enforcement", async ({ page }) => {
    await loginToWorkspace(page);

    let quotaBlocked = false;
    const quotaBanner = page.locator(`text=${QUOTA_ERROR_MESSAGE}`);

    for (let i = 1; i <= QUOTA_BURN_COUNT; i += 1) {
      await sendMessage(page, `Quota burn message #${i}`);
      await page.waitForTimeout(1200);

      if (await quotaBanner.first().isVisible().catch(() => false)) {
        quotaBlocked = true;
        break;
      }

      await waitForStreamToFinish(page).catch(() => {});
      if (await quotaBanner.first().isVisible().catch(() => false)) {
        quotaBlocked = true;
        break;
      }
    }

    await expect(
      quotaBanner.first(),
      "Expected Arabic monthly quota-block message was not shown."
    ).toBeVisible();
    expect(quotaBlocked).toBeTruthy();
  });
});
