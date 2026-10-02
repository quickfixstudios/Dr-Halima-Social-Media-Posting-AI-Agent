import { createLogger, errorMeta } from "../logger.js";

const log = createLogger("retry");

/**
 * Retry an async fn with exponential backoff + jitter.
 * `shouldRetry(err)` decides whether an error is transient (429 / 5xx / network).
 */
export async function withRetry(fn, { label = "operation", retries = 3, baseMs = 1000, shouldRetry = isTransient } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !shouldRetry(err)) throw err;
      const delay = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
      log.warn(`${label} failed, retrying`, { attempt, delayMs: delay, ...errorMeta(err) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export function isTransient(err) {
  const status = err?.status ?? err?.response?.status;
  if (status === undefined) return true; // network / timeout
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
