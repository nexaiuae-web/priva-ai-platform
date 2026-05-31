/**
 * Safe Express route helpers — avoid calling `next` when it is not a function
 * (common with async handlers on Express 5).
 */

function forwardOptionalNext(next, error, logTag = "BACKGROUND") {
  const message =
    typeof error?.message === "string" ? error.message : String(error || "Internal server error.");
  console.error(`[${logTag}]`, message);
  if (error?.stack) {
    console.error(error.stack);
  }
  if (typeof next === "function") {
    return next(error);
  }
  console.error("Background processing error:", message);
  return undefined;
}

function forwardRouteError(res, next, error, logTag = "ROUTE") {
  if (res.headersSent) {
    return undefined;
  }

  const message =
    typeof error?.message === "string" ? error.message : String(error || "Internal server error.");
  console.error(`[${logTag}]`, message);
  if (error?.stack) {
    console.error(error.stack);
  }

  if (message.includes("Folder not found")) {
    return res.status(404).json({ error: message, message });
  }

  if (error?.code === "TRIAL_FINGERPRINT_REQUIRED" || error?.code === "TRIAL_STORAGE_EXCEEDED") {
    return res.status(400).json({
      error: error.code,
      code: error.code,
      message,
    });
  }

  if (typeof next === "function") {
    return next(error);
  }

  return res.status(500).json({
    error: message,
    code: error?.code || "INTERNAL_ERROR",
    message,
  });
}

function wrapRoute(coreHandler, logTag = "ROUTE") {
  return function routed(req, res, next) {
    return Promise.resolve(coreHandler(req, res)).catch((error) =>
      forwardRouteError(res, next, error, logTag)
    );
  };
}

function respondDocumentsList(res, documents) {
  const list = Array.isArray(documents) ? documents : [];
  return res.status(200).json({
    documents: list,
    files: list,
  });
}

module.exports = {
  forwardOptionalNext,
  forwardRouteError,
  wrapRoute,
  respondDocumentsList,
};
