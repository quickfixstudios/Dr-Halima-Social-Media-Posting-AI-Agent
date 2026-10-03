import { COPY_RULES } from "../compliance.js";
import { approvedSources } from "./content.js";

/**
 * Medical-content safety layer for images.
 *
 * Principle: the picture may only SUPPORT the already-approved message. It never adds medical advice.
 *  1. The post must be approved before any image work starts.
 *  2. Copy is scanned for risky claims (English rules shared with the existing compliance engine + Bangla rules).
 *  3. Every word and every number drawn on the image must come from the approved post (or a fixed, neutral
 *     label such as "মিথ"/"সত্য"); anything else is flagged for a human.
 *  4. The person's titles may never be upgraded (e.g. calling a Medical Officer "বিশেষজ্ঞ"/specialist).
 */

// Neutral labels the templates add themselves. They carry no medical claim.
export const FIXED_LABELS = [
  "মিথ",
  "সত্য",
  "মিথ বনাম সত্য",
  "করণীয়",
  "বর্জনীয়",
  "সতর্কতা",
  "জেনে রাখুন",
  "চেকলিস্ট",
  "প্রতীকী ছবি",
  "পরের স্লাইডে দেখুন →",
  "পোস্টটি সেভ করে রাখুন",
  "অ্যাপয়েন্টমেন্টের জন্য যোগাযোগ করুন",
];

const BANGLA_RULES = [
  { id: "absolute_claim_bn", re: /(১০০\s*%|শতভাগ|নিশ্চিতভাবে\s*(সেরে|ভালো|আরোগ্য)|গ্যারান্টি|অলৌকিক|চিরতরে\s*(সেরে|মুক্তি)|কোনো\s*ঝুঁকি\s*নেই)/u },
  { id: "medication_instruction_bn", re: /(ওষুধ|ট্যাবলেট|ক্যাপসুল|ইনজেকশন)\s*(খান|খাবেন|নিন|শুরু\s*করুন|বন্ধ\s*করুন)/u },
  { id: "dosage_bn", re: /[০-৯0-9]+\s*(মিগ্রা|মিলিগ্রাম|এমজি|মিলি)/u },
  { id: "diagnosis_bn", re: /(আপনার\s*(নিশ্চয়ই|অবশ্যই)\s*.{0,20}(হয়েছে|আছে)|এর\s*মানে\s*আপনার\s*.{0,20}(হয়েছে|আছে))/u },
  { id: "fear_bn", re: /(মারা\s*যেতে\s*পারেন|প্রাণঘাতী|ভয়ংকর|মৃত্যু\s*নিশ্চিত)/u },
];

const VISUAL_RULE = /\b(blood|bloody|gore|graphic\s+(?:content|injur\w*|wounds?|violence|detail)|surgery|surgical|incision|nud(e|ity)|naked|topless|genital|anatomy|anatomical|speculum|needles?|syringes?|injection|pills?|tablets?|scalpel|fetus|foetus|ultrasound probe)\b/i;
const NEGATED = /\b(no|without|avoid|never|not)\s+[a-z-]+(\s+[a-z-]+){0,3}/gi;

const normalize = (s = "") =>
  s
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
const DIGITS_BN = "০১২৩৪৫৬৭৮৯";
const toLatinDigits = (s) => s.replace(/[০-৯]/g, (d) => String(DIGITS_BN.indexOf(d)));
const numbersIn = (s = "") => toLatinDigits(s).match(/\d+([.,]\d+)?/g) ?? [];

/** Scan approved copy (hook, caption, CTA, list items…) for risky medical claims. */
export function scanCopy(post, brand) {
  const text = [post.hook, post.subtitle, post.caption, post.cta, post.myth, post.fact, ...post.key_points].filter(Boolean).join("\n");
  const issues = [];
  for (const { id, re } of [...COPY_RULES, ...BANGLA_RULES]) {
    const m = text.match(re);
    if (m) issues.push({ rule: id, match: m[0], blocking: true });
  }
  // Titles may only be blocked when the sentence is about the person herself ("আমি… হিসেবে", her name, "as a…"),
  // so ordinary advice such as "একজন বিশেষজ্ঞ চিকিৎসকের পরামর্শ নিন" (see a specialist) stays allowed.
  const names = [brand.person?.display_name_bn, brand.person?.display_name_en, brand.brand_name].filter(Boolean).map((x) => x.toLowerCase());
  const selfRef = (sentence) => /আমি|আমার|হিসেবে|হিসাবে|\bas an?\b|\bi am\b|\bi'm\b/i.test(sentence) || names.some((n) => sentence.includes(n));
  const sentences = text.toLowerCase().split(/[।.!?\n]+/);
  for (const title of brand.person?.forbidden_titles ?? []) {
    const t = title?.toLowerCase();
    if (t && sentences.some((sen) => sen.includes(t) && selfRef(sen))) {
      issues.push({ rule: "title_upgrade", match: title, blocking: true, note: `"${title}" overstates ${brand.person.display_name_en || brand.brand_name}'s credentials (${brand.person.role_bn || "see brand file"}). Rephrase, e.g. "একজন চিকিৎসক হিসেবে".` });
    }
  }
  return issues;
}

/** Visual prompt must not ask for unsafe imagery (negated mentions like "no blood" are fine). */
export function scanVisualPrompt(prompt) {
  const m = prompt.replace(NEGATED, " ").match(VISUAL_RULE);
  return m ? [{ rule: "sensitive_visual", match: m[0], blocking: true }] : [];
}

/**
 * Check every text block drawn on the image against the approved content.
 * @param {{label:string,text:string,origin?:string}[]} blocks  origin: "content" | "brand" | "fixed" | "derived" | "human"
 */
export function checkOverlayText(blocks, post, brand) {
  const sources = approvedSources(post);
  const srcNorm = sources.map(normalize);
  const allNorm = srcNorm.join("|");
  const brandText = normalize([brand.brand_name, ...Object.values(brand.person ?? {}).filter((v) => typeof v === "string"), ...Object.values(brand.contact_details ?? {}), ...(brand.caption_signature ?? [])].join("|"));
  const sourceNumbers = new Set(sources.flatMap(numbersIn));
  const issues = [];
  for (const b of blocks) {
    if (!b.text) continue;
    if (b.origin === "fixed" && FIXED_LABELS.includes(b.text)) continue;
    if (b.origin === "brand" && brandText.includes(normalize(b.text))) continue;
    if (b.origin === "layout") continue; // slide counters, numbering
    const n = normalize(b.text);
    const found = n && allNorm.includes(n);
    if (!found) {
      issues.push({
        rule: b.origin === "human" ? "human_edited_text" : b.origin === "derived" ? "derived_text" : "unsourced_text",
        match: b.text,
        label: b.label,
        blocking: false,
        note:
          b.origin === "human"
            ? "Text was edited by a person — make sure it says nothing beyond the approved post."
            : "This text is not word-for-word in the approved post (it was shortened or rephrased). A human must confirm it adds no new medical claim.",
      });
    }
    for (const num of numbersIn(b.text)) {
      if (!sourceNumbers.has(num)) issues.push({ rule: "unsourced_number", match: num, label: b.label, blocking: true, note: "Numbers on images must appear in the approved content." });
    }
  }
  return issues;
}
