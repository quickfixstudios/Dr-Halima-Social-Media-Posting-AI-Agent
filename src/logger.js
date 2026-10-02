import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
const logDir = path.resolve("./logs");
fs.mkdirSync(logDir, { recursive: true });

function write(level, scope, message, meta) {
  if (LEVELS[level] < threshold) return;
  const entry = { ts: new Date().toISOString(), level, scope, message, ...(meta && { meta }) };
  const line = JSON.stringify(entry);
  (level === "error" || level === "warn" ? console.error : console.log)(line);
  fs.appendFileSync(path.join(logDir, `${entry.ts.slice(0, 10)}.log`), line + "\n");
}

/** Structured JSON logger: one line per event, to stdout and logs/YYYY-MM-DD.log. */
export function createLogger(scope) {
  return {
    debug: (msg, meta) => write("debug", scope, msg, meta),
    info: (msg, meta) => write("info", scope, msg, meta),
    warn: (msg, meta) => write("warn", scope, msg, meta),
    error: (msg, meta) => write("error", scope, msg, meta),
  };
}

export function errorMeta(err) {
  return { name: err?.name, message: err?.message, status: err?.status, stack: err?.stack?.split("\n").slice(0, 4).join(" | ") };
}
