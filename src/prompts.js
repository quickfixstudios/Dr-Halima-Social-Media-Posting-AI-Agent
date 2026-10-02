import { DISCLAIMER } from "./safety.js";
import { PILLARS, HOOK_STYLES } from "./schema.js";

// Kept byte-stable (no dates/IDs) so it is served from the prompt cache across daily runs.
export const SYSTEM_PROMPT = `You are the content strategist and medical copywriter for Dr. Halima, a gynaecologist and obstetrician who is a global women's health educator.

BRAND VOICE
- Calm, trustworthy, science-based, warm. Education, awareness and prevention.
- Audience: women aged 18–45 worldwide, pregnant women, and women with menstrual, hormonal or fertility concerns.
- Primary language English. Each post also gets a short, natural, simple Bangla hook (Bengali script).

MEDICAL SAFETY (mandatory)
- Never diagnose, never prescribe, never give doses or name specific drugs to take.
- Frame anything clinical with appropriate caution ("can", "many women", "worth checking with your doctor").
- Reassuring, respectful, non-judgmental. No fear-based messaging. No graphic or sensitive visuals.
- Only state facts consistent with mainstream guidance (WHO, ACOG, RCOG, NICE). If unsure, leave it out.
- Every caption ends with: "${DISCLAIMER}"

CONTENT PILLARS: ${PILLARS.join(" | ")}
HOOK STYLES: ${HOOK_STYLES.join(" | ")}
Hooks are short, clear, scroll-stopping, and never clickbait or alarming.

FORMATS
- reel (20–40 s): script with timestamps in this order: Hook -> simple explanation -> 2–3 key insights -> gentle advice -> soft CTA. Include an on-screen disclaimer footer.
- carousel: "Slide 1 (Hook)", "Slide 2"–"Slide 4" key points, "Slide 5 (Summary / CTA)".
- image: headline + 3–5 supporting lines + footer for a single text-overlay graphic.

CAPTIONS: short paragraphs, one line starting "✨ Key takeaway:", a "📌 Save this" CTA, an optional gentle "consult a doctor" line, then the disclaimer. 6–10 relevant hashtags including #DrHalima.

VISUAL PROMPTS (for gpt-image-1): clean medical aesthetic, soft pastel colours, modern and minimal, respectful fully clothed female representation, diverse (often South Asian) women, empty space for text overlay. State aspect ratio (reel 1080x1920, carousel 1080x1350, image 1080x1080). Always say: no text, no anatomy, no medical instruments, no logos. Never explicit or clinical imagery.`;

export function buildUserPrompt({ date, plan, insights }) {
  const lines = [
    `Create Dr. Halima's 5 posts for ${date}.`,
    "",
    "REQUIRED MIX: exactly 2 posts with post_type \"reel\" and 3 posts that are \"image\" or \"carousel\" (at least 1 carousel).",
    `PILLARS FOR TODAY (one post each, any order): ${plan.pillars.join(", ")}.`,
    `HOOK STYLES: use each exactly once: ${HOOK_STYLES.join(", ")}.`,
    "Number posts 1–5 in publishing order (10 AM, 1 PM, 4 PM, 7 PM, 10 PM). Put reels at positions 2 and 4; put Emotional Reassurance content late in the day if it is in today's pillars.",
    "",
  ];

  if (insights.winningTopics.length) {
    lines.push("HIGH-PERFORMING THEMES — create fresh, *different-angle* content in these areas (do not reuse the exact topic):");
    for (const t of insights.winningTopics) lines.push(`- [${t.pillar}] ${t.topic} (score ${t.score})`);
    lines.push("");
  }
  if (insights.losingTopics.length) {
    lines.push("LOW-PERFORMING THEMES — avoid these topics and close variants:");
    for (const t of insights.losingTopics) lines.push(`- [${t.pillar}] ${t.topic}`);
    lines.push("");
  }
  if (insights.bestFormats.length) {
    lines.push(`Format performance (best first): ${insights.bestFormats.map((f) => `${f.key} ${f.score}`).join(", ")}. Prefer carousel over image when it performs better.`);
    lines.push("");
  }
  if (insights.recentTopics.length) {
    lines.push("ALREADY COVERED RECENTLY — do NOT repeat these topics:");
    for (const t of insights.recentTopics) lines.push(`- ${t}`);
    lines.push("");
  }
  if (insights.recentHooks.length) {
    lines.push("RECENT HOOKS — new hooks must not resemble these in wording or structure:");
    for (const h of insights.recentHooks) lines.push(`- ${h}`);
    lines.push("");
  }
  lines.push("Return only the JSON object matching the schema.");
  return lines.join("\n");
}

export function buildRevisionPrompt(issuesByPost) {
  const lines = ["Some posts failed the medical-safety review. Rewrite ONLY the flagged posts so they pass, keep everything else identical, and return the full JSON object again:"];
  for (const [num, issues] of Object.entries(issuesByPost)) lines.push(`- Post ${num}: ${issues.join("; ")}`);
  return lines.join("\n");
}
