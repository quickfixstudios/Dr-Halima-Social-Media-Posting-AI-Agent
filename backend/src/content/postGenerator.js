import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { REPO_ROOT, imagingConfig } from "../config.js";
import { structuredCall } from "../openai/content.js";
import { ICON_KEYS } from "../imaging/overlay/icons.js";

/**
 * One Facebook post from the shared prompt (prompts/facebook_post.system.md — the same rules the live Make
 * scenario uses), turned into a draft post file the image pipeline understands.
 */
export const CONTENT_TYPES = {
  pain_solution: { label: "Pain → Solution", pipelineType: "pain_solution", goal: "awareness" },
  myth_vs_fact: { label: "Myth vs Fact", pipelineType: "myth_vs_fact", goal: "share" },
  educational_carousel: { label: "Educational Carousel", pipelineType: "carousel", goal: "save" },
  emotional_story: { label: "Emotional Story", pipelineType: "emotional", goal: "connection" },
  data_statistics: { label: "Data/Statistics", pipelineType: "statistic", goal: "awareness" },
  call_to_action: { label: "Call-to-Action", pipelineType: "appointment", goal: "conversion" },
  doctor_trust: { label: "Doctor Trust", pipelineType: "doctor_authority", goal: "trust" },
};
const PILLARS = ["Education", "Myth vs Fact", "Warning/Awareness", "Pregnancy", "Hormonal Health", "Emotional Support", "Preventive Tips"];

export function loadFacts(file = path.join(REPO_ROOT, "prompts/verified_facts.json")) {
  return JSON.parse(fs.readFileSync(file, "utf8")).facts;
}

export const VISUAL_FORMATS = {
  tips_poster: "tips_poster",
  warning_grid: "warning",
  condition_awareness: "condition",
  stat_visual: "statistic",
  stage_columns: "timeline",
  myth_table: "myth_vs_fact",
  carousel: "carousel",
  story_picture: null, // keep the content type's own picture style
};

/** Shared post rules + (backend only) the infographic structure with few-shot examples. */
export function systemPrompt({ promptFile = path.join(REPO_ROOT, "prompts/facebook_post.system.md"), facts = loadFacts(), infographic = true } = {}) {
  const lines = facts.map((f) => `- [${f.id}] ${f.fact_bn} (সূত্র: ${f.source_bn})`).join("\n");
  const base = fs.readFileSync(promptFile, "utf8").replace("{{VERIFIED_FACTS}}", lines);
  if (!infographic) return base;
  const examples = fs.readFileSync(path.join(REPO_ROOT, "prompts/infographic_examples.md"), "utf8").replace("{icons}", ICON_KEYS.join(", "));
  return `${base}\n${examples}`;
}

const str = { type: "string" };
export function outputFormat(facts = loadFacts()) {
  return {
    type: "json_schema",
    name: "facebook_post",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["content_type", "visual_format", "topic", "hook", "caption", "hashtags", "overlay_main", "overlay_sub", "items", "stages", "key_points", "myths", "fact_id", "image_prompt", "alt_text", "file_name_suggestion", "confidence"],
      properties: {
        content_type: { type: "string", enum: Object.keys(CONTENT_TYPES) },
        visual_format: { type: "string", enum: Object.keys(VISUAL_FORMATS) },
        items: { type: "array", items: { type: "object", additionalProperties: false, required: ["icon", "label", "detail"], properties: { icon: { type: "string", enum: ICON_KEYS }, label: str, detail: str } } },
        stages: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "points"], properties: { title: str, points: { type: "array", items: str } } } },
        topic: str,
        hook: str,
        caption: str,
        hashtags: str,
        overlay_main: str,
        overlay_sub: str,
        key_points: { type: "array", items: str, description: "The 2-5 key points / steps exactly as written in the caption, without the leading ✅ or number" },
        myths: { type: "array", items: { type: "object", additionalProperties: false, required: ["myth", "fact"], properties: { myth: str, fact: str } }, description: "Myth vs Fact only (1-4 pairs, as in the caption); otherwise []" },
        fact_id: { type: "string", enum: ["", ...facts.map((f) => f.id)], description: "Data/Statistics only: the id of the VERIFIED FACT used; otherwise empty" },
        image_prompt: str,
        alt_text: { type: "string", description: "One short Bangla sentence describing the image for screen readers" },
        file_name_suggestion: { type: "string", description: "Lower-case ASCII file name, e.g. drhalima_myths_pregnancy_food.jpg" },
        confidence: { type: "number", description: "0-1: how sure you are the post follows every rule and the image will look like a clean professional infographic" },
      },
    },
  };
}

