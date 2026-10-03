/**
 * Prompt for the image model when IT draws the whole infographic, Bangla text included (text mode "model").
 *
 * Structure follows the "Canva-style medical infographic" brief: style keywords → exact layout → visual
 * elements → colours → typography → the exact text to render → safety → closing line. Every word the image
 * may contain is listed under TEXT TO INCLUDE; the model is told to add nothing else. Because image models
 * can still misspell Bangla, every result is read back by textCheck.js and goes to human review.
 */

export const STYLE_KEYWORDS = "Clean infographic design, medical social media post, minimal modern layout, high whitespace, premium healthcare branding";
export const CLOSING_LINE = "Designed like a professional Canva medical infographic, not AI-generated art.";

// Small illustration described for each icon key the content model may pick (see overlay/icons.js).
const ICON_ART = {
  calendar: "a calendar with one date circled",
  clock: "a clock",
  water: "a glass of water",
  drop: "a water drop",
  thermometer: "a thermometer",
  heart: "a soft heart",
  care: "caring hands around a heart",
  baby: "a sleeping baby wrapped in a blanket",
  mother: "a mother holding her baby",
  family: "a small happy family",
  woman: "a smiling woman in a salwar kameez",
  food: "a balanced plate of rice, vegetables and fish",
  fruit: "fresh fruits",
  vegetable: "green vegetables",
  fish: "a cooked fish",
  egg: "boiled eggs",
  grain: "a bowl of rice and lentils",
  milk: "a glass of milk",
  soup: "a bowl of soup",
  tea: "a cup of tea",
  sleep: "a woman sleeping peacefully",
  rest: "a woman resting on a sofa",
  walk: "a woman walking gently",
  exercise: "a woman doing gentle stretching",
  sun: "morning sunlight",
  leaf: "green leaves",
  eye: "an eye",
  brain: "a lightbulb idea",
  mood_low: "a tired, worried woman resting her head on her hand",
  mood_ok: "a calm smiling woman",
  warning: "a small warning triangle",
  check: "a check mark in a circle",
  doctor: "a friendly female doctor with a stethoscope",
  hospital: "a small clean clinic building",
  phone: "a mobile phone",
  message: "a chat bubble",
  weight: "a weighing scale",
  ribbon: "an awareness ribbon",
  shield: "a protective shield",
  sparkle: "small sparkles",
  breath: "gentle breathing air lines",
  energy: "a small energy bolt",
  bath: "a bathtub",
  clothes: "comfortable loose clothes",
};

const art = (key) => ICON_ART[key] ?? "a simple related object";

/**
 * Exact text lines for the image, in reading order, each with a role label the model can place.
 * Shared with textCheck.js so the read-back is compared against the very same list.
 */
export function infographicTextLines(brief) {
  const t = brief.text;
  const lines = [];
  const add = (role, text) => text && lines.push({ role, text });
  add("Headline", t.headline);
  add("Supporting line", t.subtitle);
  if (t.badge) add("Small badge", t.badge);
  (t.icon_items ?? []).forEach((it, i) => (add(`Card ${i + 1} label`, it.label), add(`Card ${i + 1} small detail`, it.detail)));
  (t.items ?? []).forEach((x, i) => add(`Point ${i + 1}`, x));
  if (t.myths?.length > 1 || brief.layout === "myth_fact_table" || brief.layout === "myth_fact") {
    add("Left column label", t.myth_label);
    add("Right column label", t.fact_label);
    (t.myths?.length ? t.myths : [{ myth: t.myth, fact: t.fact }]).forEach((m, i) => (add(`Row ${i + 1} myth`, m.myth), add(`Row ${i + 1} fact`, m.fact)));
  }
  (t.stages ?? []).forEach((st, i) => (add(`Stage ${i + 1} title`, st.title), st.points.forEach((p, j) => add(`Stage ${i + 1} point ${j + 1}`, p))));
  if (t.columns) {
    for (const side of ["left", "right"]) {
      add(`${side === "left" ? "Left" : "Right"} column title`, t.columns[side].title);
      t.columns[side].items.forEach((x, i) => add(`${side === "left" ? "Left" : "Right"} column item ${i + 1}`, x));
    }
  }
  if (t.stat) (add("Big number", t.stat.value), add("Number label", t.stat.label));
  add("Source note", t.source_note);
  (t.contact ?? []).forEach((c, i) => add(`Contact ${i + 1}`, c));
  add("Button", t.cta);
  add("Small footer", t.attribution);
  return lines;
}

