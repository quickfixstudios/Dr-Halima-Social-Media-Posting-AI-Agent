import { ImageError } from "./errors.js";

/**
 * Output formats per platform. The pipeline never hard-codes pixel sizes elsewhere — change them here.
 * width/height = the final file posted to the platform.
 */
export const FORMATS = {
  facebook: {
    "4:5": { width: 1080, height: 1350, use: "feed (default — fills more of the phone screen)" },
    "1:1": { width: 1080, height: 1080, use: "feed square" },
    "9:16": { width: 1080, height: 1920, use: "stories / reel cover" },
    "1.91:1": { width: 1200, height: 628, use: "link / landscape" },
  },
  instagram: {
    "4:5": { width: 1080, height: 1350, use: "feed" },
    "1:1": { width: 1080, height: 1080, use: "feed square" },
    "9:16": { width: 1080, height: 1920, use: "stories / reels" },
  },
};
export const DEFAULT_ASPECT = { facebook: "4:5", instagram: "4:5" };

// Sizes the older GPT image models accept. Newer models (gpt-image-2 family) accept any WxH divisible by 16.
const STANDARD_SIZES = [
  [1024, 1024],
  [1024, 1536],
  [1536, 1024],
];
const MAX_EDGE = 1536;
const MIN_EDGE = 768;

export function outputSize(platform, aspect) {
  const p = FORMATS[platform];
  if (!p) throw new ImageError("UNSUPPORTED_PLATFORM", `Platform "${platform}" is not configured in imaging/formats.js`);
  const f = p[aspect];
  if (!f) throw new ImageError("UNSUPPORTED_ASPECT", `Aspect ratio "${aspect}" is not configured for ${platform}. Use one of: ${Object.keys(p).join(", ")}`);
  return { width: f.width, height: f.height };
}

const round16 = (n) => Math.max(16, Math.round(n / 16) * 16);

/**
 * Size to ask the image model for, so its picture already has the shape of the area it will fill
 * (no wasted pixels, minimal cropping). The final resize to exact pixels happens in the overlay step.
 * @param {number} ratio width / height of the target area
 */
export function generationSize(ratio, { arbitrarySizes = true } = {}) {
  if (!(ratio > 0)) throw new ImageError("INVALID_SIZE", `Invalid aspect ratio ${ratio}`);
  if (!arbitrarySizes) {
    const best = STANDARD_SIZES.reduce((a, b) => (Math.abs(Math.log(b[0] / b[1] / ratio)) < Math.abs(Math.log(a[0] / a[1] / ratio)) ? b : a));
    return `${best[0]}x${best[1]}`;
  }
  const r = Math.min(3, Math.max(1 / 3, ratio)); // model limit: between 1:3 and 3:1
  let w;
  let h;
  if (r >= 1) {
    w = MAX_EDGE;
    h = Math.max(MIN_EDGE, MAX_EDGE / r);
  } else {
    h = MAX_EDGE;
    w = Math.max(MIN_EDGE, MAX_EDGE * r);
  }
  return `${round16(w)}x${round16(h)}`;
}

export const parseSize = (s) => s.split("x").map(Number);
