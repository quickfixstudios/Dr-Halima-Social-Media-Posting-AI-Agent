import { createLogger, errorMeta } from "./logger.js";

const log = createLogger("retry");

export function isTransient(err) {
  const status = err?.status;
  if (status === undefined) return true; // network error / timeout
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Run fn up to `attempts` times with exponential backoff + jitter (default: 3 attempts). */
export async function withRetry(fn, { label, attempts = 3, baseMs = 2000, shouldRetry = isTransient, sleep = defaultSleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts || !shouldRetry(err)) throw err;
      const delay = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
      log.warn(`${label} failed, retrying`, { attempt, delayMs: delay, ...errorMeta(err) });
      await sleep(delay);
    }
  }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
