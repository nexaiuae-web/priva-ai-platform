# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chatFlow.spec.js >> Chat stream and quota flow >> Quota error enforcement
- Location: tests\chatFlow.spec.js:173:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('textarea[placeholder*="message"], textarea[placeholder*="رسالة"], textarea[placeholder*="Write"], textarea').first()
Expected: visible
Timeout: 20000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 20000ms
  - waiting for locator('textarea[placeholder*="message"], textarea[placeholder*="رسالة"], textarea[placeholder*="Write"], textarea').first()

```

```yaml
- complementary:
  - heading "AI Workspace" [level=2]
  - paragraph: "Active Company: Beckman"
  - paragraph: "Questions: 0 / 6 Used"
  - button "KNOWLEDGE BASE"
  - button "PRIVA AI CHAT"
  - button "LOGOUT"
- main:
  - heading "PRIVA AI Chat" [level=3]
  - button "Reset Discussion"
  - text: هل يوم الجمعه يعتبر غياب مضاعف ؟
  - button "Message actions"
  - paragraph: نعم، يعتبر يوم الجمعة غياباً مضاعفاً ويحتسب يومين دراسيين.
  - paragraph: المصادر
  - list:
    - listitem: "[الملف: IMG-20260521-WA0014.jpg]"
  - button "Message actions"
  - text: هل يوم الجمعه يعتبر غياب مضاعف ؟
  - button "Message actions"
  - paragraph: نعم، يعتبر يوم الجمعة غياباً مضاعفاً ويحتسب يومين دراسيين.
  - paragraph: المصادر
  - list:
    - listitem: "[الملف: IMG-20260521-WA0014.jpg]"
  - button "Message actions"
  - text: قوانين اي مدرسة هاي ؟؟
  - button "Message actions"
  - paragraph: هذه القوانين تتعلق بمدرسة الحكمة الخاصة.
  - paragraph: المصادر
  - list:
    - listitem: "[الملف: IMG-20260521-WA0014.jpg]"
  - button "Message actions"
  - textbox "Ask using your knowledge base…"
  - button "SEND" [disabled]
