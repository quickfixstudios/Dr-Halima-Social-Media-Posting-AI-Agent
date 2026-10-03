import { ImageError } from "./errors.js";

/**
 * Regeneration reasons → the smallest change that fixes the problem.
 *   scope "background": ask the AI for a new picture with extra prompt instructions (costs one generation)
 *   scope "overlay":    keep the picture, only redraw the Bangla text (free — no API call)
 * `prompt` entries are added to the named prompt section; `variant` rotates wardrobe/setting choices.
 */
export const REASONS = {
  face_looks_fake: {
    label: "Face looks fake",
    scope: "background",
    prompt: [
      { section: "VISUAL STYLE", text: "true-to-life documentary photography: natural, unretouched skin texture, natural facial asymmetry, real hair strands, relaxed candid expression; avoid the smooth airbrushed AI look" },
      { section: "CAMERA", text: "full-frame camera, 50mm lens, natural window light" },
    ],
  },
  wrong_ethnicity: {
    label: "Wrong ethnicity",
    scope: "background",
    prompt: [{ section: "CULTURAL CONTEXT", text: "the people must clearly look Bangladeshi (Bengali): South Asian facial features, warm brown skin tones, dark hair — not East Asian, Middle Eastern or European" }],
  },
  too_much_text: {
    label: "Too much text",
    scope: "overlay",
    overlay: (brief) => {
      brief.text.subtitle = "";
      if (brief.text.items?.length > 3) {
        brief.flags.push({ code: "items_trimmed", message: `Showing 3 of ${brief.text.items.length} points to reduce text — consider a carousel for the full list.` });
        brief.text.items = brief.text.items.slice(0, 3);
      }
    },
  },
  too_generic: {
    label: "Too generic",
    scope: "background",
    variant: 1,
    prompt: [{ section: "SUBJECT", text: "make the scene specific to the post topic with one meaningful, natural detail a Bangladeshi viewer would recognise; avoid generic stock-photo staging" }],
  },
  too_dramatic: {
    label: "Too dramatic",
    scope: "background",
    prompt: [{ section: "EMOTION", text: "calmer and lighter: relaxed posture, a soft smile or calm neutral face, no visible distress" }],
  },
  not_professional: {
    label: "Not professional",
    scope: "background",
    prompt: [{ section: "VISUAL STYLE", text: "premium healthcare editorial photography: tidy, well-composed, refined colour grading, no clutter" }],
  },
  wrong_composition: {
    label: "Wrong composition",
    scope: "background",
    prompt: [{ section: "COMPOSITION", text: "strictly keep the text area empty; subject smaller in the frame with more breathing room" }],
  },
  wrong_clothing: {
    label: "Wrong clothing",
    scope: "background",
    variant: 1,
    prompt: [{ section: "CULTURAL CONTEXT", text: "clothing fully modest: long sleeves, covered shoulders, loose comfortable fit" }],
  },
  poor_medical_context: {
    label: "Poor medical context",
    scope: "background",
    prompt: [{ section: "ENVIRONMENT", text: "the setting must clearly fit the topic and be medically plausible: clean, realistic and accurate details, nothing invented or misleading" }],
  },
  needs_more_emotional_impact: {
    label: "Needs more emotional impact",
    scope: "background",
    prompt: [
      { section: "EMOTION", text: "stronger, warmer human emotion and connection, still calm and respectful" },
      { section: "COMPOSITION", text: "closer framing on the face and hands" },
    ],
  },
  needs_stronger_hook: {
    label: "Needs stronger hook",
    scope: "overlay",
    overlay: (brief) => {
      brief.headline_scale = Math.min(1.3, (brief.headline_scale ?? 1) * 1.15);
      brief.text.subtitle = "";
    },
  },
  keep_image_change_text: { label: "Keep image, change text", scope: "overlay", needsHeadline: true },
  keep_text_regenerate_background: { label: "Keep text, regenerate background", scope: "background", variant: 1 },
};

export function getReason(code) {
  const r = REASONS[code];
  if (!r) throw new ImageError("UNKNOWN_REASON", `Unknown regeneration reason "${code}". Use one of: ${Object.keys(REASONS).join(", ")}`);
  return r;
}
