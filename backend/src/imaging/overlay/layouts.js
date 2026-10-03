import sharp from "sharp";
import { renderText, graphemeCount, toBanglaDigits } from "./text.js";
import { ImageError } from "../errors.js";
import { mix } from "../brands.js";

/**
 * Text layout templates ("Pipeline A": the AI draws the picture, we draw every letter).
 *
 * Every size below is designed for a 1080px-wide image and multiplied by `s` (= width / 1080), so the
 * same template works for 4:5, 1:1, 9:16 and 1.91:1. All text is placed inside safe margins; if a text
 * block cannot fit at its minimum readable size the template throws TEXT_TOO_LONG instead of cropping.
 *
 * Colours come only from the brand's colour ROLES (brands/<id>.json → colors / cta_colors):
 *   background · title (headings) · text (body) · text_light · highlight · health · overlay · cta.<kind>
 * Soft tints are mixed from those roles; no other hue is ever introduced ("avoid too many colours").
 * Text on any filled shape uses c.on(fill), which picks the more readable of the brand's text colours.
 */

// Fraction of the canvas height covered by the AI picture for each layout (the rest is a text panel).
const IMAGE_FRACTION = { list: 0.42, myth_fact: 0.36, cta_poster: 0.45, doctor_quote: 0.52, timeline: 0.36 };

/** Where the generated picture goes on the canvas — used to request the right shape from the model. */
export function imageArea(layout, width, height) {
  const f = IMAGE_FRACTION[layout];
  return f ? { left: 0, top: 0, width, height: Math.round(height * f) } : { left: 0, top: 0, width, height };
}

/** Plain-language description of the empty space the picture must leave for text (goes into the prompt). */
export function negativeSpaceHint(layout) {
  return {
    hook_band: "keep the lower 40% of the frame calm, simple and darker (it will carry a Bengali headline); main subject in the upper 60%",
    question: "keep the lower half and the left side calm and uncluttered for a large Bengali question; subject towards the upper right",
    carousel: "keep the lower 40% of the frame calm and simple for a Bengali headline; main subject in the upper 60%",
    stat: "very low detail everywhere — a large number will sit in the centre",
    two_column: "very low detail everywhere — two text columns will cover most of it",
  }[layout] ?? "the whole picture stays visible; keep the bottom edge simple because a text panel starts right below it";
}

