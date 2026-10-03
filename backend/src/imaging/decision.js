import crypto from "node:crypto";
import { CATEGORIES, getCategory } from "./categories.js";
import { DEFAULT_ASPECT, outputSize, generationSize } from "./formats.js";
import { imageArea, negativeSpaceHint, NO_PICTURE_LAYOUTS } from "./overlay/layouts.js";
import { guessIcon, ICONS } from "./overlay/icons.js";
import { contactLines } from "./brands.js";
import { graphemeCount } from "./overlay/text.js";
import { FIXED_LABELS } from "./safety.js";

/**
 * Content → image decision engine.
 *
 * 1. rankCategories(): scores every visual category against the post (content type, words in the hook/topic,
 *    goal, and the structure of the content such as myth+fact or a list of points) and explains each score.
 * 2. buildBrief(): turns the chosen category into an Image Creative Brief — every decision about the picture
 *    and the text, stored with the asset. The prompt builder and the text renderer work only from this brief.
 */

const lc = (s = "") => s.toLowerCase();

export function rankCategories(post, brand) {
  if (post.visual_type) return [{ id: getCategory(post.visual_type).id, score: 100, reasons: [`visual_type "${post.visual_type}" was set on the post`] }];
  const hook = lc(post.hook);
  const topic = lc(post.topic);
  const caption = lc(post.caption);
  const type = lc(post.content_type);
  const goal = lc(post.goal);
  const ranked = CATEGORIES.map((cat, order) => {
    let score = 0;
    const reasons = [];
    const bump = (points, why) => {
      score += points;
      reasons.push(`${why} (${points > 0 ? "+" : "−"}${Math.abs(points)})`);
    };
    const explicit = Boolean(type && cat.triggers.content_types.includes(type));
    if (explicit) bump(10, `content_type "${post.content_type}"`);
    let kw = 0;
    for (const word of cat.triggers.keywords) {
      const w = lc(word);
      if (w === "?") continue;
      if (hook.includes(w)) kw += 3;
      else if (topic.includes(w)) kw += 2;
      else if (caption.includes(w)) kw += 0.5;
    }
    if (kw) bump(Math.min(kw, 7), "matching words in hook/topic/caption");
    if (goal && cat.triggers.goals.includes(goal)) bump(2, `goal "${post.goal}"`);
    // Structure of the content.
    if (cat.id === "myth_vs_fact" && ((post.myth && post.fact) || post.myths.length)) bump(8, "post has myth + fact");
    if (["comparison", "do_dont"].includes(cat.id) && post.columns) bump(6, "post has two columns");
    if (cat.id === "statistics" && post.verified_statistics.length) bump(6, "post has a verified statistic");
    if (cat.id === "question_curiosity" && /[?？]\s*$/.test(post.hook)) bump(4, "hook is a question");
    if (cat.layout === "list" && post.key_points.length >= 3) bump(3, `${post.key_points.length} list points`);
    if (cat.id === "educational_carousel" && post.key_points.length > 5) bump(4, "more points than fit on one image");
    // Unmet hard requirements make a category a poor *default* choice. When the post explicitly asks for this
    // type we keep it, so the pipeline halts with a clear reason instead of silently switching style.
    if (explicit) return { id: cat.id, score: Math.round(score * 10) / 10, reasons, order };
    if (cat.requires.includes("verified_statistic") && !post.verified_statistics.length) bump(-8, "no verified statistic");
    if (cat.requires.includes("contact_details") && !contactLines(brand).length && !/ইনবক্স|মেসেজ|inbox|message/i.test(post.cta)) bump(-4, "no contact details in the brand file");
    if (cat.requires.includes("myth_fact") && !(post.myth && post.fact) && !post.myths.length && !/মিথ|myth/i.test(post.hook)) bump(-4, "no myth/fact text");
    if (cat.requires.includes("two_columns") && !post.columns) bump(-6, "no two-column content");
    return { id: cat.id, score: Math.round(score * 10) / 10, reasons, order };
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  const top = ranked.filter((r) => r.score > 0);
  if (!top.length) {
    const fallback = post.key_points.length >= 2 ? "educational_infographic" : "emotional_story";
    return [{ id: fallback, score: 0, reasons: ["no strong signal — default choice"] }, ...ranked.filter((r) => r.id !== fallback)].map(({ order, ...r }) => r);
  }
  return ranked.map(({ order, ...r }) => r);
}

/** Stable pseudo-random pick so the same post always gets the same wardrobe/setting (variant shifts it). */
function pick(list, seed, variant = 0) {
  if (!list?.length) return "";
  const h = crypto.createHash("sha1").update(seed).digest().readUInt32BE(0);
  return list[(h + variant) % list.length];
}

const GOAL_LABEL = {
  education: "stop_scroll_and_educate",
  awareness: "raise_awareness_calmly",
  save: "be_worth_saving",
  share: "be_worth_sharing",
  engagement: "start_a_conversation",
  curiosity: "spark_curiosity",
  trust: "build_trust",
  connection: "build_emotional_connection",
  conversion: "invite_appointment_enquiries",
  appointments: "invite_appointment_enquiries",
};

/** Emoji need a colour-emoji font the server may not have (they would show as □), so images never draw them. */
export const stripEmoji = (s = "") => s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "").replace(/\s+/g, " ").trim();

const MYTH_PREFIX = /^\s*(মিথ|myth)\s*[:：-]\s*/i;

/**
 * Build the Image Creative Brief for one post + category.
 * @param {object} opts  { aspect, textMode, variant (int, rotates wardrobe/setting), conceptMode ("photo"|"illustration"), autoCarousel }
 * @returns {object} brief  (JSON-serialisable; stored in metadata.json)
 */
export function buildBrief(post, brand, categoryId, opts = {}) {
  let cat = getCategory(categoryId);
  const flags = [];
  const halts = [];
  const platform = post.platform || "facebook";
  const aspect = opts.aspect || post.aspect_ratio || (brand.preferred_formats?.[0] ?? DEFAULT_ASPECT[platform] ?? "4:5");
  const out = outputSize(platform, aspect);

  // Designed infographic layouts (icons + text, no AI picture) when the post has the content for them.
  let layout = cat.layout;
  const points = post.items.length ? post.items : post.key_points.map((label) => ({ label, detail: "" }));
  if (cat.designed_layout === "icon_grid" && points.length >= 2) layout = "icon_grid";
  if (cat.designed_layout === "stage_columns" && post.stages.length >= 2) layout = "stage_columns";
  if (cat.designed_layout === "stat_visual") layout = "stat_visual";
  // Long lists do not belong on one image → carousel (keeping the category's picture).
  const maxItems = layout === "icon_grid" ? 8 : cat.text.items_max;
  if (maxItems && points.length > maxItems && cat.carousel_capable && opts.autoCarousel !== false) {
    flags.push({ code: "converted_to_carousel", message: `${points.length} points are too many for one ${cat.label} image (max ${maxItems}) — producing a carousel instead.` });
    layout = "carousel";
  }

  // ── on-image text (only from the approved post, brand file or fixed neutral labels) ──
  const text = {
    headline: stripEmoji(post.hook),
    subtitle: post.subtitle || "",
    cta: post.cta || "",
    attribution: brand.person?.attribution_bn || brand.brand_name,
    items: [],
    contact: contactLines(brand).map((l) => l.text),
  };
  const origins = { headline: "content", subtitle: "content", cta: "content", attribution: "brand", items: "content", contact: "brand" };

  if (layout === "icon_grid") {
    text.icon_items = points.map((p) => ({ icon: ICONS[p.icon] ? p.icon : guessIcon(p.label), label: p.label, detail: p.detail ?? "" }));
  }
  if (layout === "stage_columns") text.stages = post.stages.slice(0, 4);
  if (layout === "list" || layout === "timeline") {
    text.items = post.key_points.slice(0, cat.text.items_max);
    if (cat.badge === "warning") (text.badge = "সতর্কতা"), (origins.badge = "fixed");
    if (cat.badge === "check") (text.badge = "জেনে রাখুন"), (origins.badge = "fixed");
    if (!text.items.length) flags.push({ code: "no_list_items", message: "No numbered/bulleted points found in the post — the image shows only the headline. Add key_points for a stronger infographic." });
  }
  if (layout === "myth_fact") {
    const single = post.myth || (MYTH_PREFIX.test(post.hook) ? post.hook.replace(MYTH_PREFIX, "") : "");
    const pairs = post.myths.length ? post.myths : single && post.fact ? [{ myth: single, fact: post.fact }] : [];
    if (!pairs.length) halts.push({ code: "requires_myth_and_fact", message: 'Myth vs Fact needs "myth" + "fact" (or "myths": [{myth, fact}]) in the approved post — the image will not invent the fact.' });
    if (pairs.length > 1) layout = "myth_fact_table"; // several myths → a table of rows, like the reference infographics
    Object.assign(text, { headline: MYTH_PREFIX.test(post.hook) ? "মিথ বনাম সত্য" : post.hook, myths: pairs, myth: pairs[0]?.myth ?? "", fact: pairs[0]?.fact ?? "", myth_label: "মিথ", fact_label: "সত্য" });
    Object.assign(origins, { headline: MYTH_PREFIX.test(post.hook) ? "fixed" : "content", myth: "content", fact: "content", myth_label: "fixed", fact_label: "fixed" });
  }
  if (layout === "two_column") {
    if (!post.columns) halts.push({ code: "requires_two_columns", message: `${cat.label} needs "columns" (left/right title + items) in the approved post.` });
    text.columns = post.columns ?? { left: { title: "করণীয়", items: [] }, right: { title: "বর্জনীয়", items: [] } };
  }
  if (cat.requires.includes("verified_statistic")) {
    const s = post.verified_statistics[0];
    if (!s) halts.push({ code: "requires_verified_statistic", message: "Statistics images need a verified statistic with its source in the post (verified_statistics). No numbers will be invented." });
    text.stat = s ? { value: s.value, label: s.label } : { value: "", label: "" };
    text.source_note = s ? `সূত্র: ${s.source}` : "";
    origins.source_note = "content";
  }
  if (cat.requires.includes("contact_details")) {
    // Messaging the page itself is a real contact route, so "ইনবক্সে মেসেজ করুন" posters need no extra details.
    const viaInbox = /ইনবক্স|মেসেজ|inbox|message/i.test(post.cta);
    if (!text.contact.length && !viaInbox) halts.push({ code: "requires_contact_details", message: "Appointment posters need a contact detail in the brand file (contact_details) or a CTA that invites messages to the page. Nothing will be invented." });
    if (!text.cta) (text.cta = "অ্যাপয়েন্টমেন্টের জন্য যোগাযোগ করুন"), (origins.cta = "fixed");
  }
  let doctorPresence = false;
  let usePhoto = false;
  if (cat.requires.includes("doctor_photo_or_fallback")) {
    if (brand.photoFile) {
      usePhoto = true;
      doctorPresence = true;
    } else {
      flags.push({ code: "missing_doctor_photo", message: `No approved photo of ${brand.person?.display_name_en || brand.brand_name} in the brand file — using a non-identifying clinic still-life instead. An AI face will never be presented as the doctor. Add person.photo_path + photo_approved=true to use her real photo.` });
    }
  }
  if (layout === "carousel") {
    const source = post.slides?.length ? post.slides : post.key_points.map((p) => ({ title: p, body: "" }));
    const max = (getCategory("educational_carousel").text.slides_max ?? 7) - 2;
    text.slides = source.slice(0, max);
    text.swipe_label = "পরের স্লাইডে দেখুন →";
    text.end_label = "পোস্টটি সেভ করে রাখুন";
    Object.assign(origins, { slides: "content", swipe_label: "fixed", end_label: "fixed" });
    if (source.length > max) flags.push({ code: "carousel_truncated", message: `Only the first ${max} points fit in a carousel; ${source.length - max} were left out.` });
  }

  // Layouts without room for a CTA keep it in the caption only (nothing is drawn that the layout cannot show).
  if (["two_column", "stat", "doctor_quote"].includes(layout) && text.cta) {
    flags.push({ code: "cta_in_caption_only", message: `The ${layout} layout has no CTA area — the CTA stays in the caption.` });
    text.cta = "";
  }

  // ── picture ──
  // Brand default look: Dr. Halima uses warm infographic illustrations instead of photos (unless a concept asks otherwise).
  const mode = opts.conceptMode || (cat.visual.mode === "photo" && brand.image_style === "illustration" && !usePhoto ? "illustration" : cat.visual.mode);
  // Text mode "model": the image model draws the whole infographic, text included (carousels and real photos
  // stay on our own Bangla overlay — one AI picture cannot hold every slide, and a real photo must not be redrawn).
  let textMode = opts.textMode ?? "overlay";
  if (textMode === "model" && (layout === "carousel" || usePhoto)) {
    textMode = "overlay";
    flags.push({ code: "overlay_kept", message: `${usePhoto ? "Real photo" : "Carousel"} — the Bangla text is drawn by our renderer, not by the AI.` });
  }
  const aiDrawsAll = textMode === "model";
  const noPicture = !aiDrawsAll && NO_PICTURE_LAYOUTS.has(layout);
  const peopleInScene = (aiDrawsAll || !noPicture) && mode !== "graphic" && !/no people|no person|no face/.test(cat.visual.subject);
  const area = aiDrawsAll ? { width: out.width, height: out.height } : imageArea(layout, out.width, out.height);
  const wardrobe = peopleInScene ? pick(brand.visual_context?.wardrobe, `${post.post_id}:${cat.id}`, opts.variant ?? 0) : "";
  const settingKey = cat.visual.setting;
  const environment = settingKey === "none" ? "abstract background" : brand.visual_context?.settings?.[settingKey] || pick(Object.values(brand.visual_context?.settings ?? {}), post.post_id, opts.variant ?? 0);

  const lengthOf = (s) => graphemeCount(s ?? "");
  const textChars = lengthOf(text.headline) + lengthOf(text.subtitle) + (text.items ?? []).reduce((a, s) => a + lengthOf(s), 0) + lengthOf(text.myth) + lengthOf(text.fact);
  if (cat.text.headline_max && lengthOf(text.headline) > cat.text.headline_max && layout !== "myth_fact") {
    flags.push({ code: "headline_long", message: `Headline has ${lengthOf(text.headline)} characters (limit ${cat.text.headline_max} for ${cat.label}); it will be set smaller or must be shortened.` });
  }

  return {
    brief_version: 1,
    business: brand.id,
    post_id: post.post_id,
    platform,
    visual_type: cat.id,
    visual_type_label: cat.label,
    layout,
    goal: GOAL_LABEL[lc(post.goal)] ?? GOAL_LABEL[cat.triggers.goals[0]] ?? "stop_scroll_and_educate",
    topic: post.topic,
    hook: post.hook,
    visual_concept: `${cat.label}: ${cat.visual.subject}`,
    concept_mode: mode,
    subject: usePhoto ? `approved real photograph of ${brand.person.display_name_en}` : cat.visual.subject,
    people_count: peopleInScene ? (/couple|mother .* newborn|mother and baby/.test(cat.visual.subject) ? 2 : 1) : 0,
    doctor_presence: doctorPresence,
    use_real_photo: usePhoto,
    emotional_tone: cat.visual.emotion,
    facial_expression: peopleInScene ? cat.visual.emotion.split(/[,—]/)[0].trim() : "",
    wardrobe,
    environment,
    props: cat.visual.props ?? "",
    composition: `${cat.visual.composition}; ${negativeSpaceHint(layout)}`,
    camera_angle: cat.visual.camera,
    background: settingKey === "none" ? "soft, low-detail abstract background" : environment,
    lighting: "soft natural daylight, gentle contrast",
    visual_style: mode === "illustration" ? "warm, premium editorial health illustration in a modern infographic style: flat vector shapes with soft watercolour texture, friendly characters, simple supporting icons" : brand.visual_style || "clean modern editorial",
    realism: mode === "photo" ? "photorealistic, natural and unretouched" : mode === "illustration" ? "stylised illustration (clearly not a photograph)" : "flat graphic",
    color_direction: colorDirection(brand),
    brand_treatment: `${brand.brand_name}: ${brand.brand_feel || brand.tone || "professional"} Brand text, logo and attribution are added afterwards, never by the image model`,
    cta_kind: ctaKind(cat, text.cta),
    graphical_elements: graphicalElements(layout, text),
    aspect_ratio: aspect,
    output: out,
    image_area: { width: area.width, height: area.height },
    no_ai_picture: noPicture,
    generation_size: usePhoto || noPicture ? null : generationSize(area.width / area.height, { arbitrarySizes: opts.arbitrarySizes ?? true }),
    text_mode: textMode,
    text,
    text_origins: origins,
    text_density: textChars > 160 ? "high" : textChars > 80 ? "medium" : "low",
    label_symbolic: peopleInScene && mode === "photo" && brand.medical, // drawings are obviously not real patients
    badge: cat.badge ?? null,
    negative_constraints: negativeConstraints(cat, brand, { peopleInScene, textMode }),
    medical_safety: brand.medical ? MEDICAL_SAFETY : [],
    flags,
    halts,
    requires_verified_statistic: halts.some((h) => h.code === "requires_verified_statistic"),
  };
}

/**
 * Which CTA colour a post gets (brand guideline "CTA usage"): booking/contact → appointment,
 * "save" → save, health-tip styles → health_tip, anything else → the default CTA colour.
 */
const HEALTH_TIP_TYPES = new Set(["educational_infographic", "checklist", "pregnancy_nutrition", "menstrual_education", "pregnancy_timeline", "postpartum_education", "newborn_maternal_care", "fertility_education"]);
export function ctaKind(cat, cta = "") {
  if (cat.id === "appointment_cta" || /অ্যাপয়েন্টমেন্ট|সিরিয়াল|বুক\s*করুন|ইনবক্স|যোগাযোগ\s*করুন|appointment|book/i.test(cta)) return "appointment";
  if (/সেভ|save/i.test(cta)) return "save";
  if (HEALTH_TIP_TYPES.has(cat.id)) return "health_tip";
  return "default";
}

/** Palette described in words for the image model (models follow colour names better than hex codes). */
function colorDirection(brand) {
  if (brand.colorsArePlaceholders || !brand.palette?.length) return "soft, warm, calm neutral colours; gentle and uncluttered";
  const names = brand.palette.map((p) => `${p.name.toLowerCase()} (${p.hex})`).join(", ");
  const avoid = brand.color_avoid?.length ? ` Avoid: ${brand.color_avoid.join("; ")}.` : "";
  return `soft, harmonious palette drawn from ${names}; mostly warm ivory and gentle pinks with touches of sage green; calm and low-saturation, never neon.${avoid}`;
}

function graphicalElements(layout, text) {
  const el = {
    hook_band: ["dark gradient band at the bottom", "headline", text.cta ? "CTA pill" : null, "attribution line"],
    list: ["picture at the top", "rounded text panel", text.badge ? `badge "${text.badge}"` : null, "numbered/icon list", "attribution line"],
    timeline: ["picture at the top", "rounded text panel", "vertical timeline with numbered dots", "attribution line"],
    myth_fact: ["picture at the top", "MYTH card (deep rose ✕)", "FACT card (sage ✓)", "attribution line"],
    icon_grid: ["soft brand shapes", "topic tag", "big headline", "2-column grid of icon cards (Lucide icons)", "CTA", "attribution"],
    stat_visual: ["soft brand shapes", "big verified number", "10-figure pictogram", "source note", "attribution"],
    stage_columns: ["soft brand shapes", "big headline", "2-4 stage columns with coloured titles and points", "attribution"],
    myth_fact_table: ["picture band at the top", "MYTH | FACT column headers", "one row per myth with ✕ → ✓", "attribution line"],
    two_column: ["soft background", "two titled columns with icons", "attribution line"],
    question: ["dark gradient", "large question headline", "accent ? badge", "attribution line"],
    cta_poster: ["picture at the top", "headline", "contact lines", "CTA button", "attribution line"],
    doctor_quote: ["photo at the top", "large quote mark", "quote", "name + credentials"],
    stat: ["soft background", "statistic card with big number, label and source"],
    carousel: ["cover slide with picture + hook", "one slide per point", "closing CTA slide with attribution"],
  };
  return (el[layout] ?? []).filter(Boolean);
}

const MEDICAL_SAFETY = [
  "The picture supports the approved educational message only; it adds no medical claim of its own",
  "No depiction of medicines, pills, injections, procedures or surgery",
  "No anatomy, no blood, no explicit or exposed body, no sexualisation",
  "No fetus imagery; pregnancy shown only as a modestly dressed pregnant woman",
  "No frightening hospital or emergency scenes; concern is shown calmly",
  "No fabricated patient testimonial: people are symbolic models, not real patients",
  "No before/after or cure imagery",
];

export const BASE_NEGATIVES = [
  "watermarks",
  "random or garbled text",
  "fake logos or brand marks",
  "distorted hands or extra fingers",
  "malformed anatomy or unnatural faces",
  "sexualisation or revealing clothing",
  "graphic blood",
  "explicit genital imagery",
  "unnecessarily exposed body",
  "frightening hospital scenes",
  "fake or incorrect medical equipment",
  "inaccurate fetus depiction",
  "fake patient testimonials",
  "misleading before/after imagery",
  "unrealistic pregnancy anatomy",
  "Western stock-photo aesthetic",
  "overly promotional hospital-advert style",
];

function negativeConstraints(cat, brand, { peopleInScene, textMode }) {
  const list = [...BASE_NEGATIVES, ...(cat.avoid ?? []), ...(brand.disallowed_styles ?? [])];
  if (textMode === "overlay") list.unshift("any text, letters, numbers, captions, signage, labels or UI on screens");
  else list.unshift("any text other than the exact Bengali lines listed", "English words", "misspelled or invented Bengali letters");
  if (!peopleInScene) list.push("people or faces");
  return [...new Set(list)];
}

/** All on-image text blocks with where they came from — fed to the safety check. */
export function briefTextBlocks(brief) {
  const t = brief.text;
  const o = brief.text_origins ?? {};
  const blocks = [];
  const add = (label, text, origin) => text && blocks.push({ label, text, origin });
  add("headline", t.headline, o.headline);
  add("subtitle", t.subtitle, o.subtitle);
  add("cta", t.cta, o.cta);
  add("attribution", t.attribution, "brand");
  add("badge", t.badge, "fixed");
  (t.items ?? []).forEach((x, i) => add(`item ${i + 1}`, x, o.items));
  if (t.myths?.length > 1) t.myths.forEach((m, i) => (add(`myth ${i + 1}`, m.myth, "content"), add(`fact ${i + 1}`, m.fact, "content")));
  else {
    add("myth", t.myth, o.myth);
    add("fact", t.fact, o.fact);
  }
  add("myth_label", t.myth_label, "fixed");
  add("fact_label", t.fact_label, "fixed");
  if (t.columns) {
    for (const side of ["left", "right"]) {
      add(`${side} title`, t.columns[side].title, post_or_fixed(t.columns[side].title));
      t.columns[side].items.forEach((x, i) => add(`${side} item ${i + 1}`, x, "content"));
    }
  }
  if (t.stat) {
    add("stat value", t.stat.value, "content");
    add("stat label", t.stat.label, "content");
  }
  add("source note", t.source_note?.replace(/^সূত্র:\s*/, ""), "content");
  (t.icon_items ?? []).forEach((it, i) => (add(`item ${i + 1}`, it.label, "content"), add(`detail ${i + 1}`, it.detail, "content")));
  (t.stages ?? []).forEach((st, i) => (add(`stage ${i + 1}`, st.title, "content"), st.points.forEach((pt, j) => add(`stage ${i + 1} point ${j + 1}`, pt, "content"))));
  if (["icon_grid", "stat_visual", "stage_columns"].includes(brief.layout)) add("topic tag", brief.topic, "content");
  (t.contact ?? []).forEach((x, i) => add(`contact ${i + 1}`, x.replace(/^[^:]+:\s*/, ""), "brand"));
  (t.slides ?? []).forEach((sl, i) => {
    add(`slide ${i + 2} title`, sl.title, "content");
    add(`slide ${i + 2} body`, sl.body, "content");
  });
  if (brief.layout === "carousel") add("slide topic", brief.topic, "content");
  add("swipe label", t.swipe_label, "fixed");
  if (!t.cta) add("end label", t.end_label, "fixed");
  return blocks;
}
const post_or_fixed = (title) => (FIXED_LABELS.includes(title) ? "fixed" : "content");
