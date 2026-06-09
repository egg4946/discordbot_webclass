import { fetchAssignments } from './webclass.js';

export async function fetchAssignmentsWithRetry(config, options = {}) {
  const attempts = options.attempts ?? config.retryAttempts ?? 3;
  const delayMs = options.delayMs ?? config.retryDelayMs ?? 30000;
  const fetcher = options.fetcher ?? fetchAssignments;
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetcher(config, options.fetchOptions);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }

      console.warn(
        `WebClass fetch failed (${attempt}/${attempts}). Retrying in ${delayMs}ms: ${error.message}`,
      );
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