const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`);
const rect = (x, y, w, h, fill, { r = 0, opacity = 1 } = {}) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}" fill-opacity="${opacity}"/>`;
const circle = (cx, cy, r, fill) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
const checkIcon = (cx, cy, r, stroke = "#FFFFFF") => `<path d="M ${cx - r * 0.42} ${cy + r * 0.02} L ${cx - r * 0.1} ${cy + r * 0.34} L ${cx + r * 0.45} ${cy - r * 0.32}" stroke="${stroke}" stroke-width="${r * 0.22}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
const crossIcon = (cx, cy, r, stroke = "#FFFFFF") => {
  const d = r * 0.36;
  return `<path d="M ${cx - d} ${cy - d} L ${cx + d} ${cy + d} M ${cx + d} ${cy - d} L ${cx - d} ${cy + d}" stroke="${stroke}" stroke-width="${r * 0.22}" stroke-linecap="round"/>`;
};
/** Two solid "comma" shapes forming an opening quote mark (fonts draw “ very differently, so we draw it). */
const quoteMark = (x, y, size, fill) => {
  const u = size / 60;
  const one = (dx) => `<path transform="translate(${x + dx * u} ${y})" d="M ${24 * u} 0 C ${8 * u} ${6 * u} 0 ${20 * u} 0 ${36 * u} L 0 ${56 * u} L ${24 * u} ${56 * u} L ${24 * u} ${30 * u} L ${12 * u} ${30 * u} C ${12 * u} ${20 * u} ${16 * u} ${12 * u} ${26 * u} ${8 * u} Z" fill="${fill}"/>`;
  return one(0) + one(32);
};
const bangIcon = (cx, cy, r, stroke = "#FFFFFF") => `<path d="M ${cx} ${cy - r * 0.42} L ${cx} ${cy + r * 0.12}" stroke="${stroke}" stroke-width="${r * 0.22}" stroke-linecap="round"/>${circle(cx, cy + r * 0.42, r * 0.12, stroke)}`;

/** Build a context with brand fonts/colours and a recorder of every text block (for the review report). */
function makeContext({ brand, brief, width, height }) {
  const s = width / 1080;
  const W = width;
  const H = height;
  const M = Math.round(64 * s);
  const c = brand.colorsResolved;
  const fonts = { Regular: brand.fontFiles.regular, SemiBold: brand.fontFiles.semibold, Bold: brand.fontFiles.bold };
  const report = { sizes: {}, blocks: [], graphemes: 0 };
  const text = async (label, value, { weight = "Bold", size: baseSize, min: baseMin, width: w, maxHeight, maxLines, color = c.text, align = "left" }) => {
    const scale = label === "headline" ? (brief.headline_scale ?? 1) : 1; // "needs stronger hook" makes the headline bigger
    const size = baseSize * scale;
    const min = baseMin == null ? undefined : baseMin * scale;
    const r = await renderText({ text: value, fontFile: fonts[weight], family: brand.fonts.family, weight, sizePx: size * s, minPx: (min ?? size * 0.75) * s, width: w, maxHeight, maxLines, color, align, label });
    report.sizes[label] = Math.min(report.sizes[label] ?? Infinity, Math.round(r.sizePx / s)); // stored at 1080-equivalent px
    report.blocks.push({ label, text: value });
    report.graphemes += graphemeCount(value);
    return r;
  };
  return { s, W, H, M, c, brand, brief, t: brief.text, text, report, shapes: [], layers: [] };
}

const place = (ctx, r, left, top) => {
  ctx.layers.push({ input: r.input, left: Math.round(left), top: Math.round(top) });
  return r;
};

async function backgroundInto(ctx, background, area) {
  const img = background
    ? await sharp(background).resize(area.width, area.height, { fit: "cover", position: "attention" }).toBuffer()
    : await placeholder(ctx, area);
  ctx.bg = { input: img, left: area.left, top: area.top };
}

/** Grey stand-in for the AI picture in dry-run previews (no API call). */
async function placeholder(ctx, area) {
  const label = await renderText({ text: "AI ছবি এখানে বসবে (ড্রাই রান)", fontFile: ctx.brand.fontFiles.semibold, family: ctx.brand.fonts.family, weight: "SemiBold", sizePx: 30 * ctx.s, width: area.width * 0.8, color: "#5B6770" });
  return sharp({ create: { width: area.width, height: area.height, channels: 3, background: "#CBD5DB" } })
    .composite([{ input: label.input, left: Math.round((area.width - label.width) / 2), top: Math.round((area.height - label.height) / 2) }])
    .png()
    .toBuffer();
}

/** Logo (if the brand has one) at the given corner. Returns its width so text can avoid it. */
async function logo(ctx, { right, bottom, top, maxH }) {
  if (!ctx.brand.logoFile) return 0;
  const buf = await sharp(ctx.brand.logoFile).resize({ height: Math.round(maxH), fit: "inside" }).png().toBuffer({ resolveWithObject: true });
  ctx.layers.push({ input: buf.data, left: Math.round(ctx.W - right - buf.info.width), top: Math.round(top ?? ctx.H - bottom - buf.info.height) });
  return buf.info.width;
}

async function symbolicLabel(ctx) {
  if (!ctx.brief.label_symbolic) return;
  const r = await ctx.text("symbolic_label", "প্রতীকী ছবি", { weight: "Regular", size: 22, min: 20, width: 400 * ctx.s, color: "#FFFFFF" });
  const pad = 14 * ctx.s;
  ctx.shapes.push(rect(ctx.W - ctx.M - r.width - 2 * pad, ctx.M / 2, r.width + 2 * pad, r.height + 2 * pad, "#000000", { r: 10 * ctx.s, opacity: 0.45 }));
  place(ctx, r, ctx.W - ctx.M - r.width - pad, ctx.M / 2 + pad);
}

/** Bottom attribution line ("ডা. হালিমা · গাইনি ও প্রসূতি") + optional logo. Returns the y where it starts. */
async function footer(ctx, { color = ctx.c.text, onDark = false } = {}) {
  const logoW = await logo(ctx, { right: ctx.M, bottom: ctx.M * 0.75, maxH: 56 * ctx.s });
  const label = ctx.t.attribution || ctx.brand.brand_name;
  const r = await ctx.text("attribution", label, { weight: "SemiBold", size: 26, min: 22, width: ctx.W - 2 * ctx.M - logoW - 20 * ctx.s, maxLines: 1, color: onDark ? ctx.c.text_light : color });
  const top = ctx.H - ctx.M * 0.75 - r.height;
  place(ctx, r, ctx.M, top);
  return top;
}

/** Dark band behind text on photos: brand charcoal warmed with 30% of the heading colour (no new hue). */
const warmOverlay = (c) => mix(c.overlay, c.title, 0.3);

/** CTA as a rounded button in the colour of its kind (appointment / save / health tip). Returns its height. */
async function ctaPill(ctx, x, bottom, { full = false } = {}) {
  const { W, M, s, c, t, brief } = ctx;
  const fill = c.cta[brief.cta_kind] ?? c.cta.default;
  const r = await ctx.text("cta", t.cta, { weight: full ? "Bold" : "SemiBold", size: full ? 34 : 30, min: 24, width: W - 2 * M - 60 * s, maxLines: 1, color: c.on(fill), align: full ? "centre" : "left" });
  const ph = r.height + (full ? 40 : 34) * s;
  const pw = full ? W - 2 * M : r.width + 56 * s;
  ctx.shapes.push(rect(x, bottom - ph, pw, ph, fill, { r: ph / 2 }));
  place(ctx, r, full ? x + (pw - r.width) / 2 : x + 28 * s, bottom - ph + (ph - r.height) / 2);
  return ph;
}

function panel(ctx, top) {
  const r = 40 * ctx.s;
  ctx.shapes.push(rect(0, top, ctx.W, ctx.H - top + r, ctx.c.background, { r }));
}

/** Render list rows at a common size, shrinking all rows together until they fit `available`. */
async function fitRows(ctx, items, { label, size, min, width, available, rowMin, gap }) {
  for (let px = size; ; px -= 2) {
    const rows = [];
    let total = 0;
    try {
      for (const [i, item] of items.entries()) {
        const r = await renderText({ text: item, fontFile: ctx.brand.fontFiles.semibold, family: ctx.brand.fonts.family, weight: "SemiBold", sizePx: px * ctx.s, minPx: px * ctx.s, width, color: ctx.c.text, label: `${label} ${i + 1}` });
        rows.push(r);
        total += Math.max(r.height, rowMin) + (i ? gap : 0);
      }
    } catch (err) {
      if (err.code !== "TEXT_TOO_LONG") throw err;
      total = Infinity;
    }
    if (total <= available) {
      ctx.report.sizes[label] = px;
      for (const item of items) {
        ctx.report.blocks.push({ label, text: item });
        ctx.report.graphemes += graphemeCount(item);
      }
      return { rows, total };
    }
    if (px - 2 < min) {
      throw new ImageError("TEXT_TOO_LONG", `${items.length} ${label} do not fit even at ${min}px — shorten them or turn the post into a carousel`, { label, recommend: "carousel" });
    }
  }
}

// ───────────────────────────── layouts ─────────────────────────────

async function hookBand(ctx, { tag } = {}) {
  const { W, H, M, s, c, t } = ctx;
  ctx.shapes.push(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${warmOverlay(c)}" stop-opacity="0"/><stop offset="1" stop-color="${warmOverlay(c)}" stop-opacity="0.92"/></linearGradient></defs>`);
  ctx.shapes.push(`<rect x="0" y="${H * 0.36}" width="${W}" height="${H * 0.64}" fill="url(#g)"/>`);
  let bottom = (await footer(ctx, { onDark: true })) - 30 * s;
  if (t.cta) bottom -= (await ctaPill(ctx, M, bottom)) + 34 * s;
  if (tag) {
    const r = await ctx.text("tag", tag, { weight: "SemiBold", size: 26, min: 22, width: W - 2 * M, maxLines: 1, color: c.text_light });
    place(ctx, r, M, bottom - r.height);
    bottom -= r.height + 24 * s;
  }
  if (t.subtitle) {
    const r = await ctx.text("subtitle", t.subtitle, { weight: "SemiBold", size: 36, min: 28, width: W - 2 * M, maxLines: 3, maxHeight: H * 0.16, color: c.text_light });
    place(ctx, r, M, bottom - r.height);
    bottom -= r.height + 22 * s;
  }
  const h = await ctx.text("headline", t.headline, { weight: "Bold", size: 68, min: 46, width: W - 2 * M, maxLines: 4, maxHeight: H * 0.28, color: c.text_light });
  place(ctx, h, M, bottom - h.height);
  if (bottom - h.height < H * 0.38) throw new ImageError("TEXT_TOO_LONG", "Headline + subtitle + CTA take more than the lower 62% of the image", { label: "headline", recommend: "shorten" });
  await symbolicLabel(ctx);
}

