import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { withRetry } from "../retry.js";
import { openai, OpenAI } from "./client.js";
import { SYSTEM_PROMPT, COMPLIANCE_PROMPT, BATCH_FORMAT, COMPLIANCE_FORMAT, buildUserPrompt, buildRevisionPrompt } from "../prompts.js";
import { validateBatch } from "../validate.js";
import { slotIndex } from "../schedule.js";

const log = createLogger("content");

/** Thrown for failures that retrying the same request will not fix. */
export class PermanentError extends Error {}

const noRetryFor = (err) => !(err instanceof PermanentError || err instanceof OpenAI.BadRequestError || err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError);

/**
 * One structured-output call to the Responses API.
 * @returns {Promise<{ json: object, text: string, response: object }>}
 */
export async function structuredCall({ instructions, input, format, maxOutputTokens, label, model = config.openai.textModel }) {
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

/**
 * Generate and validate the daily batch. One targeted revision round on validation problems.
 * @returns {Promise<{ posts: object[], problems: string[] }>}  problems is empty when the batch is fully valid
 */
export async function generateBatch({ date, plan, insights, topicIdeas }) {
  const userPrompt = buildUserPrompt({ date, plan, insights, topicIdeas });
  const input = [{ role: "user", content: userPrompt }];
  let result;
  let validation;

  for (let round = 1; round <= 2; round++) {
    result = await structuredCall({ instructions: SYSTEM_PROMPT, input, format: BATCH_FORMAT, maxOutputTokens: 32000, label: `batch round ${round}` });
    validation = validateBatch(result.json, { plan, recentTopics: insights.recentTopics });
    if (validation.ok) break;
    log.warn("Batch failed validation", { round, problems: validation.problems });
    input.push({ role: "assistant", content: result.text }, { role: "user", content: buildRevisionPrompt(validation.problems) });
  }
  if (!validation.batch) throw new PermanentError(`Batch unusable: ${validation.problems.join("; ")}`);

  const posts = validation.batch.daily_batch
    .map((p) => ({ ...p, id: `${date}-${slotIndex(p.scheduled_slot) + 1}` }))
    .sort((a, b) => slotIndex(a.scheduled_slot) - slotIndex(b.scheduled_slot));
  return { posts, problems: validation.ok ? [] : validation.problems };
}

/** Stage-2 LLM compliance review. Returns null (never throws) so a review outage cannot stop the day. */
export async function reviewCompliance(posts) {
  try {
    const { json } = await structuredCall({
      instructions: COMPLIANCE_PROMPT,
      input: JSON.stringify({ daily_batch: posts }),
      format: COMPLIANCE_FORMAT,
      maxOutputTokens: 8000,
      label: "compliance",
    });
    return json;
  } catch (err) {
    log.error("Compliance review failed", { error: err.message });
    return null;
  }
}
