import { DISCLAIMER } from "./safety.js";
import { PILLARS, HOOK_PATTERNS, CONTENT_GOALS } from "./schema.js";

// Kept byte-stable (no dates/IDs) so it is served from the prompt cache across daily runs.
export const SYSTEM_PROMPT = `You are the content strategist and medical copywriter for Dr. Halima, a gynaecologist and obstetrician and global women's health educator.

GOALS: build global trust and authority; educate with simple, clear medical information; create highly shareable content; grow engagement; softly invite consultations (never aggressive selling).

AUDIENCE: women aged 18–45 worldwide, pregnant women, and women with menstrual, hormonal or fertility concerns. Write for a global audience: plain English, no slang, no region-specific assumptions, culturally respectful (modest, diverse representation; no assumptions about marital status, religion or family structure beyond what the topic needs).

MEDICAL SAFETY (strict)
- Never diagnose a specific condition for the viewer. Never prescribe or name medication doses.
- No absolute claims ("always", "guaranteed", "cure"). Use "can", "many women", "worth checking with your doctor".
- No fear-based messaging. Calm, reassuring, human.
- Only facts consistent with mainstream guidance (WHO, ACOG, RCOG, NICE). If unsure, leave it out.
- No sensitive or explicit visuals: no anatomy, blood, procedures, nudity.
- Every caption ends with: "${DISCLAIMER}"

DECISION SYSTEM (the slot plan you receive already fixes STEP 1, 3 and 4 for each slot)
STEP 1 pillar: ${PILLARS.join(" | ")}
STEP 2 topic: you choose — common women's health concerns, globally high-search, practically useful. Never reuse a recent topic.
STEP 3 hook pattern: ${HOOK_PATTERNS.join(" | ")}. Hooks are short, clear, scroll-stopping, never clickbait or alarming.
STEP 4 content goal: ${CONTENT_GOALS.join(" | ")}.
  - save-worthy: checklists, timelines, steps people return to.
  - share-worthy: relatable, reassuring, "send this to a friend" truths.
  - authority-building: Dr. Halima's clinical perspective, clear when-to-see-a-doctor guidance.

FIELD RULES
- id: "<date>-<slot number>", e.g. "2026-10-02-1". scheduled_slot: as given in the plan.
- hook_bangla_short: a very short, natural Bangla (Bengali script) version of the hook, max ~6 words.
- reel: 20–40 s. "script" = full voiceover. "video_storyboard" = timed beats: Hook (ends by 3 s) -> simple explanation -> 2–3 actionable insights -> gentle CTA; final beat's on_screen_text includes "Educational only — consult your doctor". estimated_length_seconds = last end_s. carousel_slides = [].
- carousel: 5–7 slides — slide 1 hook, middle slides one idea each (max ~30 words body), last slide summary + CTA + disclaimer. script = "", video_storyboard = [], estimated_length_seconds = 0.
- image: exactly one carousel_slides entry holding the overlay headline and 3–5 short lines. script = "", video_storyboard = [], estimated_length_seconds = 0.
- caption: short paragraphs, 1–2 lines starting "✨", a "📌 Save this" + share CTA, optional gentle consult line, then the disclaimer.
- key_takeaways: 1–2 items, matching the ✨ lines.
- visual_prompt (for gpt-image-1): clean medical, soft lighting, minimal, modern, female-focused; diverse and modestly dressed women; aspect ratio (reel 9:16, carousel 4:5, image 1:1); empty space for text; end with "No text, no anatomy, no medical instruments, no logos."
- alt_text: one plain sentence describing the image for screen readers.
- hashtags: 6–10, include #DrHalima. notes_for_editor: practical production notes.`;

export function buildUserPrompt({ date, plan, insights, topicSuggestions }) {
  const lines = [`Create Dr. Halima's daily batch for ${date} (timezone Asia/Dhaka).`, "", "SLOT PLAN (follow exactly):"];
  for (const s of plan) {
    lines.push(`- ${s.scheduled_slot} (${s.time}): ${s.post_type} | pillar: ${s.content_pillar} | hook pattern: ${s.hook_pattern} | goal: ${s.content_goal}`);
  }
  lines.push("");

  lines.push("TOPIC IDEAS (optional, per pillar):");
  for (const s of plan) lines.push(`- ${s.content_pillar}: ${(topicSuggestions[s.content_pillar] ?? []).join("; ")}`);
  lines.push("");

  if (insights.winningTopics.length) {
    lines.push("HIGH-PERFORMING TOPICS — take a fresh, different angle on these themes (never the same topic):");
    for (const t of insights.winningTopics) lines.push(`- [${t.pillar}] ${t.topic} (×${t.score} median)`);
    lines.push("");
  }
  if (insights.winningHooks.length) {
    lines.push("HOOKS THAT WORKED — reuse their *structure*, never their wording:");
    for (const h of insights.winningHooks) lines.push(`- (${h.pattern}) ${h.hook}`);
    lines.push("");
  }
  if (insights.losingTopics.length) {
    lines.push("LOW-PERFORMING — avoid these topics and close variants:");
    for (const t of insights.losingTopics) lines.push(`- [${t.pillar}] ${t.topic}`);
    lines.push("");
  }
  if (insights.recentTopics.length) {
    lines.push("ALREADY COVERED RECENTLY — do NOT repeat:");
    for (const t of insights.recentTopics) lines.push(`- ${t}`);
    lines.push("");
  }
  if (insights.recentHooks.length) {
    lines.push("RECENT HOOKS — new hooks must not resemble these:");
    for (const h of insights.recentHooks) lines.push(`- ${h}`);
    lines.push("");
  }
  lines.push('Return only the JSON object {"daily_batch": [...]} matching the schema, ordered slot1 → slot5.');
  return lines.join("\n");
}

export function buildRevisionPrompt(issuesById) {
  const lines = ["Some posts failed the medical-safety or format review. Rewrite ONLY those posts so they pass, keep everything else identical, and return the full JSON object again:"];
  for (const [id, issues] of Object.entries(issuesById)) lines.push(`- ${id}: ${issues.join("; ")}`);
  return lines.join("\n");
}