async function listLayout(ctx, { timeline = false } = {}) {
  const { W, H, M, s, c, t, brief } = ctx;
  const area = imageArea(timeline ? "timeline" : "list", W, H);
  const top = area.height - 40 * s;
  panel(ctx, top);
  let y = top + 48 * s;
  if (t.badge) {
    const warn = brief.badge === "warning";
    const fill = warn ? c.title : c.health;
    const r = await ctx.text("badge", t.badge, { weight: "Bold", size: 26, min: 22, width: W / 2, maxLines: 1, color: c.on(fill) });
    const ph = r.height + 22 * s;
    ctx.shapes.push(rect(M, y, r.width + 44 * s, ph, fill, { r: ph / 2 }));
    place(ctx, r, M + 22 * s, y + 11 * s);
    y += ph + 22 * s;
  }
  const h = await ctx.text("headline", t.headline, { weight: "Bold", size: 54, min: 40, width: W - 2 * M, maxLines: 3, color: c.title });
  place(ctx, h, M, y);
  y += h.height + 34 * s;

  let bottom = (await footer(ctx)) - 26 * s;
  if (t.cta) bottom -= (await ctaPill(ctx, M, bottom)) + 26 * s;
  if (!t.items?.length) return;
  const d = 52 * s;
  const gap = 24 * s;
  const textX = M + d + 26 * s;
  const { rows } = await fitRows(ctx, t.items, { label: "items", size: 38, min: 26, width: W - textX - M, available: bottom - y, rowMin: d, gap });
  if (timeline && rows.length > 1) {
    let last = y;
    for (const [i, r] of rows.entries()) if (i < rows.length - 1) last += Math.max(r.height, d) + gap;
    ctx.shapes.push(`<line x1="${M + d / 2}" y1="${y + d / 2}" x2="${M + d / 2}" y2="${last + d / 2}" stroke="${c.highlight}" stroke-width="${4 * s}"/>`);
  }
  for (const [i, r] of rows.entries()) {
    const rowH = Math.max(r.height, d);
    const cx = M + d / 2;
    const cy = y + d / 2;
    if (brief.badge === "check") ctx.shapes.push(circle(cx, cy, d / 2, c.health) + checkIcon(cx, cy, d / 2, c.on(c.health)));
    else if (brief.badge === "warning") ctx.shapes.push(circle(cx, cy, d / 2, c.title) + bangIcon(cx, cy, d / 2, c.on(c.title)));
    else {
      ctx.shapes.push(circle(cx, cy, d / 2, c.highlight));
      const n = await renderText({ text: toBanglaDigits(i + 1), fontFile: ctx.brand.fontFiles.bold, family: ctx.brand.fonts.family, sizePx: 28 * s, width: d, color: c.on(c.highlight), align: "centre" });
      place(ctx, n, cx - n.width / 2, cy - n.height / 2);
    }
    place(ctx, r, textX, y + Math.max(0, (d - r.height) / 2 - 4 * s));
    y += rowH + gap;
  }
}

