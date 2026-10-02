import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

/** Structured JSON-lines logger (one line per event, stdout/stderr). */
export function createLogger(scope) {
  const write = (level) => (msg, meta = {}) => {
    if (LEVELS[level] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...meta });
    (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line + "\n");
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

export const errorMeta = (err) => ({ error: err?.message, status: err?.status, name: err?.name });
