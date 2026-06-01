/**
 * Limits concurrent LLM provider requests (OpenAI / Ollama) to avoid rate-limit storms.
 */
const MAX_CONCURRENT = Math.max(
  1,
  Math.min(
    10,
    Number.parseInt(process.env.LLM_MAX_CONCURRENT || "5", 10) || 5
  )
);

let activeCount = 0;
/** @type {Array<{ run: () => void, reject: (err: Error) => void }>} */
const waitQueue = [];

function pumpQueue() {
  while (activeCount < MAX_CONCURRENT && waitQueue.length > 0) {
    const next = waitQueue.shift();
    if (!next) break;
    activeCount += 1;
    next.run();
  }
}

/**
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
function runQueuedLlmTask(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeCount = Math.max(0, activeCount - 1);
          pumpQueue();
        });
    };

    if (activeCount < MAX_CONCURRENT) {
      activeCount += 1;
      run();
      return;
    }

    waitQueue.push({ run, reject });
  });
}

function getLlmQueueStats() {
  return {
    max_concurrent: MAX_CONCURRENT,
    pending: waitQueue.length,
    active: activeCount,
  };
}

module.exports = {
  runQueuedLlmTask,
  getLlmQueueStats,
  MAX_CONCURRENT,
};
