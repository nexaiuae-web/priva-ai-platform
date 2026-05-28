// fix-401.js — تشخيص خطأ 401 مع DashScope / embeddings
const fs = require("fs");
const path = require("path");

function parseEnvLine(content, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`, "m");
  const m = content.match(re);
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  const hash = v.indexOf("#");
  if (hash !== -1) v = v.slice(0, hash).trim();
  return v || null;
}

console.log("🔍 بدء تشخيص خطأ 401...\n");

const envPath = path.join(process.cwd(), ".env");
console.log("1️⃣ Checking .env file...");
if (!fs.existsSync(envPath)) {
  console.error("❌ .env file NOT FOUND at:", envPath);
  process.exit(1);
}

const envContent = fs.readFileSync(envPath, "utf8");
const dashscopeKey = parseEnvLine(envContent, "DASHSCOPE_API_KEY");
const qwenKey = parseEnvLine(envContent, "QWEN_API_KEY");

console.log(
  "   DASHSCOPE_API_KEY:",
  dashscopeKey ? `✅ Found (${dashscopeKey.substring(0, 12)}…)` : "❌ Missing"
);
console.log("   QWEN_API_KEY:", qwenKey ? `✅ Found (${qwenKey.substring(0, 12)}…)` : "❌ Missing");

console.log("\n2️⃣ Checking dotenv loading...");
require("dotenv").config({ path: envPath });
console.log(
  "   process.env.DASHSCOPE_API_KEY:",
  process.env.DASHSCOPE_API_KEY ? "✅ Loaded" : "❌ NOT loaded"
);
console.log("   process.env.QWEN_API_KEY:", process.env.QWEN_API_KEY ? "✅ Loaded" : "❌ NOT loaded");

console.log("\n3️⃣ Testing API Key with DashScope (compatible-mode embeddings)...");
const testKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY;

if (!testKey) {
  console.error("❌ No API Key available in process.env!");
  console.log("\n💡 تأكد أن .env في مجلد تشغيل السكريبت، وأعد تشغيل السيرفر من نفس المجلد.");
  process.exit(1);
}

async function testEmbedding() {
  try {
    const response = await fetch("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${testKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-v2",
        input: "test",
        encoding_format: "float",
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      console.error("❌ API returned 401 — Key invalid, expired, or wrong product.");
      console.log("   Response:", JSON.stringify(data, null, 2));
      console.log("\n💡 جرّب:");
      console.log("   1. مفتاح جديد من https://dashscope.console.aliyun.com");
      console.log("   2. التأكد من تفعيل خدمة text-embedding والرصيد");
    } else if (response.ok) {
      console.log("✅ API Key is VALID. Embedding test OK.");
      const dim = data.data?.[0]?.embedding?.length;
      console.log("   Embedding dimensions:", dim);
    } else {
      console.error(`❌ API returned ${response.status}:`, JSON.stringify(data).slice(0, 500));
    }
  } catch (e) {
    console.error("❌ Network error:", e.message);
  }
}

testEmbedding();
