import { z } from "zod";

export const PILLARS = [
  "Education",
  "Myth vs Fact",
  "Early Warning Signs",
  "Pregnancy Care",
  "Hormonal Health",
  "Emotional Reassurance",
  "Preventive Tips",
];

export const HOOK_STYLES = ["Curiosity", "Relatable", "Myth-breaking", "Reassurance", "Warning (non-alarmist)"];

export const PostSchema = z.object({
  post_number: z.number().int().min(1).max(5),
  post_type: z.enum(["reel", "image", "carousel"]),
  content_pillar: z.enum(PILLARS),
  topic: z.string().min(5),
  target_audience_segment: z.string().min(3),
  hook_style: z.enum(HOOK_STYLES),
  hook_english: z.string().min(5).max(140),
  hook_bangla: z.string(),
  script_or_slide_content: z.string().min(50),
  caption: z.string().min(50),
  visual_prompt: z.string().min(30),
  hashtags: z.array(z.string().regex(/^#\S+$/)).min(3).max(15),
  cta: z.string().min(3),
});

export const DailyContentSchema = z
  .object({ posts: z.array(PostSchema).length(5) })
  .superRefine((data, ctx) => {
    const reels = data.posts.filter((p) => p.post_type === "reel").length;
    if (reels !== 2) ctx.addIssue({ code: "custom", message: `Expected exactly 2 reels, got ${reels}` });
    const unique = (key) => new Set(data.posts.map((p) => p[key].toLowerCase())).size === data.posts.length;
    if (!unique("topic")) ctx.addIssue({ code: "custom", message: "Topics must be unique" });
    if (!unique("content_pillar")) ctx.addIssue({ code: "custom", message: "Each post must use a different pillar" });
    if (!unique("hook_style")) ctx.addIssue({ code: "custom", message: "Each post must use a different hook style" });
  });

/** JSON Schema handed to Claude's structured-output mode (output_config.format). */
export const dailyContentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["posts"],
  properties: {
    posts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "post_number", "post_type", "content_pillar", "topic", "target_audience_segment", "hook_style",
          "hook_english", "hook_bangla", "script_or_slide_content", "caption", "visual_prompt", "hashtags", "cta",
        ],
        properties: {
          post_number: { type: "integer" },
          post_type: { type: "string", enum: ["reel", "image", "carousel"] },
          content_pillar: { type: "string", enum: PILLARS },
          topic: { type: "string" },
          target_audience_segment: { type: "string" },
          hook_style: { type: "string", enum: HOOK_STYLES },
          hook_english: { type: "string" },
          hook_bangla: { type: "string" },
          script_or_slide_content: { type: "string" },
          caption: { type: "string" },
          visual_prompt: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
          cta: { type: "string" },
        },
      },
    },
  },
};