async function mythFact(ctx) {
  const { W, H, M, s, c, t } = ctx;
  const top = imageArea("myth_fact", W, H).height - 40 * s;
  panel(ctx, top);
  let y = top + 44 * s;
  const h = await ctx.text("headline", t.headline, { weight: "Bold", size: 50, min: 38, width: W - 2 * M, maxLines: 2, color: c.title });
  place(ctx, h, M, y);
  y += h.height + 30 * s;
  let bottom = (await footer(ctx)) - 30 * s;
  if (t.cta) bottom -= (await ctaPill(ctx, M, bottom)) + 26 * s;
  const pad = 30 * s;
  const icon = 56 * s;
  const textW = W - 2 * M - 3 * pad - icon;
  const cards = [
    // Myth = deep rose on a soft-pink tint; fact = sage (health content) on a sage tint.
    { kind: "myth", label: t.myth_label, body: t.myth, color: c.title, labelColor: c.title, bg: mix(c.background, c.highlight, 0.28) },
    { kind: "fact", label: t.fact_label, body: t.fact, color: c.health, labelColor: mix(c.health, c.text, 0.55), bg: mix(c.background, c.health, 0.3) },
  ];
  const gap = 24 * s;
  for (let px = 40; ; px -= 2) {
    const rendered = [];
    for (const card of cards) {
      const label = await renderText({ text: card.label, fontFile: ctx.brand.fontFiles.bold, family: ctx.brand.fonts.family, sizePx: 30 * s, width: textW, color: card.labelColor });
      const body = await renderText({ text: card.body, fontFile: ctx.brand.fontFiles.semibold, family: ctx.brand.fonts.family, weight: "SemiBold", sizePx: px * s, minPx: px * s, width: textW, color: c.text, label: card.kind });
      rendered.push({ card, label, body, h: 2 * pad + Math.max(icon, label.height + 12 * s + body.height) });
    }
    const total = rendered[0].h + gap + rendered[1].h;
    if (total <= bottom - y || px - 2 < 26) {
      if (total > bottom - y) throw new ImageError("TEXT_TOO_LONG", "Myth and fact texts do not fit — shorten them or use a carousel", { label: "myth_fact", recommend: "carousel" });
      ctx.report.sizes.myth_fact = px;
      y += Math.max(0, (bottom - y - total) / 2); // centre the two cards in the free space
      for (const r of rendered) {
        ctx.shapes.push(rect(M, y, W - 2 * M, r.h, r.card.bg, { r: 24 * s }));
        const cx = M + pad + icon / 2;
        const cy = y + pad + icon / 2;
        ctx.shapes.push(circle(cx, cy, icon / 2, r.card.color) + (r.card.kind === "myth" ? crossIcon(cx, cy, icon / 2, c.on(r.card.color)) : checkIcon(cx, cy, icon / 2, c.on(r.card.color))));
        place(ctx, r.label, M + 2 * pad + icon, y + pad);
        place(ctx, r.body, M + 2 * pad + icon, y + pad + r.label.height + 12 * s);
        ctx.report.blocks.push({ label: r.card.kind, text: r.card.body }, { label: `${r.card.kind}_label`, text: r.card.label });
        ctx.report.graphemes += graphemeCount(r.card.body) + graphemeCount(r.card.label);
        y += r.h + gap;
      }
      return;
    }
  }
}

