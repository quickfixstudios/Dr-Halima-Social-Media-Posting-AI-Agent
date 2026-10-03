/**
 * Structured prompt builder: Image Creative Brief → the text prompt sent to the image model.
 *
 * Every prompt has the same labelled sections, filled from the brief, so a person can read exactly
 * why the picture looks the way it does — and a regeneration only changes the sections it needs to.
 */

// Extra instructions added by regeneration reasons (see regenerate.js). Keyed by section.
export function buildImagePrompt(brief, brand, { adjustments = [], promptOverride = "" } = {}) {
  const adj = (section) => adjustments.filter((a) => a.section === section).map((a) => a.text);
  const people = brief.people_count > 0;
  const overlay = brief.text_mode !== "model";

  const sections = [
    ["PURPOSE", `${overlay ? "Background image" : "Complete social-media graphic"} for a ${brand.category || "business"} Facebook page (${brand.brand_name}) whose audience is ${brand.audience || "the local community"}. Visual type: ${brief.visual_type_label}. Goal: ${brief.goal.replace(/_/g, " ")}.`],
    ["SUBJECT", [brief.subject, ...adj("SUBJECT")].join(". ")],
    ["CONTEXT", `The image illustrates this approved post without adding any claim of its own. Topic: "${brief.topic}". Hook: "${brief.hook}".`],
    ["EMOTION", [brief.emotional_tone, people && brief.facial_expression ? `natural, believable facial expression: ${brief.facial_expression}` : "", ...adj("EMOTION")].filter(Boolean).join("; ")],
    ["COMPOSITION", [brief.composition, people ? `${brief.people_count === 1 ? "exactly one person" : `exactly ${brief.people_count} people`} in frame` : "", ...adj("COMPOSITION")].filter(Boolean).join("; ")],
    ["CAMERA", brief.realism.startsWith("photo") ? [brief.camera_angle, ...adj("CAMERA")].join("; ") : "not a photograph"],
    ["LIGHTING", [brief.lighting, ...adj("LIGHTING")].join("; ")],
    ["ENVIRONMENT", [brief.environment, brief.props, ...adj("ENVIRONMENT")].filter(Boolean).join("; ")],
    ["VISUAL STYLE", [brief.visual_style, brief.realism, ...adj("VISUAL STYLE")].join("; ")],
    [
      "CULTURAL CONTEXT",
      people
        ? [brand.visual_context?.people, brief.wardrobe ? `wearing ${brief.wardrobe}` : "", "contemporary and respectful, not stereotyped; local Bangladeshi setting and details", ...adj("CULTURAL CONTEXT")].filter(Boolean).join("; ")
        : ["local Bangladeshi context where any objects or interiors appear", ...adj("CULTURAL CONTEXT")].join("; "),
    ],
    ["BRAND STYLE", `${brand.visual_style || "clean"}; tone: ${brand.tone || "professional"}. ${brief.brand_treatment}.`],
    ["COLOR DIRECTION", brief.color_direction],
    [
      "EMPTY SPACE FOR TEXT",
      overlay
        ? `${brief.composition.split("; ").slice(1).join("; ")}. Do NOT render any text — Bengali typography is added afterwards by our own renderer.`
        : `Render this text exactly, large and legible:\n${modelText(brief)}`,
    ],
    ["MEDICAL ACCURACY REQUIREMENTS", brief.medical_safety.length ? brief.medical_safety.join(". ") + "." : "Not a medical brand — keep claims out of the image."],
    ["CONTENT SAFETY", "Family-friendly, modest, respectful and dignified; suitable for a conservative Bangladeshi audience; people are symbolic models, not real patients."],
    ["WHAT TO AVOID", brief.negative_constraints.join(", ") + "."],
    ["ASPECT RATIO", `${brief.aspect_ratio} final post; this image fills a ${brief.image_area.width}×${brief.image_area.height} area (${ratioWords(brief.image_area)}).`],
  ];
  let prompt = sections.map(([k, v]) => `${k}: ${v}`).join("\n");
  if (promptOverride) {
    // A person edited the prompt in the review screen: their text leads, our safety sections still apply.
    prompt = `${promptOverride.trim()}\n\n${sections.filter(([k]) => ["MEDICAL ACCURACY REQUIREMENTS", "CONTENT SAFETY", "WHAT TO AVOID", "EMPTY SPACE FOR TEXT", "ASPECT RATIO"].includes(k)).map(([k, v]) => `${k}: ${v}`).join("\n")}`;
  }
  return prompt;
}

function modelText(brief) {
  const t = brief.text;
  return [t.headline, t.subtitle, ...(t.items ?? []).map((x, i) => `${i + 1}. ${x}`), t.cta].filter(Boolean).join("\n");
}

function ratioWords({ width, height }) {
  const r = width / height;
  if (Math.abs(r - 1) < 0.05) return "square";
  return r > 1 ? `landscape, about ${r.toFixed(2)}:1` : `portrait, about 1:${(1 / r).toFixed(2)}`;
}

/**
 * The parts of the prompt that describe what SHOULD be in the picture (subject, setting, style…), used by the
 * safety scan. "What to avoid" lists are excluded on purpose — they mention unsafe things in order to forbid them.
 */
export function positivePromptText(brief, adjustments = [], promptOverride = "") {
  const allowed = ["SUBJECT", "EMOTION", "COMPOSITION", "CAMERA", "LIGHTING", "ENVIRONMENT", "VISUAL STYLE", "CULTURAL CONTEXT"];
  return [brief.subject, brief.emotional_tone, brief.composition, brief.camera_angle, brief.environment, brief.props, brief.visual_style, brief.wardrobe, ...adjustments.filter((a) => allowed.includes(a.section)).map((a) => a.text), promptOverride]
    .filter(Boolean)
    .join(". ");
}
