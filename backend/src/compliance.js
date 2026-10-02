export const DISCLAIMER = "This is for educational purposes only. Consult a qualified doctor for personal medical advice.";
export const REEL_DISCLAIMER = "Educational only — consult your doctor";

// Stage 1 — deterministic rules (mirrors docs/02-content-engine.md §2.5).
export const COPY_RULES = [
  { id: "dosage", re: /\b\d+(\.\d+)?\s?(mg|mcg|µg|iu|ml|tablets?|capsules?)\b/i },
  { id: "medication_instruction", re: /\b(take|start|stop|use)\s+(this|these|your)?\s*(tablet|pill|medicine|medication|supplement|antibiotic)s?\b/i },
  { id: "diagnosis", re: /\b(you (definitely |probably |certainly )?have (pcos|endometriosis|cancer|an infection|a tumou?r|fibroids|diabetes)|this means you have|you are suffering from|you've got)\b/i },
  { id: "absolute_claim", re: /\b(cures?|cured|guaranteed?|100% (safe|effective)|miracle|always works|never fails|proven to)\b/i },
  { id: "fear", re: /\b(deadly|kill you|you could die|terrifying|horrifying|dangerous for your baby|scary truth)\b/i },
];
const VISUAL_RULE = /\b(blood|bloody|graphic|surgery|surgical|nud(e|ity)|naked|anatomy|anatomical|speculum|needles?|syringes?|ultrasound probe|distress(ed)?)\b/i;
// Negated mentions ("no anatomy, no medical instruments") are allowed in visual prompts.
const NEGATED = /\b(no|without|avoid|never)\s+[a-z-]+(\s+[a-z-]+){0,2}/gi;

export function postCopy(post) {
  return [
    post.hook_english,
    post.script,
    ...(post.video_storyboard ?? []).flatMap((b) => [b.voiceover, b.on_screen_text]),
    ...(post.carousel_slides ?? []).flatMap((s) => [s.headline, s.body]),
    post.caption,
    post.cta,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Rule scan: returns a list of `{ rule, match }` hits (empty = clean). */
export function ruleScan(post) {
  const hits = [];
  const copy = postCopy(post);
  for (const { id, re } of COPY_RULES) {
    const m = copy.match(re);
    if (m) hits.push({ rule: id, match: m[0] });
  }
  const visual = (post.visual_prompt ?? "").replace(NEGATED, " ");
  const v = visual.match(VISUAL_RULE);
  if (v) hits.push({ rule: "sensitive_visual", match: v[0] });
  return hits;
}

/** Deterministic auto-fixes: disclaimer last, save + share CTA, reel on-screen disclaimer. */
export function autoFix(post) {
  let caption = post.caption.replace(DISCLAIMER, "").trim();
  if (!/save this/i.test(caption)) caption += "\n\n📌 Save this, and share it with someone who needs it.";
  else if (!/share/i.test(caption)) caption += "\n\n💌 Share this with someone who needs it.";
  caption += `\n\n${DISCLAIMER}`;

  let video_storyboard = post.video_storyboard;
  if (post.post_type === "reel" && video_storyboard.length) {
    const last = video_storyboard.at(-1);
    if (!/educational only/i.test(last.on_screen_text)) {
      video_storyboard = [...video_storyboard.slice(0, -1), { ...last, on_screen_text: `${last.on_screen_text} | ${REEL_DISCLAIMER}`.replace(/^ \| /, "") }];
    }
  }
  return { ...post, caption, video_storyboard };
}

/** Apply an LLM "fix" verdict's suggested text to a post. */
export function applySuggestedFix(post, fix) {
  const next = { ...post };
  if (fix?.caption) next.caption = fix.caption;
  if (fix?.script && post.post_type === "reel") next.script = fix.script;
  if (fix?.carousel_slides_text?.length === post.carousel_slides.length) {
    next.carousel_slides = post.carousel_slides.map((s, i) => ({ ...s, body: fix.carousel_slides_text[i] || s.body }));
  }
  return next;
}

/**
 * Combine Stage 1 (rules) and Stage 2 (LLM review) into a final decision per post.
 * @param {object[]} posts
 * @param {{ reviews: {id, verdict, issues, suggested_fix}[] } | null} review  LLM review (null if unavailable)
 * @returns {{ post, verdict: "pass"|"fix_applied"|"block"|"unreviewed", issues: string[] }[]}
 */
export function decide(posts, review) {
  return posts.map((original) => {
    const r = review?.reviews?.find((x) => x.id === original.id);
    let post = original;
    let verdict = "pass";
    const issues = [...(r?.issues ?? [])];

    if (r?.verdict === "block") verdict = "block";
    else if (r?.verdict === "fix") {
      post = applySuggestedFix(post, r.suggested_fix);
      verdict = "fix_applied";
    }
    post = autoFix(post);
    const hits = ruleScan(post);
    if (hits.length) {
      verdict = "block";
      issues.push(...hits.map((h) => `rule ${h.rule}: "${h.match}"`));
    }
    if (!review && verdict !== "block") {
      verdict = "unreviewed"; // conservative: no semantic review → human approval
      issues.push("LLM compliance review unavailable — rule scan only");
    }
    return { post, verdict, issues };
  });
}
