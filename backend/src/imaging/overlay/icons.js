import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Icons for infographic layouts — drawn from Lucide (https://lucide.dev, ISC licence), so they are crisp,
 * consistent and never garbled like AI-drawn icons. Only this curated, medically neutral list may be used
 * (no pills, syringes or anatomy). The content generator picks from these keys.
 */
export const ICONS = {
  calendar: "calendar",
  clock: "clock-alert",
  water: "glass-water",
  drop: "droplet",
  thermometer: "thermometer",
  heart: "heart-pulse",
  care: "hand-heart",
  baby: "baby",
  mother: "person-standing",
  family: "users",
  woman: "venus",
  food: "salad",
  fruit: "apple",
  vegetable: "carrot",
  fish: "fish",
  egg: "egg",
  grain: "wheat",
  milk: "milk",
  soup: "soup",
  tea: "coffee",
  sleep: "bed",
  rest: "moon",
  walk: "footprints",
  exercise: "activity",
  sun: "sun",
  leaf: "leaf",
  eye: "eye",
  brain: "brain",
  mood_low: "frown",
  mood_ok: "smile",
  warning: "triangle-alert",
  check: "circle-check",
  doctor: "stethoscope",
  hospital: "hospital",
  phone: "phone",
  message: "message-circle",
  weight: "scale",
  ribbon: "ribbon",
  shield: "shield-check",
  sparkle: "sparkles",
  breath: "wind",
  energy: "zap",
  bath: "bath",
  clothes: "shirt",
};
export const ICON_KEYS = Object.keys(ICONS);

const require = createRequire(import.meta.url);
const ICON_DIR = path.join(path.dirname(require.resolve("lucide-static/package.json")), "icons");
const cache = new Map();

function inner(key) {
  const name = ICONS[key] ?? ICONS.check;
  if (!cache.has(name)) {
    const svg = fs.readFileSync(path.join(ICON_DIR, `${name}.svg`), "utf8");
    cache.set(name, svg.slice(svg.indexOf(">", svg.indexOf("<svg")) + 1, svg.lastIndexOf("</svg>")).trim());
  }
  return cache.get(name);
}

/** SVG markup for one icon centred at (cx, cy) with the given size and stroke colour. */
export function iconSvg(key, cx, cy, size, color, strokeWidth = 2) {
  const scale = size / 24;
  return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${scale})" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${inner(key)}</g>`;
}

// Fallback icon from words in the label (Bangla or English), when a post gives only text.
const GUESS = [
  [/পানি|জল|water/i, "water"],
  [/ঘুম|বিশ্রাম|sleep|rest/i, "sleep"],
  [/হাঁট|ব্যায়াম|walk|exercise/i, "walk"],
  [/খাবার|খাদ্য|পুষ্টি|food|diet|eat/i, "food"],
  [/ফল|fruit/i, "fruit"],
  [/মাসিক|তারিখ|সপ্তাহ|period|week|calendar/i, "calendar"],
  [/জ্বর|তাপ|fever|temperature/i, "thermometer"],
  [/মাথা|চোখ|ঝাপসা|দৃষ্টি|vision|eye/i, "eye"],
  [/রক্ত|ফোঁটা|bleed|spot/i, "drop"],
  [/নড়াচড়া|শিশু|বাচ্চা|baby/i, "baby"],
  [/মন|দুশ্চিন্তা|ভয়|mood|anxiety/i, "mood_low"],
  [/শ্বাস|breath/i, "breath"],
  [/ক্লান্ত|দুর্বল|tired|fatigue/i, "energy"],
  [/ডাক্তার|চিকিৎসক|চেকআপ|doctor|check/i, "doctor"],
  [/ব্যথা|pain/i, "warning"],
];
export function guessIcon(text = "") {
  return GUESS.find(([re]) => re.test(text))?.[1] ?? "check";
}