async function twoColumn(ctx) {
  const { W, H, M, s, c, t, brief } = ctx;
  ctx.shapes.push(rect(M / 2, M / 2, W - M, H - M, c.background, { r: 32 * s, opacity: 0.94 }));
  let y = M * 1.4;
  const h = await ctx.text("headline", t.headline, { weight: "Bold", size: 52, min: 38, width: W - 3 * M, maxLines: 3, color: c.title, align: "centre" });
  place(ctx, h, (W - h.width) / 2, y);
  y += h.height + 40 * s;
  const bottom = (await footer(ctx)) - 30 * s;
  const gap = 28 * s;
  const colW = (W - 2 * M - gap) / 2;
  const isDoDont = brief.visual_type === "do_dont";
  const cols = [
    { ...t.columns.left, color: isDoDont ? c.health : c.highlight, icon: isDoDont ? "check" : "dot" },
    { ...t.columns.right, color: isDoDont ? c.title : c.health, icon: isDoDont ? "cross" : "dot" },
  ];
  for (const [i, col] of cols.entries()) {
    const x = M + i * (colW + gap);
    const head = await ctx.text(`column_${i + 1}_title`, col.title, { weight: "Bold", size: 30, min: 24, width: colW - 40 * s, maxLines: 1, color: c.on(col.color), align: "centre" });
    const ph = head.height + 30 * s;
    ctx.shapes.push(rect(x, y, colW, ph, col.color, { r: 18 * s }));
    place(ctx, head, x + (colW - head.width) / 2, y + 15 * s);
    let cy = y + ph + 26 * s;
    const icon = 30 * s;
    const { rows } = await fitRows(ctx, col.items, { label: `column_${i + 1}_items`, size: 30, min: 22, width: colW - icon - 18 * s, available: bottom - cy, rowMin: icon, gap: 20 * s });
    for (const r of rows) {
      const ix = x + icon / 2;
      const iy = cy + icon / 2 + 2 * s;
      ctx.shapes.push(col.icon === "check" ? circle(ix, iy, icon / 2, col.color) + checkIcon(ix, iy, icon / 2, c.on(col.color)) : col.icon === "cross" ? circle(ix, iy, icon / 2, col.color) + crossIcon(ix, iy, icon / 2, c.on(col.color)) : circle(ix, iy, icon / 4, col.color));
      place(ctx, r, x + icon + 18 * s, cy);
      cy += Math.max(r.height, icon) + 20 * s;
    }
  }
}

