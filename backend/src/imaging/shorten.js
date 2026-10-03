import { structuredCall } from "../openai/content.js";
import { graphemeCount } from "./overlay/text.js";
import { ImageError } from "./errors.js";

/**
 * Optional (IMAGE_TEXT_SHORTEN_WITH_LLM=true): ask the text model to shorten a Bangla line that does not fit.
 * The result is marked "derived" so the review screen shows it and a person must confirm it — the model is
 * told to keep the meaning and add nothing, but a human stays responsible for medical wording.
 */
const FORMAT = {
  type: "json_schema",
  name: "shortened_text",
  strict: true,
  schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
};

export async function shortenText(text, maxGraphemes, { call = structuredCall } = {}) {
  const { json } = await call({
    label: "shorten overlay text",
    instructions:
      "You shorten Bangla social-media text for an image. Keep the exact meaning and tone. Do not add any new information, number, claim, advice or promise. " +
      "Remove words rather than rephrase. Keep English medical terms (e.g. PCOS) as they are. Return only the shortened text.",
    input: [{ role: "user", content: `Shorten to at most ${maxGraphemes} visible characters:\n${text}` }],
    format: FORMAT,
    maxOutputTokens: 400,
  });
  const out = String(json.text ?? "").trim();
  if (!out || graphemeCount(out) > maxGraphemes * 1.1) throw new ImageError("TEXT_TOO_LONG", `Could not shorten "${text}" enough`);
  return out;
}
