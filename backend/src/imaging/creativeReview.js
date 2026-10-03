import { getCategory } from "./categories.js";
import { graphemeCount } from "./overlay/text.js";

/**
 * "Stop-scroll" creative checklist. This is an internal quality checklist based on simple, explainable
 * rules about the brief and the rendered text — it does NOT predict Facebook performance.
 *
 * Major checks (failing any → status "needs_attention" in the review screen):
 *   hook_clear, mobile_readable, text_density_ok, content_image_alignment
 *   (+ bangla_text_correct when the AI drew the text: the read-back matched every requested line)
 */
const SMALL_PRINT = new Set(["attribution", "symbolic_label", "credentials", "source_note", "slide_counter", "slide_topic", "tag", "badge"]);
const MIN_BODY_PX = 24;
const MIN_HEADLINE_PX = 38;

export function creativeChecklist({ brief, report, overlayIssues = [], brand, textCheck = null }) {
  const aiText = brief.text_mode === "model";
  const cat = getCategory(brief.visual_type);
  const headline = brief.text.headline ?? "";
  const reports = Array.isArray(report) ? report : [report];
  const sizes = reports.flatMap((r) => Object.entries(r?.sizes ?? {}));
  const body = sizes.filter(([k]) => !SMALL_PRINT.has(k)).map(([, v]) => v);
  const headlineSizes = sizes.filter(([k]) => k === "headline" || k === "slide_title").map(([, v]) => v);
  const perImageGraphemes = Math.max(...reports.map((r) => r?.graphemes ?? 0));

  const checks = {
    hook_clear: Boolean(headline) && graphemeCount(headline) <= (cat.text.headline_max ?? 60) * 1.25,
    mobile_readable: body.every((v) => v >= MIN_BODY_PX) && headlineSizes.every((v) => v >= MIN_HEADLINE_PX),
    visual_subject_clear: Boolean(brief.subject) && brief.people_count <= 2,
    text_density_ok: perImageGraphemes <= 230,
    // AI-drawn images: the attribution is one of the requested lines (verified by the text check).
    brand_consistent: Boolean(brief.text.attribution) && (aiText || reports.some((r) => r?.blocks?.some((b) => b.label === "attribution" || b.label === "name"))),
    content_image_alignment: !overlayIssues.some((i) => ["unsourced_text", "unsourced_number"].includes(i.rule)),
    curiosity: /[?？]/.test(headline) || /জানেন|কেন|কীভাবে|আসলে|মিথ/.test(headline),
    emotional_relevance: Boolean(brief.emotional_tone),
    ...(aiText && { bangla_text_correct: textCheck?.ok === true }),
  };
  const major = ["hook_clear", "mobile_readable", "text_density_ok", "content_image_alignment", ...(aiText ? ["bangla_text_correct"] : [])];
  const failed = major.filter((k) => !checks[k]);
  const notes = [];
  if (brand?.colorsArePlaceholders) notes.push("Brand colours not configured — placeholder colours used.");
  if (!checks.hook_clear) notes.push(`Headline is long (${graphemeCount(headline)} characters) — consider a shorter hook.`);
  if (!checks.text_density_ok) notes.push(`Too much text on one image (${perImageGraphemes} characters) — consider a carousel.`);
  if (!checks.mobile_readable) notes.push("Some text is set below the minimum readable size on a phone.");
  if (!checks.content_image_alignment) notes.push("Some on-image text is not found in the approved post.");
  if (aiText && !checks.bangla_text_correct) notes.push(textCheck?.error || !textCheck ? "Bangla text was not checked automatically — proofread every word." : `Bangla text check: ${textCheck.wrong.length} line(s) not spelled as asked${textCheck.garbled.length ? `, garbled: ${textCheck.garbled.join(", ")}` : ""}.`);
  return { ...checks, status: failed.length ? "needs_attention" : "ok", failed_major: failed, notes };
}
