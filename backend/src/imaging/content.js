import { z } from "zod";
import { ImageError } from "./errors.js";

/**
 * The approved post the image pipeline receives (one JSON object per post — see posts/dr_halima/samples/).
 * Only `post_id`, `topic`, `hook` and `caption` are required; everything else improves the result.
 */
const Stat = z.object({ value: z.string().min(1), label: z.string().min(1), source: z.string().min(1), source_url: z.string().optional() });
const Column = z.object({ title: z.string().min(1), items: z.array(z.string().min(1)).min(1) });

export const PostSchema = z.object({
  post_id: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/, "post_id may only contain letters, digits, . _ -"),
  business: z.string().optional(),
  platform: z.string().default("facebook"),
  topic: z.string().trim().min(1, "topic is empty"),
  content_type: z.string().default(""),
  hook: z.string().trim().min(1, "hook is empty"),
  subtitle: z.string().default(""),
  caption: z.string().trim().min(1, "caption is empty"),
  cta: z.string().default(""),
  hashtags: z.string().default(""),
  audience: z.string().default(""),
  language: z.string().default("bn"),
  goal: z.string().default(""),
  content_status: z.string().default("draft"),
  key_points: z.array(z.string().min(1)).default([]),
  myth: z.string().default(""),
  fact: z.string().default(""),
  columns: z.object({ left: Column, right: Column }).optional(),
  slides: z.array(z.object({ title: z.string().min(1), body: z.string().default("") })).default([]),
  verified_statistics: z.array(Stat).default([]),
  scheduled_time: z.string().default(""),
  visual_type: z.string().default(""),
  aspect_ratio: z.string().default(""),
});

/** Validate a raw post object. Throws ImageError("INVALID_CONTENT") with every problem listed. */
export function normalizePost(raw) {
  if (!raw || typeof raw !== "object") throw new ImageError("INVALID_CONTENT", "Post must be a JSON object");
  const input = { ...raw, post_id: raw.post_id ?? raw.id };
  const parsed = PostSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "post"}: ${i.message}`);
    const code = problems.some((p) => p.startsWith("caption")) ? "EMPTY_CAPTION" : "INVALID_CONTENT";
    throw new ImageError(code, `Post is not usable: ${problems.join("; ")}`, { problems });
  }
  const post = parsed.data;
  if (!post.key_points.length) post.key_points = extractListItems(post.caption);
  return post;
}

const BULLET = /^\s*(?:[০-৯0-9]{1,2}\s*[.)।:-]|[-•●▪✔✓✅❌⚠️🔹🔸👉*])\s*(.+)$/u;

/** Numbered or bulleted lines in a caption ("১. …", "2) …", "• …") — reused as on-image list items. */
export function extractListItems(caption) {
  return caption
    .split(/\r?\n/)
    .map((line) => line.match(BULLET)?.[1]?.trim())
    .filter(Boolean);
}

/**
 * Adapter for posts produced by the existing content engine (prompts/daily_batch.schema.json / Content sheet rows),
 * so the same records can be sent straight into the image pipeline.
 */
export function fromContentRecord(record, { business } = {}) {
  const PILLAR_TO_TYPE = {
    Education: "educational",
    "Myth vs Fact": "myth_vs_fact",
    "Warning/Awareness": "warning",
    Pregnancy: "pregnancy",
    "Hormonal Health": "menstrual",
    "Emotional Support": "emotional",
    "Preventive Tips": "checklist",
  };
  const slides = record.carousel_slides ?? [];
  return {
    post_id: record.id,
    business,
    platform: "facebook",
    topic: record.topic,
    content_type: record.post_type === "carousel" ? "carousel" : PILLAR_TO_TYPE[record.content_pillar] ?? "",
    hook: record.hook_bangla_short || record.hook_english || record.topic,
    caption: record.caption,
    cta: record.cta ?? "",
    goal: { "save-worthy": "save", "share-worthy": "share", "authority-building": "trust" }[record.content_goal] ?? "",
    content_status: ["ready", "published", "publishing"].includes(record.status) ? "approved" : record.status ?? "draft",
    key_points: slides.length > 1 ? slides.map((s) => s.headline) : [],
    scheduled_time: record.scheduled_at ?? "",
  };
}

/** Text the post's author approved — the only source on-image text may be taken from. */
export function approvedSources(post) {
  return [
    post.topic,
    post.hook,
    post.subtitle,
    post.caption,
    post.cta,
    post.myth,
    post.fact,
    ...post.key_points,
    ...post.slides.flatMap((x) => [x.title, x.body]),
    ...(post.columns ? [post.columns.left.title, ...post.columns.left.items, post.columns.right.title, ...post.columns.right.items] : []),
    ...post.verified_statistics.flatMap((s) => [s.value, s.label, s.source]),
  ].filter(Boolean);
}
