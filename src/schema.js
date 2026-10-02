import { z } from "zod";

export const PILLARS = [
  "Education",
  "Myth vs Fact",
  "Warning/Awareness",
  "Pregnancy Guidance",
  "Hormonal/Period Health",
  "Emotional Support",
  "Preventive Tips",
];

// Maps pillar names used by earlier versions so old history still feeds the learning loop.
export const PILLAR_ALIASES = {
  "Early Warning Signs": "Warning/Awareness",
  "Pregnancy Care": "Pregnancy Guidance",
  "Hormonal Health": "Hormonal/Period Health",
  "Emotional Reassurance": "Emotional Support",
};

export const HOOK_PATTERNS = ["Curiosity", "Relatability", "Myth-breaking", "Gentle warning", "Reassurance"];
export const CONTENT_GOALS = ["save-worthy", "share-worthy", "authority-building"];
export const SLOTS = ["slot1", "slot2", "slot3", "slot4", "slot5"];

const StoryboardBeat = z.object({
  start_s: z.number().min(0),
  end_s: z.number().positive(),
  section: z.string(),
  visual: z.string(),
  voiceover: z.string(),
  on_screen_text: z.string(),
});

const Slide = z.object({
  slide_number: z.number().int().positive(),
  headline: z.string().min(3),
  body: z.string(),
  visual_direction: z.string(),
});

export const PostSchema = z
  .object({
    id: z.string().min(1),
    scheduled_slot: z.enum(SLOTS),
    post_type: z.enum(["reel", "image", "carousel"]),
    content_pillar: z.enum(PILLARS),
    topic: z.string().min(5),
    hook_pattern: z.enum(HOOK_PATTERNS),
    content_goal: z.enum(CONTENT_GOALS),
    target_audience_segment: z.string().min(3),
    hook_english: z.string().min(5).max(140),
    hook_bangla_short: z.string().max(60),
    script: z.string(),
    video_storyboard: z.array(StoryboardBeat),
    caption: z.string().min(50),
    key_takeaways: z.array(z.string().min(5)).min(1).max(2),
    visual_prompt: z.string().min(30),
    carousel_slides: z.array(Slide),
    hashtags: z.array(z.string().regex(/^#\S+$/)).min(3).max(15),
    cta: z.string().min(3),
    alt_text: z.string().min(10).max(250),
    estimated_length_seconds: z.number().min(0),
    notes_for_editor: z.string(),
  })
  .superRefine((p, ctx) => {
    const issue = (message) => ctx.addIssue({ code: "custom", message: `${p.id}: ${message}` });
    if (p.post_type === "reel") {
      if (p.estimated_length_seconds < 20 || p.estimated_length_seconds > 40) issue("reels must be 20–40 s");
      if (p.video_storyboard.length < 4) issue("reels need a storyboard (hook, explanation, insights, CTA)");
      if (p.video_storyboard[0]?.end_s > 3) issue("hook must land within the first 3 seconds");
      if (p.script.length < 100) issue("reels need a script");
    } else {
      if (p.post_type === "carousel" && p.carousel_slides.length < 4) issue("carousels need at least 4 slides");
      if (p.post_type === "image" && p.carousel_slides.length !== 1) issue("image posts carry exactly one overlay slide");
    }
  });

export const DailyBatchSchema = z
  .object({ daily_batch: z.array(PostSchema).length(5) })
  .superRefine(({ daily_batch: posts }, ctx) => {
    const issue = (message) => ctx.addIssue({ code: "custom", message });
    const reels = posts.filter((p) => p.post_type === "reel").length;
    if (reels !== 2) issue(`expected exactly 2 reels, got ${reels}`);
    const unique = (key) => new Set(posts.map((p) => String(p[key]).toLowerCase())).size === posts.length;
    for (const key of ["id", "scheduled_slot", "topic", "content_pillar", "hook_pattern"]) {
      if (!unique(key)) issue(`${key} must be unique across the batch`);
    }
    for (const goal of CONTENT_GOALS) {
      if (!posts.some((p) => p.content_goal === goal)) issue(`batch needs at least one ${goal} post`);
    }
  });

export const slotIndex = (slot) => SLOTS.indexOf(slot);

const str = { type: "string" };
const num = { type: "number" };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });

/** JSON Schema handed to Claude's structured-output mode (output_config.format). */
export const dailyBatchJsonSchema = obj({
  daily_batch: {
    type: "array",
    items: obj({
      id: str,
      scheduled_slot: { type: "string", enum: SLOTS },
      post_type: { type: "string", enum: ["reel", "image", "carousel"] },
      content_pillar: { type: "string", enum: PILLARS },
      topic: str,
      hook_pattern: { type: "string", enum: HOOK_PATTERNS },
      content_goal: { type: "string", enum: CONTENT_GOALS },
      target_audience_segment: str,
      hook_english: str,
      hook_bangla_short: str,
      script: str,
      video_storyboard: {
        type: "array",
        items: obj({ start_s: num, end_s: num, section: str, visual: str, voiceover: str, on_screen_text: str }),
      },
      caption: str,
      key_takeaways: { type: "array", items: str },
      visual_prompt: str,
      carousel_slides: {
        type: "array",
        items: obj({ slide_number: { type: "integer" }, headline: str, body: str, visual_direction: str }),
      },
      hashtags: { type: "array", items: str },
      cta: str,
      alt_text: str,
      estimated_length_seconds: num,
      notes_for_editor: str,
    }),
  },
});

/** Performance feedback record (one per post, refreshed on every sync). */
export const PerformanceRecordSchema = z.object({
  post_id: z.string(),
  likes: z.number().int().min(0),
  comments: z.number().int().min(0),
  shares: z.number().int().min(0),
  saves: z.number().int().min(0),
  engagement_score: z.number().min(0),
});
