/**
 * Server-Sent Events — data-only frames (no `event:` lines).
 * Payloads are JSON objects with a `type` field so clients never render wire metadata.
 */

function isValidSseResponse(res) {
  return res != null && typeof res.setHeader === "function" && typeof res.write === "function";
}

function beginSse(res) {
  if (!isValidSseResponse(res)) {
    console.warn("[SSE] beginSse called without a valid Express response object");
    return false;
  }
  if (res.headersSent) return true;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
  return true;
}

/**
 * Write one SSE frame: only `data: {json}\n\n` (never `event: …`).
 */
function writeSseData(res, payload) {
  if (!isValidSseResponse(res)) return false;
  const dataLine =
    typeof payload === "string" ? payload : JSON.stringify(payload);
  res.write(`data: ${dataLine}\n\n`);
  if (typeof res.flush === "function") {
    res.flush();
  }
  return true;
}

/** Back-compat: maps event name → payload.type */
function writeSse(res, eventName, payload) {
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return writeSseData(res, { type: eventName, ...payload });
  }
  return writeSseData(res, { type: eventName, value: payload });
}

/** Chat answer token — type=token, only `text` is meant for the message bubble. */
function writeStreamToken(res, text) {
  if (text == null || text === "") return false;
  return writeSseData(res, { type: "token", text: String(text) });
}

function wantsEventStream(req) {
  const accept = String(req.headers.accept || "").toLowerCase();
  const streamQ = String(req.query?.stream || "").toLowerCase();
  return accept.includes("text/event-stream") || streamQ === "1" || streamQ === "sse";
}

module.exports = {
  beginSse,
  writeSseData,
  writeSse,
  writeStreamToken,
  wantsEventStream,
  isValidSseResponse,
};
