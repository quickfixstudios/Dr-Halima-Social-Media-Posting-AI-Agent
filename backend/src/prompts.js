import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Prompts live in the repo root /prompts so Make (Mode A) and the backend use the same files.
const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = process.env.PROMPTS_DIR ?? path.resolve(here, "../../prompts");
const read = (name) => fs.readFileSync(path.join(PROMPTS_DIR, name), "utf8");

export const SYSTEM_PROMPT = read("system.prompt.md");
export const USER_TEMPLATE = read("user.prompt.template.md");
export const COMPLIANCE_PROMPT = read("compliance.prompt.md");
export const BATCH_FORMAT = JSON.parse(read("daily_batch.schema.json"));
export const COMPLIANCE_FORMAT = JSON.parse(read("compliance.schema.json"));

const bullets = (items, render, empty) => (items.length ? items.map((x) => `- ${render(x)}`).join("\n") : empty);

/** Fill {{placeholders}} in the user template from the learning context. */
export function buildUserPrompt({ date, plan, insights, topicIdeas = {} }) {
  const planLines = plan.map(
    (s) => `- ${s.scheduled_slot} (${s.time}): ${s.post_type} | pillar: ${s.content_pillar}${topicIdeas[s.content_pillar]?.length ? ` | topic ideas: ${topicIdeas[s.content_pillar].join("; ")}` : ""}`,
  );
  const values = {
    run_date: date,
    daily_plan: planLines.join("\n"),
    top_performers: bullets(insights.winningTopics, (t) => `[${t.pillar}] ${t.topic} (×${t.score} median)`, "(not enough data yet)"),
    top_hooks: bullets(insights.winningHooks, (h) => `(${h.pattern}) ${h.hook}`, "(not enough data yet)"),
    low_performers: bullets(insights.losingTopics, (t) => `[${t.pillar}] ${t.topic}`, "(none)"),
    recent_topics: bullets(insights.recentTopics, (t) => t, "(none)"),
    recent_hooks: bullets(insights.recentHooks, (h) => h, "(none)"),
    format_performance: Object.entries(insights.formatPerformance)
      .sort((a, b) => b[1].score - a[1].score)
      .map(([k, v]) => `${k} ×${v.score.toFixed(2)}`)
      .join(", ") || "(not enough data yet)",
  };
  return USER_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in values ? values[key] : m));
}

export function buildRevisionPrompt(problems) {
  return `The batch failed validation. Fix every problem below, keep everything else identical, and return the full JSON object again:\n${problems.map((p) => `- ${p}`).join("\n")}`;
}