function layoutText(brief) {
  const t = brief.text;
  const n = (t.icon_items ?? []).length;
  const footer = "- Footer (bottom 6%): small, quiet footer text centred in soft charcoal.";
  const button = t.cta ? "- Above the footer: one rounded pill button, centred, white Bengali text on the button colour." : "";
  const header = "- Header (top 18–22%): large bold Bengali headline centred; the supporting line (if any) smaller underneath.";
  switch (brief.layout) {
    case "icon_grid":
      return [
        header,
        `- Middle: a ${n > 4 ? "2-column" : n === 4 ? "2 × 2" : "single-column"} grid of ${n} rounded white cards with soft shadows, equal sizes, even gaps and generous padding. Each card: a small flat vector illustration on the left, its bold Bengali label on the right (with the small detail line under it, if given).`,
        button,
        footer,
      ];
    case "myth_fact_table":
    case "myth_fact":
      return [
        "- Header (top 16%): large bold Bengali headline on the left; a small friendly flat illustration of a smiling Bangladeshi woman in a modest salwar kameez at the top right.",
        "- Column header row: left pill with the left column label on soft pink, a small round circle with a two-way arrow icon in the middle (no letters), right pill with the right column label on sage green.",
        `- ${t.myths?.length || 1} numbered rows, each a rounded white card split in two halves with a thin arrow between: left half = the myth with a small ✕ mark and a tiny flat icon, right half = the fact with a small ✓ mark and a tiny flat icon. Rows aligned and evenly spaced.`,
        button,
        footer,
      ];
    case "stage_columns":
      return [
        header,
        `- Left 60%: ${t.stages.length} rounded white cards stacked top to bottom, each with its bold stage title and short bullet points; a thin vertical timeline line with one dot per card connects them.`,
        "- Right 40%: a large friendly flat illustration of a pregnant Bangladeshi woman in a modest salwar kameez with dupatta, calm smile, gently holding her belly.",
        button,
        footer,
      ];
    case "stat_visual":
      return [
        header,
        "- Centre: the big number, very large and bold, with its label under it.",
        "- Below: a row of 10 simple flat woman figures; the share the number describes is coloured, the rest are light grey.",
        "- Under that: the small source note.",
        footer,
      ];
    case "list":
    case "timeline":
      return [
        "- Top 40%: a warm flat illustration of the subject described below.",
        `- Below: a rounded white panel with the headline and ${brief.layout === "timeline" ? "a vertical timeline with numbered dots" : "numbered points, each with a small icon"}.`,
        button,
        footer,
      ];
    case "two_column":
      return [header, "- Two equal rounded columns side by side, each with its title on a coloured pill and its items as short lines with small icons.", footer];
    default:
      // Poster styles (hook band, question, CTA poster, statistic card, quote): picture + clear text area.
      return [
        "- A warm flat illustration of the subject described below fills the upper 60%.",
        "- Lower 40%: a soft ivory panel with rounded top corners holding the headline (large, bold) and any other text.",
        button,
        footer,
      ];
  }
}

function elementsText(brief) {
  const items = brief.text.icon_items ?? [];
  const lines = [`Main subject: ${brief.subject}.`];
  if (items.length) lines.push(`Card illustrations, in order: ${items.map((it, i) => `${i + 1} ${art(it.icon)}`).join("; ")}.`);
  lines.push("Style: friendly flat vector illustrations with soft watercolour texture; Bangladeshi women in modest salwar kameez with dupatta; simple rounded icons.");
  return lines.join(" ");
}

function colourText(brand, brief) {
  const c = brand.colorsResolved;
  if (brand.colorsArePlaceholders) return "soft, warm, calm neutral colours; gentle and uncluttered.";
  const cta = c.cta?.[brief.cta_kind] ?? c.title;
  const avoid = brand.color_avoid?.length ? ` Avoid: ${brand.color_avoid.join("; ")}.` : "";
  return `background ${c.background}; cards white; headline ${c.title}; body text ${c.text}; highlights ${c.highlight}; health/positive accents ${c.health}; button ${cta} with ${c.on(cta)} text. Only these colours.${avoid}`;
}

/**
 * @param {object} brief   Image Creative Brief (decision.js), text_mode "model"
 * @param {object} brand   loaded brand
 * @param {object} [opts]  { adjustments: [{section, text}], promptOverride }
 */
export function buildInfographicPrompt(brief, brand, { adjustments = [], promptOverride = "" } = {}) {
  const adj = (section) => adjustments.filter((a) => a.section === section).map((a) => a.text);
  const shape = brief.output.width === brief.output.height ? "Square 1:1" : brief.output.width > brief.output.height ? "Landscape" : `Portrait ${brief.aspect_ratio}`;
  const textLines = infographicTextLines(brief);
  const sections = [
    `${STYLE_KEYWORDS}. ${shape}, high resolution, mobile optimized. Brand: ${brand.brand_name} (${brand.category || "health"}). Topic: ${brief.topic}.`,
    `LAYOUT (top to bottom):\n${[...layoutText(brief), ...adj("COMPOSITION")].filter(Boolean).join("\n")}`,
    `VISUAL ELEMENTS: ${[elementsText(brief), ...adj("SUBJECT"), ...adj("VISUAL STYLE")].join(" ")}`,
    `COLOURS: ${[colourText(brand, brief), ...adj("COLOR DIRECTION")].join(" ")}`,
    "TYPOGRAPHY: bold rounded Bengali sans-serif headline; clear, readable Bengali labels large enough to read on a phone; consistent font sizes per level; generous line spacing.",
    `TEXT TO INCLUDE — render exactly these Bengali words, spelled exactly letter by letter (correct vowel signs and conjuncts), nothing else:\n${textLines.map((l) => `${l.role}: ${l.text}`).join("\n")}`,
    `Do not add any other text, English words, numbers (other than those in the lines above), logos or watermarks. ${brief.medical_safety.join(". ")}. Family-friendly and modest; people are symbolic, not real patients.`,
    `AVOID: ${brief.negative_constraints.join(", ")}.`,
    CLOSING_LINE,
  ];
  if (promptOverride) {
    // A reviewer's edited prompt leads; the exact text, safety rules and closing line still apply.
    return [promptOverride.trim(), sections[5], sections[6], sections[7], CLOSING_LINE].join("\n\n");
  }
  return sections.join("\n\n");
}
