import { z } from "zod";
import { config } from "./config.js";
import { SLOTS } from "./schedule.js";

export const PILLARS = ["Education", "Myth vs Fact", "Warning/Awareness", "Pregnancy", "Hormonal Health", "Emotional Support", "Preventive Tips"];
export const HOOK_PATTERNS = ["Curiosity", "Relatability", "Myth-breaking", "Gentle warning", "Reassurance"];
export const CONTENT_GOALS = ["save-worthy", "share-worthy", "authority-building"];

const Beat = z.object({
  start_s: z.number().min(0),
  end_s: z.number().positive(),
  section: z.enum(["Hook", "Explanation", "Insight", "CTA"]),
  visual: z.string(),
  voiceover: z.string(),
  on_screen_text: z.string(),
});

const Slide = z.object({
  slide_number: z.number().int().positive(),
  headline: z.string().min(1),
  body: z.string(),
  visual_direction: z.string(),
});

export const PostSchema = z.object({
  id: z.string(),
  scheduled_slot: z.enum(SLOTS),
  post_type: z.enum(["reel", "image", "carousel"]),
  content_pillar: z.enum(PILLARS),
  topic: z.string().min(3),
  hook_pattern: z.enum(HOOK_PATTERNS),
  content_goal: z.enum(CONTENT_GOALS),
  hook_english: z.string().min(3),
  hook_bangla_short: z.string(),
  script: z.string(),
  video_storyboard: z.array(Beat),
  caption: z.string().min(40),
  visual_prompt: z.string().min(20),
  carousel_slides: z.array(Slide),
  hashtags: z.array(z.string()),
  cta: z.string().min(2),
});

export const BatchSchema = z.object({ daily_batch: z.array(PostSchema) });

/** Per-post format rules beyond the JSON schema. Returns a list of problems. */
export function postProblems(post) {
  const p = [];
  if (post.post_type === "reel") {
    const beats = post.video_storyboard;
    const length = beats.at(-1)?.end_s ?? 0;
    if (length < 20 || length > 40) p.push(`reel length ${length}s must be 20–40s`);
    if (!beats.length || beats[0].end_s > 3) p.push("hook beat must end by 3s");
    if (beats.length < 4) p.push("storyboard needs hook, explanation, insights and CTA beats");
    if (post.script.trim().length < 80) p.push("reel needs a full script");
    if (post.carousel_slides.length) p.push("reel must have carousel_slides = []");
  }
  if (post.post_type === "carousel" && (post.carousel_slides.length < 5 || post.carousel_slides.length > 7)) {
    p.push(`carousel needs 5–7 slides (has ${post.carousel_slides.length})`);
  }
  if (post.post_type === "image" && post.carousel_slides.length !== 1) p.push("image post needs exactly 1 overlay slide");
  if (post.post_type !== "reel" && (post.script || post.video_storyboard.length)) p.push("only reels have script/storyboard");
  if (post.hashtags.length < 6 || post.hashtags.length > 10) p.push("needs 6–10 hashtags");
  if (!post.hashtags.some((h) => h.toLowerCase() === "#drhalima")) p.push("hashtags must include #DrHalima");
  if (post.hashtags.some((h) => !/^#\S+$/.test(h))) p.push("every hashtag must start with # and contain no spaces");
  if (post.caption.length > 1800) p.push("caption over 1,800 characters");
  return p;
}

/**
 * Validate a whole batch against the daily rules.
 * @returns {{ ok: boolean, batch?: object, problems: string[] }}
 */
export function validateBatch(raw, { plan, recentTopics = [], reelSlots = config.schedule.reelSlots } = {}) {
  const parsed = BatchSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  const posts = parsed.data.daily_batch;
  const problems = [];
  if (posts.length !== 5) problems.push(`expected 5 posts, got ${posts.length}`);
  const uniq = (key) => new Set(posts.map((x) => String(x[key]).toLowerCase())).size === posts.length;
  for (const key of ["scheduled_slot", "content_pillar", "topic", "hook_pattern"]) if (!uniq(key)) problems.push(`${key} must be unique`);
  const reels = posts.filter((x) => x.post_type === "reel").map((x) => x.scheduled_slot).sort();
  if (reels.join() !== [...reelSlots].sort().join()) problems.push(`reels must be exactly at ${reelSlots.join(" and ")} (got ${reels.join(", ") || "none"})`);
  if (!posts.some((x) => x.post_type === "carousel")) problems.push("at least one carousel required");
  for (const g of CONTENT_GOALS) if (!posts.some((x) => x.content_goal === g)) problems.push(`missing content goal ${g}`);

  if (plan) {
    for (const slot of plan) {
      const post = posts.find((x) => x.scheduled_slot === slot.scheduled_slot);
      if (post && post.content_pillar !== slot.content_pillar) problems.push(`${slot.scheduled_slot} must use pillar "${slot.content_pillar}"`);
      if (post && slot.post_type && post.post_type !== slot.post_type) problems.push(`${slot.scheduled_slot} must be a ${slot.post_type}`);
    }
  }
  const recent = recentTopics.map((t) => t.toLowerCase());
  for (const post of posts) {
    const t = post.topic.toLowerCase();
    if (recent.some((r) => r === t || r.includes(t) || t.includes(r))) problems.push(`${post.scheduled_slot}: topic "${post.topic}" was used recently`);
    for (const issue of postProblems(post)) problems.push(`${post.scheduled_slot}: ${issue}`);
  }
  return { ok: problems.length === 0, batch: parsed.data, problems };
}