async function question(ctx) {
  const { W, H, M, s, c, t } = ctx;
  ctx.shapes.push(`<defs><linearGradient id="q" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${warmOverlay(c)}" stop-opacity="0"/><stop offset="1" stop-color="${warmOverlay(c)}" stop-opacity="0.9"/></linearGradient></defs>`);
  ctx.shapes.push(`<rect x="0" y="${H * 0.3}" width="${W}" height="${H * 0.7}" fill="url(#q)"/>`);
  let bottom = (await footer(ctx, { onDark: true })) - 34 * s;
  if (t.cta) bottom -= (await ctaPill(ctx, M, bottom)) + 30 * s;
  if (t.subtitle) {
    const r = await ctx.text("subtitle", t.subtitle, { weight: "SemiBold", size: 36, min: 28, width: W - 2 * M, maxLines: 3, color: c.text_light });
    place(ctx, r, M, bottom - r.height);
    bottom -= r.height + 24 * s;
  }
  const h = await ctx.text("headline", t.headline, { weight: "Bold", size: 76, min: 50, width: W - 2 * M, maxLines: 4, maxHeight: H * 0.34, color: c.text_light });
  place(ctx, h, M, bottom - h.height);
  const d = 92 * s;
  const qy = bottom - h.height - 30 * s - d;
  ctx.shapes.push(circle(M + d / 2, qy + d / 2, d / 2, c.highlight));
  const q = await renderText({ text: "?", fontFile: ctx.brand.fontFiles.bold, family: ctx.brand.fonts.family, sizePx: 60 * s, width: d, color: c.on(c.highlight), align: "centre" });
  place(ctx, q, M + (d - q.width) / 2, qy + (d - q.height) / 2);
  await symbolicLabel(ctx);
}

async function ctaPoster(ctx) {
  const { W, H, M, s, c, t } = ctx;
  const top = imageArea("cta_poster", W, H).height - 40 * s;
  panel(ctx, top);
  let y = top + 46 * s;
  const h = await ctx.text("headline", t.headline, { weight: "Bold", size: 56, min: 42, width: W - 2 * M, maxLines: 3, color: c.title });
  place(ctx, h, M, y);
  y += h.height + 22 * s;
  if (t.subtitle) {
    const r = await ctx.text("subtitle", t.subtitle, { weight: "SemiBold", size: 34, min: 26, width: W - 2 * M, maxLines: 2, color: c.text });
    place(ctx, r, M, y);
    y += r.height + 26 * s;
  }
  for (const [i, line] of (t.contact ?? []).entries()) {
    const r = await ctx.text(`contact_${i + 1}`, line, { weight: "SemiBold", size: 30, min: 24, width: W - 2 * M - 30 * s, maxLines: 2, color: c.text });
    ctx.shapes.push(circle(M + 8 * s, y + 18 * s, 7 * s, c.highlight));
    place(ctx, r, M + 30 * s, y);
    y += r.height + 16 * s;
  }
  const bottom = (await footer(ctx)) - 26 * s;
  const bh = await ctaPill(ctx, M, bottom, { full: true });
  if (bottom - bh < y) throw new ImageError("TEXT_TOO_LONG", "Appointment poster text does not fit", { label: "cta_poster", recommend: "shorten" });
}

async function doctorQuote(ctx) {
  const { W, H, M, s, c, t, brand } = ctx;
  const top = imageArea("doctor_quote", W, H).height - 40 * s;
  panel(ctx, top);
  const logoW = await logo(ctx, { right: M, bottom: M * 0.75, maxH: 56 * s });
  const markH = 56 * s;
  const regionTop = top + 44 * s;
  const regionBottom = H - M * 0.75;
  const nameR = await ctx.text("name", brand.person.display_name_bn || brand.brand_name, { weight: "Bold", size: 34, min: 28, width: W - 2 * M - logoW, maxLines: 1, color: c.title });
  const cred = brand.person.credentials_bn ? await ctx.text("credentials", brand.person.credentials_bn, { weight: "Regular", size: 24, min: 20, width: W - 2 * M - logoW, maxLines: 2, color: c.text }) : null;
  const signH = nameR.height + (cred ? cred.height + 10 * s : 0);
  const fixedH = markH + 28 * s + 40 * s + signH;
  const q = await ctx.text("headline", t.headline, { weight: "SemiBold", size: 48, min: 32, width: W - 2 * M, maxLines: 6, maxHeight: regionBottom - regionTop - fixedH, color: c.text });
  let y = regionTop + Math.max(0, (regionBottom - regionTop - (fixedH + q.height)) / 2);
  ctx.shapes.push(quoteMark(M, y, markH, c.highlight));
  y += markH + 28 * s;
  place(ctx, q, M, y);
  y += q.height + 40 * s;
  ctx.shapes.push(rect(M, y - 20 * s, 80 * s, 5 * s, c.highlight, { r: 2 * s }));
  place(ctx, nameR, M, y);
  if (cred) place(ctx, cred, M, y + nameR.height + 10 * s);
}

