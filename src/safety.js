export const DISCLAIMER =
  "This is for educational purposes only. Consult a qualified doctor for personal medical advice.";

// Patterns that suggest diagnosis, prescribing, guarantees or fear-based messaging.
const RED_FLAGS = [
  { re: /\b\d+(\.\d+)?\s?(mg|mcg|µg|iu|ml)\b/i, reason: "dosage / prescription detail" },
  { re: /\b(take|start|use)\s+(this|these)?\s*(tablet|pill|medicine|medication|supplement)s?\b/i, reason: "direct medication instruction" },
  { re: /\b(you (definitely|certainly) have|this means you have|you are suffering from)\b/i, reason: "diagnostic language" },
  { re: /\b(cure[sd]?|guaranteed?|100% (safe|effective)|miracle)\b/i, reason: "unqualified medical claim" },
  { re: /\b(deadly|kill you|you could die|terrifying|horrifying)\b/i, reason: "fear-based messaging" },
  { re: /\b(graphic|blood[- ]soaked|surgery footage|nud(e|ity))\b/i, reason: "sensitive visual" },
];

/** Returns a list of issues; empty list means the post passed. */
export function checkPostSafety(post) {
  const issues = [];
  const text = [post.hook_english, post.script_or_slide_content, post.caption, post.cta].join("\n");
  for (const { re, reason } of RED_FLAGS) {
    const match = text.match(re);
    if (match) issues.push(`${reason}: "${match[0]}"`);
  }
  for (const { re, reason } of RED_FLAGS.filter((f) => f.reason === "sensitive visual")) {
    if (re.test(post.visual_prompt)) issues.push(`visual prompt: ${reason}`);
  }
  return issues;
}

/** Guarantee the caption carries the disclaimer and a "save this" CTA. */
export function enforceCaptionRules(post) {
  let caption = post.caption.trim();
  if (!/save this/i.test(caption)) caption += "\n\n📌 Save this for later.";
  if (!caption.includes(DISCLAIMER)) caption += `\n\n${DISCLAIMER}`;
  return { ...post, caption };
}
