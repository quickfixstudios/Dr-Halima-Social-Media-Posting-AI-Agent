import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT, imagingConfig } from "../config.js";
import { ImageError } from "./errors.js";

// Neutral rendering defaults used ONLY while a brand has not chosen its colours. They are not brand colours;
// every image that uses them gets a "brand colours not configured" warning in its review checklist.
export const PLACEHOLDER_COLORS = {
  primary: "#2F4858",
  secondary: "#E9EEF1",
  accent: "#2A7F79",
  text_dark: "#1E2A32",
  text_light: "#FFFFFF",
  panel: "#FFFFFF",
};

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
  colors: z.record(z.string(), z.string()).default({}),
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

  const colorsArePlaceholders = Object.keys(PLACEHOLDER_COLORS).some((k) => !brand.colors[k]);
  const colorsResolved = Object.fromEntries(Object.entries(PLACEHOLDER_COLORS).map(([k, v]) => [k, brand.colors[k] || v]));
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
