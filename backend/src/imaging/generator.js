import { withRetry, isTransient } from "../retry.js";
import { openai } from "../openai/client.js";
import { ImageError } from "./errors.js";

/**
 * One call to the OpenAI Images API (official SDK). The API key is read from OPENAI_API_KEY by the SDK
 * on the server only — it is never logged, stored in metadata or sent anywhere else.
 *
 * Retries (with exponential back-off) only on temporary problems: rate limits, timeouts, 5xx errors.
 * A 400 (bad request / content policy), 401 (bad key) or "insufficient_quota" is never retried.
 *
 * @returns {Promise<{ buffer: Buffer, model: string, size: string, quality: string, usage: object|null, requestId: string|null, attempts: number }>}
 */
export async function generateBackground({ prompt, size, quality, model, timeoutMs, retries = 3, client, sleep, onRetry }) {
  let api;
  try {
    api = client ?? openai();
  } catch (err) {
    if (/OPENAI_API_KEY/.test(err.message)) throw new ImageError("MISSING_API_KEY", "OPENAI_API_KEY is not set. Add it to backend/.env (see IMAGE_AUTOMATION.md → Setup).");
    throw err;
  }
  let attempts = 0;
  const shouldRetry = (err) => err?.code !== "insufficient_quota" && err?.error?.code !== "insufficient_quota" && isTransient(err);
  const { data, request_id } = await withRetry(
    async () => {
      attempts += 1;
      return api.images.generate({ model, prompt, size, quality, output_format: "png", n: 1 }, { timeout: timeoutMs }).withResponse();
    },
    {
      label: `image ${model}`,
      attempts: Math.max(1, retries),
      shouldRetry: (err) => {
        const retry = shouldRetry(err);
        if (retry) onRetry?.(err, attempts);
        return retry;
      },
      ...(sleep && { sleep }),
    },
  );
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) throw new ImageError("NO_IMAGE_RETURNED", `OpenAI answered but returned no image (request ${request_id ?? "unknown"})`);
  return { buffer: Buffer.from(b64, "base64"), model, size, quality, usage: data.usage ?? null, requestId: request_id ?? null, attempts };
}