async function stat(ctx) {
  const { W, H, M, s, c, t } = ctx;
  const cardW = W - 2 * M;
  const inner = cardW - 2 * M;
  const parts = [];
  parts.push(["headline", await ctx.text("headline", t.headline, { weight: "Bold", size: 44, min: 34, width: inner, maxLines: 3, color: c.title, align: "centre" })]);
  parts.push(["stat_value", await ctx.text("stat_value", t.stat.value, { weight: "Bold", size: 150, min: 90, width: inner, maxLines: 1, color: c.title, align: "centre" })]);
  parts.push(["stat_label", await ctx.text("stat_label", t.stat.label, { weight: "SemiBold", size: 38, min: 28, width: inner, maxLines: 3, color: c.text, align: "centre" })]);
  parts.push(["source_note", await ctx.text("source_note", t.source_note, { weight: "Regular", size: 24, min: 20, width: inner, maxLines: 2, color: c.text, align: "centre" })]);
  const gap = 30 * s;
  const cardH = parts.reduce((sum, [, r]) => sum + r.height, 0) + gap * (parts.length - 1) + 2 * M;
  const bottom = (await footer(ctx, { onDark: false })) - 30 * s;
  const cardTop = Math.max(M, (bottom - cardH) / 2);
  if (cardTop + cardH > bottom) throw new ImageError("TEXT_TOO_LONG", "Statistic card does not fit", { label: "stat", recommend: "shorten" });
  ctx.shapes.push(rect(0, bottom - 10 * s, W, H - bottom + 10 * s, c.background, { opacity: 0.9 }));
  ctx.shapes.push(rect(M, cardTop, cardW, cardH, c.background, { r: 32 * s, opacity: 0.96 }));
  let y = cardTop + M;
  for (const [, r] of parts) {
    place(ctx, r, (W - r.width) / 2, y);
    y += r.height + gap;
  }
}

async function carouselContent(ctx, slide, index, total) {
  const { W, H, M, s, c, brief } = ctx;
  ctx.shapes.push(rect(0, 0, W, H, c.background));
  ctx.shapes.push(rect(0, 0, 14 * s, H, c.highlight));
  const counter = await ctx.text("slide_counter", `${toBanglaDigits(index)}/${toBanglaDigits(total)}`, { weight: "SemiBold", size: 28, min: 24, width: 300 * s, maxLines: 1, color: c.text });
  place(ctx, counter, W - M - counter.width, M);
  if (brief.topic) place(ctx, await ctx.text("slide_topic", brief.topic, { weight: "SemiBold", size: 28, min: 22, width: W - 3 * M - counter.width, maxLines: 1, color: c.text }), M, M);
  const top = M + counter.height + 60 * s;
  const bottom = (await footer(ctx)) - 40 * s;
  // Big numbered badge (point 1 = slide 2) so a short point still fills the slide with purpose.
  const d = 120 * s;
  const n = await renderText({ text: toBanglaDigits(index - 1), fontFile: ctx.brand.fontFiles.bold, family: ctx.brand.fonts.family, sizePx: 64 * s, width: d, color: c.on(c.highlight), align: "centre" });
  const title = await ctx.text("slide_title", slide.title, { weight: "Bold", size: slide.body ? 58 : 70, min: 42, width: W - 2 * M, maxLines: 5, maxHeight: (bottom - top) * 0.5, color: c.title });
  const body = slide.body ? await ctx.text("slide_body", slide.body, { weight: "SemiBold", size: 40, min: 30, width: W - 2 * M, maxHeight: (bottom - top) * 0.4, color: c.text }) : null;
  const blockH = d + 50 * s + title.height + (body ? 40 * s + body.height : 0);
  let y = top + Math.max(0, (bottom - top - blockH) / 2);
  ctx.shapes.push(circle(M + d / 2, y + d / 2, d / 2, c.highlight));
  place(ctx, n, M + (d - n.width) / 2, y + (d - n.height) / 2);
  y += d + 50 * s;
  place(ctx, title, M, y);
  if (body) place(ctx, body, M, y + title.height + 40 * s);
}

