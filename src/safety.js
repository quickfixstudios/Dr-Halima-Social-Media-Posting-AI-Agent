export const DISCLAIMER =
  "This is for educational purposes only. Consult a qualified doctor for personal medical advice.";

// Patterns that suggest diagnosis, prescribing, guarantees or fear-based messaging.
const RED_FLAGS = [
  { re: /\b\d+(\.\d+)?\s?(mg|mcg|µg|iu|ml)\b/i, reason: "dosage / prescription detail" },
  { re: /\b(take|start|use)\s+(this|these)?\s*(tablet|pill|medicine|medication|supplement)s?\b/i, reason: "direct medication instruction" },
  { re: /\b(you (definitely|certainly) have|this means you have|you are suffering from)\b/i, reason: "diagnostic language" },
  { re: /\b(cure[sd]?|guaranteed?|100% (safe|effective)|miracle)\b/i, reason: "unqualified medical claim" },
  { re: /\b(will (definitely|always|never)|always works|never fails|proven to)\b/i, reason: "absolute claim" },
  { re: /\b(deadly|kill you|you could die|terrifying|horrifying)\b/i, reason: "fear-based messaging" },
  { re: /\b(graphic|blood[- ]soaked|surgery footage|nud(e|ity))\b/i, reason: "sensitive visual" },
];

/** All user-facing copy in a post, flattened for scanning. */
export function postText(post) {
  return [
    post.hook_english,
    post.script,
    ...(post.video_storyboard ?? []).flatMap((b) => [b.voiceover, b.on_screen_text]),
    ...(post.carousel_slides ?? []).flatMap((s) => [s.headline, s.body]),
    post.caption,
    ...(post.key_takeaways ?? []),
    post.cta,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Returns a list of issues; empty list means the post passed. */
export function checkPostSafety(post) {
  const issues = [];
  const text = postText(post);
  for (const { re, reason } of RED_FLAGS) {
    const match = text.match(re);
    if (match) issues.push(`${reason}: "${match[0]}"`);
  }
  for (const { re, reason } of RED_FLAGS.filter((f) => f.reason === "sensitive visual")) {
    if (re.test(post.visual_prompt)) issues.push(`visual prompt: ${reason}`);
  }
  if (post.post_type === "reel") {
    const lastFrame = post.video_storyboard?.at(-1)?.on_screen_text ?? "";
    if (!/educational/i.test(lastFrame)) issues.push("reel: final frame must show the educational disclaimer");
  }
  return issues;
}

/** Guarantee the caption carries the disclaimer and a "save this" + share CTA (disclaimer always last). */
export function enforceCaptionRules(post) {
  let caption = post.caption.replace(DISCLAIMER, "").trim();
  if (!/save this/i.test(caption)) caption += "\n\n📌 Save this for later, and share it with someone who needs it.";
  else if (!/share/i.test(caption)) caption += "\n\n💌 Share this with someone who needs it.";
  caption += `\n\n${DISCLAIMER}`;
  return { ...post, caption };
}
