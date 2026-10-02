import Anthropic from "@anthropic-ai/sdk";
import { config, requireEnv } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { DailyBatchSchema, dailyBatchJsonSchema, slotIndex } from "./schema.js";
import { SYSTEM_PROMPT, buildUserPrompt, buildRevisionPrompt } from "./prompts.js";
import { checkPostSafety, enforceCaptionRules } from "./safety.js";

const log = createLogger("generateContent");

let client;
function getClient() {
  requireEnv("ANTHROPIC_API_KEY");
  client ??= new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  return client;
}

/**
 * One Claude call. Streaming avoids HTTP timeouts on long structured outputs;
 * `fallbacks: "default"` re-runs a safety-classifier decline on Anthropic's
 * recommended fallback model inside the same request.
 */
async function callClaude(messages) {
  const stream = getClient().beta.messages.stream({
    model: config.claude.model,
    max_tokens: 48000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: config.claude.effort,
      format: { type: "json_schema", schema: dailyBatchJsonSchema },
    },
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages,
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    throw new Error(`Claude declined the request (${message.stop_details?.category ?? "unknown category"})`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Claude output hit max_tokens before the JSON was complete");
  }

  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  log.info("Claude response received", {
    model: message.model,
    input_tokens: message.usage.input_tokens,
    output_tokens: message.usage.output_tokens,
    cache_read_input_tokens: message.usage.cache_read_input_tokens,
  });
  return { message, text };
}

/** Parse + validate; returns { batch, problems } where problems are per-post format issues. */
function parseBatch(text, plan) {
  const raw = JSON.parse(text);
  const result = DailyBatchSchema.safeParse(raw);
  const problems = {};
  if (!result.success) {
    for (const issue of result.error.issues) {
      const id = raw.daily_batch?.[issue.path[1]]?.id ?? "batch";
      (problems[id] ??= []).push(`${issue.path.slice(2).join(".") || "post"}: ${issue.message}`);
    }
  }
  // The decision system fixed type / pillar / hook / goal per slot — enforce it.
  for (const post of raw.daily_batch ?? []) {
    const slot = plan.find((s) => s.scheduled_slot === post.scheduled_slot);
    if (!slot) continue;
    for (const key of ["post_type", "content_pillar", "hook_pattern", "content_goal"]) {
      if (post[key] !== slot[key]) (problems[post.id] ??= []).push(`${key} must be "${slot[key]}"`);
    }
  }
  return { batch: raw, valid: result.success && !Object.keys(problems).length, problems };
}

function safetyIssues(posts) {
  const issues = {};
  for (const post of posts) {
    const found = checkPostSafety(post);
    if (found.length) issues[post.id] = found;
  }
  return issues;
}

/**
 * Generate the day's 5 posts with Claude (STEP 2 topic + all copy), following the
 * slot plan the learning system chose (STEP 1, 3, 4).
 * @returns {Promise<{ posts: object[], flagged: Record<string, string[]> }>}
 */
export async function generateContent({ date, plan, insights, topicSuggestions }) {
  const messages = [{ role: "user", content: buildUserPrompt({ date, plan, insights, topicSuggestions }) }];
  log.info("Generating content", { date, plan });

  let parsed;
  let lastMessage;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let text;
    try {
      ({ message: lastMessage, text } = await callClaude(messages));
    } catch (err) {
      log.error("Claude call failed", { attempt, ...errorMeta(err) });
      if (attempt === 3 || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError) throw err;
      continue;
    }
    parsed = parseBatch(text, plan);
    const issues = { ...parsed.problems };
    for (const [id, list] of Object.entries(safetyIssues(parsed.batch.daily_batch ?? []))) (issues[id] ??= []).push(...list);
    if (!Object.keys(issues).length) break;

    log.warn("Batch needs revision", { attempt, issues });
    if (attempt === 3) break;
    // Append the full response (append-only history keeps thinking blocks valid), then ask for fixes.
    messages.push({ role: "assistant", content: lastMessage.content });
    messages.push({ role: "user", content: buildRevisionPrompt(issues) });
  }

  if (!parsed?.batch?.daily_batch?.length) throw new Error("Claude returned no usable batch");
  if (!parsed.valid) {
    throw new Error(`Batch still invalid after revisions: ${JSON.stringify(parsed.problems)}`);
  }

  const posts = parsed.batch.daily_batch
    .map((p) => ({ ...enforceCaptionRules(p), id: `${date}-${slotIndex(p.scheduled_slot) + 1}` }))
    .sort((a, b) => slotIndex(a.scheduled_slot) - slotIndex(b.scheduled_slot));
  return { posts, flagged: safetyIssues(posts) };
}
