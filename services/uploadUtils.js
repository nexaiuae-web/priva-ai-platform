function mapUploadOverallPercent(phase, embedPercent = 0) {
  switch (phase) {
    case "received":
      return 2;
    case "extracting":
      return Math.min(18, Math.max(3, embedPercent));
    case "chunking":
      return 22;
    case "saving":
      return 24;
    case "embedding":
      return 25 + Math.round(Math.min(100, Math.max(0, embedPercent)) * 0.7);
    case "indexing":
      return 98;
    case "complete":
      return 100;
    case "error":
      return 0;
    case "queued":
      return 1;
    case "processing":
      return 5;
    default:
      return Math.min(100, Math.max(0, embedPercent));
  }
}

module.exports = { mapUploadOverallPercent };
