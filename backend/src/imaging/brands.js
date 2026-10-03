import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT, imagingConfig } from "../config.js";
import { ImageError } from "./errors.js";

/**
 * Colour ROLES used by the image templates (what each colour is for). A brand file fills them from its
 * guideline palette. Missing roles fall back to these neutral defaults — not brand colours — and every image
 * that uses them gets a "brand colours not configured" note in its review checklist.
 */
export const PLACEHOLDER_COLORS = {
  background: "#F6F7F7", // panels, slide backgrounds
  title: "#2F4858", // headings, emphasis
  text: "#1E2A32", // body text
  text_light: "#FFFFFF", // text on dark areas / photos
  highlight: "#2A7F79", // number badges, quote mark, accent bars
  health: "#5E8C61", // health tips, facts, "do" items, checks
  overlay: "#1E2A32", // dark gradient that keeps text readable over photos
};
export const CTA_KINDS = ["appointment", "save", "health_tip", "default"];

const HEX = /^#[0-9A-Fa-f]{6}$/;
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrastRatio = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
/** Mix a colour with another (0 = first colour, 1 = second) — used for soft tints, never new hues. */
export function mix(hexA, hexB, amount) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * amount).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const str = z.string().default("");
const BrandSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/, "id must be lowercase letters, digits and _"),
  brand_name: z.string().min(1),
  asset_folder: z.string().regex(/^[a-z0-9-]+$/),
  category: str,
  medical: z.boolean().default(false),
  primary_language: z.string().default("bn"),
  secondary_language: z.string().default("en"),
  audience: str,
  visual_style: str,
  image_style: z.enum(["photo", "illustration"]).default("photo"), // default look for pictures with people
  tone: str,
  preferred_formats: z.array(z.string()).default(["4:5"]),
  person: z
    .object({
      display_name_bn: str,
      display_name_en: str,
      credentials_bn: str,
      role_bn: str,
      attribution_bn: str,
      photo_path: str,
      photo_approved: z.boolean().default(false),
      forbidden_titles: z.array(z.string()).default([]),
    })
    .default({}),
  caption_signature: z.array(z.string()).default([]),
  logo_path: str,
  contact_details: z.record(z.string(), z.string()).default({}),
  palette: z.array(z.object({ name: z.string(), hex: z.string().regex(HEX, "palette hex must look like #A1B2C3"), usage: z.string().default("") })).default([]),
  colors: z.record(z.string(), z.string()).default({}),
  cta_colors: z.record(z.string(), z.string()).default({}),
  color_avoid: z.array(z.string()).default([]),
  brand_feel: str,
  fonts: z.object({ family: z.string(), regular: z.string(), semibold: z.string(), bold: z.string() }),
  visual_context: z
    .object({
      people: str,
      wardrobe: z.array(z.string()).default([]),
      settings: z.record(z.string(), z.string()).default({}),
    })
    .default({}),
  disallowed_styles: z.array(z.string()).default([]),
  safety: z.object({ require_content_approval: z.boolean().default(true), require_image_approval: z.boolean().default(true) }).default({}),
  make: z.object({ webhook_url_env: str }).default({}),
});

const resolveRepoPath = (p) => (p ? (path.isAbsolute(p) ? p : path.join(REPO_ROOT, p)) : "");

/**
 * Load brands/<businessId>.json, validate it, resolve file paths and fill rendering defaults.
 * @returns {object} brand with extra fields: `colorsResolved`, `colorsArePlaceholders`, `fontFiles`, `photoFile`, `logoFile`, `warnings`
 */
export function loadBrand(businessId, { brandsDir = imagingConfig().brandsDir } = {}) {
  if (!/^[a-z0-9_]+$/.test(businessId ?? "")) throw new ImageError("INVALID_BUSINESS", `Invalid business id "${businessId}"`);
  const file = path.join(brandsDir, `${businessId}.json`);
  if (!fs.existsSync(file)) throw new ImageError("BRAND_NOT_FOUND", `No business profile at ${file}. Create it by copying brands/quickfix_studios.json.`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new ImageError("BRAND_INVALID", `${file} is not valid JSON: ${err.message}`);
  }
  const parsed = BrandSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ImageError("BRAND_INVALID", `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const brand = parsed.data;
  if (brand.id !== businessId) throw new ImageError("BRAND_INVALID", `${file}: "id" is "${brand.id}" but the file is named ${businessId}.json`);

  const warnings = [];
  const fontFiles = {};
  for (const weight of ["regular", "semibold", "bold"]) {
    fontFiles[weight] = resolveRepoPath(brand.fonts[weight]);
    if (!fs.existsSync(fontFiles[weight])) throw new ImageError("FONT_MISSING", `Font file not found: ${fontFiles[weight]}`);
  }

  // Colours: every value must be #RRGGBB, and (when a guideline palette exists) come from that palette.
  const paletteHex = new Set(brand.palette.map((p) => p.hex.toUpperCase()));
  for (const [group, values] of [["colors", brand.colors], ["cta_colors", brand.cta_colors]]) {
    for (const [role, hex] of Object.entries(values)) {
      if (!hex) continue;
      if (!HEX.test(hex)) throw new ImageError("BRAND_INVALID", `${file}: ${group}.${role} "${hex}" is not a #RRGGBB colour`);
      if (paletteHex.size && !paletteHex.has(hex.toUpperCase())) throw new ImageError("BRAND_INVALID", `${file}: ${group}.${role} ${hex} is not in the brand palette (guidelines: avoid too many colours)`);
    }
  }
  const colorsArePlaceholders = Object.keys(PLACEHOLDER_COLORS).some((k) => !brand.colors[k]);
  const colorsResolved = Object.fromEntries(Object.entries(PLACEHOLDER_COLORS).map(([k, v]) => [k, (brand.colors[k] || v).toUpperCase()]));
  colorsResolved.cta = Object.fromEntries(CTA_KINDS.map((k) => [k, (brand.cta_colors[k] || brand.cta_colors.default || colorsResolved.title).toUpperCase()]));
  /** Readable text colour on a filled shape: brand charcoal on light fills, brand ivory on dark ones. */
  colorsResolved.on = (fill) => (contrastRatio(fill, colorsResolved.text) >= contrastRatio(fill, colorsResolved.text_light) ? colorsResolved.text : colorsResolved.text_light);
  if (colorsArePlaceholders) warnings.push("Brand colours are not configured yet; neutral placeholder colours were used.");

  const existing = (p, label) => {
    const abs = resolveRepoPath(p);
    if (abs && !fs.existsSync(abs)) {
      warnings.push(`${label} is set to ${p} but that file does not exist.`);
      return "";
    }
    return abs;
  };
  const photoFile = brand.person.photo_approved ? existing(brand.person.photo_path, "person.photo_path") : "";
  const logoFile = existing(brand.logo_path, "logo_path");

  return { ...brand, file, fontFiles, colorsResolved, colorsArePlaceholders, photoFile, logoFile, warnings };
}

/** Contact lines that are actually filled in, in display order. Never invented. */
export function contactLines(brand) {
  const labels = {
    chamber_location: "চেম্বার",
    consultation_days: "সময়",
    appointment_phone: "ফোন",
    whatsapp: "হোয়াটসঅ্যাপ",
    messenger: "মেসেঞ্জার",
    booking_link: "বুকিং",
  };
  return Object.entries(labels)
    .filter(([k]) => brand.contact_details?.[k])
    .map(([k, label]) => ({ key: k, text: `${label}: ${brand.contact_details[k]}` }));
}