- region "Notifications alt+T"
```

# Test source

```ts
  1   | const { test, expect } = require("@playwright/test");
  2   | 
  3   | const TEST_USERNAME = process.env.E2E_USERNAME || "test_user";
  4   | const TEST_PASSWORD = process.env.E2E_PASSWORD || "password123";
  5   | const QUOTA_BURN_COUNT = Number.parseInt(process.env.E2E_QUOTA_BURN_COUNT || "12", 10);
  6   | const QUOTA_ERROR_MESSAGE =
  7   |   process.env.E2E_QUOTA_ERROR_MESSAGE ||
  8   |   "لقد استهلكت كامل حصتك من الأسئلة لهذا الشهر. يرجى ترقية الباقة.";
  9   | 
  10  | const STRESS_PROMPT =
  11  |   "اكتب لي تقريراً مطولاً ومفصلاً من 5 فقرات عن تكنولوجيا المعلومات والذكاء الاصطناعي لتجربة الضغط على السيرفر";
  12  | 
  13  | function matchFirstVisible(page, selectors) {
  14  |   return page.locator(selectors.join(", ")).first();
  15  | }
  16  | 
  17  | async function loginToWorkspace(page) {
  18  |   let loginBypassFlag = false;
  19  |   page.on("response", async (response) => {
  20  |     try {
  21  |       if (!/\/api\/login$/i.test(response.url())) return;
  22  |       const payload = await response.json();
  23  |       loginBypassFlag = Boolean(payload?.face_verification_bypassed);
  24  |     } catch {
  25  |       /* ignore parse failures */
  26  |     }
  27  |   });
  28  | 
  29  |   await page.goto("/", { waitUntil: "domcontentloaded" });
  30  | 
  31  |   const usernameInput = matchFirstVisible(page, [
  32  |     'input[name="username"]',
  33  |     'input[name="email"]',
  34  |     'input[placeholder*="User"]',
  35  |     'input[placeholder*="username"]',
  36  |   ]);
  37  |   await expect(usernameInput).toBeVisible();
  38  |   await usernameInput.fill(TEST_USERNAME);
  39  | 
  40  |   const passwordInput = matchFirstVisible(page, [
  41  |     'input[name="password"]',
  42  |     'input[type="password"]',
  43  |   ]);
  44  |   await expect(passwordInput).toBeVisible();
  45  |   await passwordInput.fill(TEST_PASSWORD);
  46  | 
  47  |   const loginButton = matchFirstVisible(page, [
  48  |     'button:has-text("Login")',
  49  |     'button:has-text("Sign In")',
  50  |     'button[type="submit"]',
  51  |   ]);
  52  |   await expect(loginButton).toBeVisible();
  53  |   await loginButton.click();
  54  | 
  55  |   await page.waitForFunction(() => Boolean(localStorage.getItem("priva_token")), null, {
  56  |     timeout: 30000,
  57  |   });
  58  |   const token = await page.evaluate(() => localStorage.getItem("priva_token"));
  59  |   if (!token) {
  60  |     throw new Error("Login did not persist auth token.");
  61  |   }
  62  | 
  63  |   if (loginBypassFlag) {
  64  |     await page.evaluate((savedToken) => {
  65  |       sessionStorage.setItem("priva_face_verified", savedToken);
  66  |     }, token);
  67  |   }
  68  | 
  69  |   await page.waitForURL(/\/(chat|verify-face)/, { timeout: 30000 }).catch(() => {});
  70  | 
  71  |   if (page.url().includes("/verify-face")) {
  72  |     await page.evaluate((savedToken) => {
  73  |       sessionStorage.setItem("priva_face_verified", savedToken);
  74  |     }, token);
  75  |     await page.goto("/chat", { waitUntil: "domcontentloaded" });
  76  |   }
  77  | 
  78  |   await page.waitForURL(/\/chat/, { timeout: 30000 });
  79  | }
  80  | 
  81  | async function getChatInput(page) {
  82  |   const chatInput = matchFirstVisible(page, [
  83  |     'textarea[placeholder*="message"]',
  84  |     'textarea[placeholder*="رسالة"]',
  85  |     'textarea[placeholder*="Write"]',
  86  |     "textarea",
  87  |   ]);
> 88  |   await expect(chatInput).toBeVisible();
      |                           ^ Error: expect(locator).toBeVisible() failed
  89  |   return chatInput;
  90  | }
  91  | 
  92  | async function getSendButton(page) {
  93  |   const sendButton = matchFirstVisible(page, [
  94  |     'button:has-text("Send")',
  95  |     'button:has-text("SEND")',
  96  |     'button:has-text("إرسال")',
  97  |     'button[type="submit"]',
  98  |   ]);
  99  |   await expect(sendButton).toBeVisible();
  100 |   return sendButton;
  101 | }
  102 | 
  103 | async function sendMessage(page, message) {
  104 |   const chatInput = await getChatInput(page);
  105 |   await chatInput.fill(message);
  106 |   const sendButton = await getSendButton(page);
  107 |   await sendButton.click();
  108 | }
  109 | 
  110 | async function waitForStreamToFinish(page) {
  111 |   const assistantMessages = page.locator(
  112 |     '[data-role="assistant"], .assistant-message, [class*="assistant"]'
  113 |   );
  114 | 
  115 |   let unchangedTicks = 0;
  116 |   let previousLength = -1;
  117 |   const maxTicks = 90;
  118 | 
  119 |   for (let tick = 0; tick < maxTicks; tick += 1) {
  120 |     await page.waitForTimeout(500);
  121 |     const count = await assistantMessages.count();
  122 |     const latestText = count > 0 ? await assistantMessages.nth(count - 1).innerText() : "";
  123 |     const currentLength = latestText.trim().length;
  124 | 
  125 |     if (currentLength === previousLength && currentLength > 0) {
  126 |       unchangedTicks += 1;
  127 |     } else {
  128 |       unchangedTicks = 0;
  129 |       previousLength = currentLength;
  130 |     }
  131 | 
  132 |     if (unchangedTicks >= 4) {
  133 |       return;
  134 |     }
  135 |   }
  136 | 
  137 |   throw new Error("Stream did not stabilize in expected time window.");
  138 | }
  139 | 
  140 | test.describe("Chat stream and quota flow", () => {
  141 |   test("Authentication & stream verification", async ({ page }) => {
  142 |     const consoleProblems = [];
  143 |     const apiProblems = [];
  144 | 
  145 |     page.on("console", (msg) => {
  146 |       if (msg.type() !== "error") return;
  147 |       const text = msg.text();
  148 |       if (/react|hydration|error|exception/i.test(text)) {
  149 |         consoleProblems.push(text);
  150 |       }
  151 |     });
  152 | 
  153 |     page.on("response", (response) => {
  154 |       const url = response.url();
  155 |       if (!/\/api\//i.test(url)) return;
  156 |       const status = response.status();
  157 |       if (status >= 400) {
  158 |         apiProblems.push(`${status} ${url}`);
  159 |       }
  160 |     });
  161 | 
  162 |     await loginToWorkspace(page);
  163 |     await sendMessage(page, STRESS_PROMPT);
  164 |     await waitForStreamToFinish(page);
  165 | 
  166 |     expect(
  167 |       consoleProblems,
  168 |       `React/Hydration/browser errors detected:\n${consoleProblems.join("\n")}`
  169 |     ).toEqual([]);
  170 |     expect(apiProblems, `4xx/5xx API responses detected:\n${apiProblems.join("\n")}`).toEqual([]);
  171 |   });
  172 | 
  173 |   test("Quota error enforcement", async ({ page }) => {
  174 |     await loginToWorkspace(page);
  175 | 
  176 |     let quotaBlocked = false;
  177 |     const quotaBanner = page.locator(`text=${QUOTA_ERROR_MESSAGE}`);
  178 | 
  179 |     for (let i = 1; i <= QUOTA_BURN_COUNT; i += 1) {
  180 |       await sendMessage(page, `Quota burn message #${i}`);
  181 |       await page.waitForTimeout(1200);
  182 | 
  183 |       if (await quotaBanner.first().isVisible().catch(() => false)) {
  184 |         quotaBlocked = true;
  185 |         break;
  186 |       }
  187 | 
  188 |       await waitForStreamToFinish(page).catch(() => {});
```