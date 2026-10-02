import OpenAI from "openai";
import { requireConfig } from "../config.js";

let client;
/** Shared OpenAI client. SDK retries are disabled — withRetry() owns retry policy (3 attempts). */
export function openai() {
  requireConfig(["OPENAI_API_KEY", process.env.OPENAI_API_KEY]);
  client ??= new OpenAI({ maxRetries: 0, timeout: 5 * 60 * 1000 });
  return client;
}
export { OpenAI };
