import { openai } from "../openai/client.js";
import { withRetry, isTransient } from "../retry.js";
import { imagingConfig } from "../config.js";

/**
 * Bangla spelling check for images where the AI drew the text itself (text mode "model").
 *
 * A vision model transcribes every visible word exactly as drawn (told NOT to fix spelling); each line we
 * asked for is then compared with the transcription letter by letter. Lines that are missing or misspelled
 * are listed for the reviewer, and the pipeline may regenerate the image. This narrows down, but never
 * replaces, the human proofread: a reader model can also misread a letter.
 */

const INSTRUCTIONS = `You are a strict Bengali proofreader checking a social-media image.
Transcribe EVERY piece of text visible in the image, top to bottom, left to right, one visual line per array item,
exactly as it is drawn — character by character. NEVER correct spelling: if a letter, vowel sign (kar), conjunct,
hasanta or chandrabindu is malformed, missing, extra or wrong, transcribe what is actually drawn. If a word is
unreadable or not real Bengali, write it as best you can and add it to "garbled".`;

const FORMAT = {
  type: "json_schema",
  name: "image_text",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["lines", "garbled"],
    properties: {
      lines: { type: "array", items: { type: "string" } },
      garbled: { type: "array", items: { type: "string" } },
    },
  },
};

const ZERO_WIDTH = /[​-‍﻿]/g;
/** NFC (also unifies precomposed য়/ড়/ঢ়), no zero-width joiners, single spaces, no edge punctuation. */
export const normalize = (s) =>
  (s ?? "")
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(/[•·✓✕✔✖→—–\-:।,!?"'“”‘’()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const chars = (s) => [...s];

function levenshtein(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

/** 0–1 similarity of `expected` with the closest stretch of `text` (exact containment = 1). */
export function bestSimilarity(expected, text) {
  const e = chars(normalize(expected));
  const t = chars(normalize(text));
  if (!e.length) return 1;
  if (normalize(text).includes(normalize(expected))) return 1;
  let best = 0;
  for (const len of [e.length - 1, e.length, e.length + 1]) {
    if (len < 1) continue;
    for (let start = 0; start + len <= Math.max(t.length, len); start++) {
      const d = levenshtein(e, t.slice(start, start + len));
      best = Math.max(best, 1 - d / Math.max(e.length, len));
      if (best === 1) return 1;
    }
  }
  return Math.round(best * 1000) / 1000;
}

/**
 * Compare the lines we asked for with what the reader saw.
 * @param {{role: string, text: string}[]} expected
 * @param {{lines: string[], garbled: string[]}} reading
 * @param {number} threshold  similarity a line needs to count as correct (1 = identical)
 */
export function compareText(expected, reading, threshold = 0.97) {
  const full = reading.lines.join("\n");
  const lines = expected.map((x) => {
    const similarity = Math.max(bestSimilarity(x.text, full), ...reading.lines.map((l) => bestSimilarity(x.text, l)));
    return { ...x, similarity, ok: similarity >= threshold };
  });
  const wrong = lines.filter((l) => !l.ok);
  const score = lines.length ? Math.round((lines.reduce((a, l) => a + l.similarity, 0) / lines.length) * 1000) / 1000 : 1;
  return { ok: wrong.length === 0 && !reading.garbled.length, score, lines, wrong, garbled: reading.garbled, transcript: reading.lines };
}

/** Ask the vision model to transcribe the image's text. Returns { lines, garbled }. */
export async function readImageText(buffer, { mime = "image/png", model = imagingConfig().textModel, client = openai, retries = 3, sleep } = {}) {
  return withRetry(
    async () => {
      const response = await client().responses.create({
        model,
        instructions: INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_image", image_url: `data:${mime};base64,${buffer.toString("base64")}`, detail: "high" }] }],
        text: { format: FORMAT },
        max_output_tokens: 4000,
        store: false,
      });
      const text = response.output_text;
      if (!text) throw new Error("text check: empty answer from the reader model");
      const json = JSON.parse(text);
      return { lines: json.lines ?? [], garbled: json.garbled ?? [] };
    },
    { label: "text check", attempts: retries, shouldRetry: isTransient, ...(sleep && { sleep }) },
  );
}

/** Read the image and compare it with the requested lines. */
export async function checkImageText(buffer, expected, opts = {}) {
  const reading = await readImageText(buffer, opts);
  return compareText(expected, reading, opts.threshold);
}
