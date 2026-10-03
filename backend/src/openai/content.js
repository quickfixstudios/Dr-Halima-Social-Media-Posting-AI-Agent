import { imagingConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { withRetry } from "../retry.js";
import { openai, OpenAI } from "./client.js";

const log = createLogger("content");

/** Thrown for failures that retrying the same request will not fix. */
export class PermanentError extends Error {}

const noRetryFor = (err) => !(err instanceof PermanentError || err instanceof OpenAI.BadRequestError || err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError);

/**
 * One structured-output call to the Responses API.
 * @returns {Promise<{ json: object, text: string, response: object }>}
 */
export async function structuredCall({ instructions, input, format, maxOutputTokens, label, model = imagingConfig().textModel }) {
  let tokens = maxOutputTokens;
  return withRetry(
    async () => {
      const response = await openai().responses.create({
        model,
        instructions,
        input,
        text: { format },
        max_output_tokens: tokens,
        store: false,
      });
      log.info(`${label} response`, { id: response.id, status: response.status, usage: response.usage });

      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason;
        if (reason === "max_output_tokens") tokens = Math.round(tokens * 1.5);
        const message = `${label}: response incomplete (${reason})`;
        // Retry only when the fix is more output room; anything else (e.g. content filter) is permanent.
        throw reason === "max_output_tokens" ? new Error(message) : new PermanentError(message);
      }
      const message = response.output?.find((o) => o.type === "message");
      const refusal = message?.content?.find((c) => c.type === "refusal");
      if (refusal) throw new PermanentError(`${label}: model refused (${refusal.refusal})`);
      const text = response.output_text ?? message?.content?.find((c) => c.type === "output_text")?.text;
      if (!text) throw new Error(`${label}: empty output`);
      return { json: JSON.parse(text), text, response };
    },
    { label, shouldRetry: noRetryFor },
  );
}
