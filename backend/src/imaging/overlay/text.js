import sharp from "sharp";
import { ImageError } from "../errors.js";

/**
 * Bangla-safe text rendering.
 *
 * sharp renders text with Pango + HarfBuzz — the same text-shaping engines browsers use — so Bangla
 * conjuncts (যুক্তাক্ষর such as ক্ষ, ন্ত, র্ভ) and vowel signs are joined correctly. We always pass the brand's own
 * .ttf file, so the result never depends on which fonts the computer has installed.
 */

const escapeMarkup = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Visible characters ("graphemes"): কি counts as 1 even though it is 2 Unicode code points. */
const segmenter = new Intl.Segmenter("bn", { granularity: "grapheme" });
export const graphemeCount = (s = "") => [...segmenter.segment(s)].length;

export const BANGLA_DIGITS = "০১২৩৪৫৬৭৮৯";
export const toBanglaDigits = (n) => String(n).replace(/[0-9]/g, (d) => BANGLA_DIGITS[d]);

/**
 * Render one block of text, shrinking the font until it fits `maxHeight` (and `maxLines` when given).
 * @returns {Promise<{ input: Buffer, width: number, height: number, sizePx: number, lines: number }>}
 * @throws ImageError("TEXT_TOO_LONG") when it does not fit even at `minPx` — the caller decides
 *         whether to shorten the text or recommend a carousel.
 */
export async function renderText({ text, fontFile, family, weight = "Bold", sizePx, minPx, width, maxHeight = Infinity, maxLines = Infinity, color = "#000000", align = "left", label = "text" }) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) throw new ImageError("TEXT_EMPTY", `${label} is empty`);
  const floor = Math.max(8, Math.round(minPx ?? sizePx * 0.7));
  let size = Math.round(sizePx);
  for (;;) {
    const out = await sharp({
      text: {
        text: `<span foreground="${color}">${escapeMarkup(clean)}</span>`,
        font: `${family} ${weight} ${size}`,
        fontfile: fontFile,
        width: Math.round(width),
        align,
        wrap: "word",
        rgba: true,
        dpi: 72, // 72 dpi → font size in points == pixels
      },
    })
      .png()
      .toBuffer({ resolveWithObject: true });
    // Output is trimmed to the ink: first line ≈ 1.0 × size, each further line adds ≈ 1.65 × size (measured for Hind Siliguri).
    const lines = 1 + Math.max(0, Math.round((out.info.height - size * 1.02) / (size * 1.65)));
    if ((out.info.height <= maxHeight && lines <= maxLines) || size <= floor) {
      if (out.info.height > maxHeight || lines > maxLines) {
        throw new ImageError("TEXT_TOO_LONG", `${label} does not fit (needs ${out.info.height}px / ${lines} lines at the minimum readable size ${floor}px; box is ${Math.round(maxHeight)}px)`, {
          label,
          text: clean,
          graphemes: graphemeCount(clean),
        });
      }
      return { input: out.data, width: out.info.width, height: out.info.height, sizePx: size, lines };
    }
    size = Math.max(floor, size - 2);
  }
}