async function carouselEnd(ctx, index, total) {
  const { W, H, M, s, c, t, brand } = ctx;
  ctx.shapes.push(rect(0, 0, W, H, c.title));
  const counter = await ctx.text("slide_counter", `${toBanglaDigits(index)}/${toBanglaDigits(total)}`, { weight: "SemiBold", size: 28, min: 24, width: 300 * s, maxLines: 1, color: c.text_light });
  place(ctx, counter, M, M);
  const blocks = [];
  blocks.push(await ctx.text("cta", t.cta || t.end_label, { weight: "Bold", size: 56, min: 42, width: W - 2 * M, maxLines: 3, color: c.text_light, align: "centre" }));
  for (const [i, line] of (t.contact ?? []).entries()) blocks.push(await ctx.text(`contact_${i + 1}`, line, { weight: "SemiBold", size: 30, min: 24, width: W - 2 * M, maxLines: 2, color: c.text_light, align: "centre" }));
  if (brand.person.display_name_bn) blocks.push(await ctx.text("name", brand.person.display_name_bn, { weight: "Bold", size: 36, min: 28, width: W - 2 * M, maxLines: 1, color: c.text_light, align: "centre" }));
  if (brand.person.credentials_bn) blocks.push(await ctx.text("credentials", brand.person.credentials_bn, { weight: "SemiBold", size: 26, min: 22, width: W - 2 * M, maxLines: 2, color: c.text_light, align: "centre" }));
  const gap = 28 * s;
  const total_h = blocks.reduce((a, r) => a + r.height, 0) + gap * (blocks.length - 1);
  let y = (H - total_h) / 2;
  for (const r of blocks) {
    place(ctx, r, (W - r.width) / 2, y);
    y += r.height + gap;
  }
  await logo(ctx, { right: M, bottom: M, maxH: 64 * s });
}

const LAYOUTS = {
  hook_band: (ctx) => hookBand(ctx),
  list: (ctx) => listLayout(ctx),
  timeline: (ctx) => listLayout(ctx, { timeline: true }),
  myth_fact: mythFact,
  two_column: twoColumn,
  question,
  cta_poster: ctaPoster,
  doctor_quote: doctorQuote,
  stat,
};
export const LAYOUT_IDS = [...Object.keys(LAYOUTS), "carousel"];

async function flatten(ctx, format) {
  // Order: background picture → vector shapes (panels, badges, icons) → text and logo on top.
  const composite = [...(ctx.bg ? [ctx.bg] : []), { input: svg(ctx.W, ctx.H, ctx.shapes.join("")), left: 0, top: 0 }, ...ctx.layers];
  const img = sharp({ create: { width: ctx.W, height: ctx.H, channels: 3, background: ctx.c.background } }).composite(composite);
  return format === "png" ? img.png().toBuffer() : img.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

/**
 * Draw one finished image: AI background + shapes + Bangla text.
 * @param {object} p
 * @param {string} p.layout      layout id (see LAYOUT_IDS)
 * @param {Buffer|null} p.background  generated picture, or null → grey dry-run placeholder
 * @param {Buffer|null} [p.photo]  approved real photo (doctor_quote) — used instead of the AI picture
 * @returns {Promise<{ buffer: Buffer, report: object }>}
 */
export async function composeImage({ layout, background, photo = null, brief, brand, width, height, format = "jpeg" }) {
  if (!LAYOUTS[layout]) throw new ImageError("UNSUPPORTED_LAYOUT", `Unknown layout "${layout}"`);
  const ctx = makeContext({ brand, brief, width, height });
  await backgroundInto(ctx, photo ?? background, imageArea(layout, width, height));
  await LAYOUTS[layout](ctx);
  return { buffer: await flatten(ctx, format), report: { layout, ...ctx.report } };
}

/** Carousel: slide 1 = picture + hook, middle slides = one point each, last slide = CTA + attribution. */
export async function composeCarousel({ background, brief, brand, width, height, format = "jpeg" }) {
  const slides = brief.text.slides ?? [];
  const total = slides.length + 2;
  const out = [];
  const cover = makeContext({ brand, brief: { ...brief, text: { ...brief.text, cta: "" } }, width, height });
  await backgroundInto(cover, background, imageArea("carousel", width, height));
  await hookBand(cover, { tag: brief.text.swipe_label });
  out.push({ buffer: await flatten(cover, format), report: { layout: "carousel_cover", ...cover.report } });
  for (const [i, slide] of slides.entries()) {
    const ctx = makeContext({ brand, brief, width, height });
    await carouselContent(ctx, slide, i + 2, total);
    out.push({ buffer: await flatten(ctx, format), report: { layout: "carousel_content", ...ctx.report } });
  }
  const end = makeContext({ brand, brief, width, height });
  await carouselEnd(end, total, total);
  out.push({ buffer: await flatten(end, format), report: { layout: "carousel_end", ...end.report } });
  return out;
}