const CTA_LINE = /^\s*(📩|📌)\s*(.+)$/mu;
const LATIN = /[A-Za-z]/;

/** Model output → a draft post (same fields as posts/dr_halima/samples/*.json) + warnings for the reviewer. */
export function toDraftPost(out, { postId, business, facts = loadFacts(), now = DateTime.now() }) {
  const type = CONTENT_TYPES[out.content_type];
  const warnings = [];
  if (!type) throw new Error(`Unknown content type ${out.content_type}`);
  const fact = facts.find((f) => f.id === out.fact_id);
  if (out.content_type === "data_statistics" && !fact) warnings.push("Data/Statistics post without a verified fact — it will be blocked until one is added.");
  for (const [field, value] of [["hook", out.hook], ["overlay_main", out.overlay_main]]) {
    if (LATIN.test(value)) warnings.push(`${field} contains English letters — text on the image must be pure Bangla.`);
  }
  // The caption may mix in a few common English words (e.g. "Pregnancy test"), never whole English sentences.
  const englishWords = out.caption.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  if (englishWords.length > 5) warnings.push(`caption has ${englishWords.length} English words — the brand rule allows at most 5 simple ones.`);
  const cta = out.caption.match(CTA_LINE)?.[2]?.trim() ?? "";
  // The infographic format decides the image layout; otherwise the content type does.
  const formatType = VISUAL_FORMATS[out.visual_format];
  const onImage = [...(out.items ?? []).flatMap((i) => [i.label, i.detail]), ...(out.stages ?? []).flatMap((st) => st.points)].filter(Boolean);
  const missing = onImage.filter((x) => !out.caption.includes(x));
  if (missing.length) warnings.push(`On-image text not found word-for-word in the caption (reviewer must confirm): ${missing.join(" | ")}`);
  return {
    post_id: postId,
    business,
    platform: "facebook",
    topic: out.topic,
    content_type: formatType ?? type.pipelineType,
    goal: type.goal,
    hook: out.overlay_main || out.hook,
    subtitle: out.overlay_sub,
    caption: out.caption,
    cta,
    hashtags: out.hashtags,
    key_points: out.content_type === "myth_vs_fact" ? [] : out.key_points.slice(0, 5),
    items: (out.items ?? []).slice(0, 8),
    stages: (out.stages ?? []).slice(0, 4).map((st) => ({ title: st.title, points: st.points.slice(0, 4) })),
    myths: out.content_type === "myth_vs_fact" ? out.myths.slice(0, 4) : [],
    verified_statistics: fact ? [{ value: fact.value, label: fact.label_bn, source: fact.source_bn, source_url: fact.source_url }] : [],
    alt_text: out.alt_text ?? "",
    file_name_suggestion: (out.file_name_suggestion ?? "").toLowerCase().replace(/[^a-z0-9_.-]/g, "_"),
    content_status: "draft",
    generator: { content_type_label: type.label, visual_format: out.visual_format ?? "", created_at: now.toISO(), model: imagingConfig().textModel, image_prompt_suggestion: out.image_prompt, confidence: out.confidence ?? null, warnings },
  };
}

/**
 * Generate one draft post.
 * @param {{ type?: string, pillar?: string, topicNumber?: number, business?: string, call?: Function }} p
 */
export async function generatePost({ type, pillar, topicNumber, business = "dr_halima", call = structuredCall, now = DateTime.now().setZone("Asia/Dhaka") } = {}) {
  const facts = loadFacts();
  const t = type ?? Object.keys(CONTENT_TYPES)[Math.floor(Math.random() * 7)];
  if (!CONTENT_TYPES[t]) throw new Error(`Unknown type "${t}". Use one of: ${Object.keys(CONTENT_TYPES).join(", ")}`);
  const p = pillar ?? PILLARS[Math.floor(Math.random() * PILLARS.length)];
  const n = topicNumber ?? 1 + Math.floor(Math.random() * 10);
  const { json } = await call({
    label: "facebook post",
    instructions: systemPrompt({ facts }),
    input: [{ role: "user", content: `Today is ${now.toFormat("cccc d LLLL yyyy")} (Asia/Dhaka).\nContent type: ${CONTENT_TYPES[t].label}\nContent pillar: ${p}\nTopic number: ${n}\n\nWrite the post following the rules (pure Bangla on the image; the caption may mix in a few simple English words), self-check it, and return the JSON object.` }],
    format: outputFormat(facts),
    maxOutputTokens: 6000,
    model: imagingConfig().textModel,
  });
  const postId = `${now.toFormat("yyyyLLdd-HHmmss")}-${t}`;
  return toDraftPost({ ...json, content_type: json.content_type || t }, { postId, business, facts, now });
}
