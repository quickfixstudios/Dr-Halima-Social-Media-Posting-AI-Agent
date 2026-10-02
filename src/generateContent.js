import Anthropic from "@anthropic-ai/sdk";
import { config, requireEnv } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { DailyContentSchema, dailyContentJsonSchema } from "./schema.js";
import { SYSTEM_PROMPT, buildUserPrompt, buildRevisionPrompt } from "./prompts.js";
import { checkPostSafety, enforceCaptionRules } from "./safety.js";

const log = createLogger("generateContent");

let client;
function getClient() {
  requireEnv("ANTHROPIC_API_KEY");
  client ??= new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  return client;
}

async function callClaude(messages) {
  // Streaming avoids HTTP timeouts on long structured outputs; finalMessage() collects the result.
  // fallbacks: "default" re-runs a safety-classifier decline on Anthropic's recommended fallback model.
  const stream = getClient().beta.messages.stream({
    model: config.claude.model,
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    thinking: { type: "adaptive" },
    output_config: {
      effort: config.claude.effort,
      format: { type: "json_schema", schema: dailyContentJsonSchema },
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

function parseAndValidate(text) {
  const result = DailyContentSchema.safeParse(JSON.parse(text));
  if (!result.success) {
    throw new Error(`Generated content failed validation: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data;
}

function safetyIssues(posts) {
  const issues = {};
  for (const post of posts) {
    const found = checkPostSafety(post);
    if (found.length) issues[post.post_number] = found;
  }
  return issues;
}

/**
 * Generate the day's 5 posts with Claude.
 * @param {{ date: string, plan: { pillars: string[] }, insights: object }} input
 * @returns {Promise<{ posts: object[], flagged: Record<number, string[]> }>}
 */
export async function generateContent({ date, plan, insights }) {
  const messages = [{ role: "user", content: buildUserPrompt({ date, plan, insights }) }];
  log.info("Generating content", { date, pillars: plan.pillars });

  let content;
  let lastMessage;
  for (let attempt = 1; ; attempt++) {
    try {
      const { message, text } = await callClaude(messages);
      content = parseAndValidate(text);
      lastMessage = message;
      break;
    } catch (err) {
      log.error("Content generation attempt failed", { attempt, ...errorMeta(err) });
      if (attempt >= 2 || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError) throw err;
    }
  }

  // One self-revision round for anything the rule-based safety check flags.
  let flagged = safetyIssues(content.posts);
  if (Object.keys(flagged).length) {
    log.warn("Safety review flagged posts, requesting revision", { flagged });
    // Append the full response content (append-only history keeps thinking blocks valid).
    messages.push({ role: "assistant", content: lastMessage.content });
    messages.push({ role: "user", content: buildRevisionPrompt(flagged) });
    try {
      const { text } = await callClaude(messages);
      content = parseAndValidate(text);
      flagged = safetyIssues(content.posts);
    } catch (err) {
      log.error("Safety revision failed; keeping original with flags", errorMeta(err));
    }
  }

  const posts = content.posts
    .sort((a, b) => a.post_number - b.post_number)
    .map(enforceCaptionRules);
  return { posts, flagged };
}
