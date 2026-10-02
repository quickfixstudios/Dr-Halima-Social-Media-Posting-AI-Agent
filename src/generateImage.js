import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { config, requireEnv } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { withRetry } from "./utils/retry.js";

const log = createLogger("generateImage");

// gpt-image-1 supports 1024x1024, 1024x1536 (portrait) and 1536x1024.
const SIZE_BY_TYPE = { reel: "1024x1536", carousel: "1024x1536", image: "1024x1024" };

const STYLE_GUARD =
  "Style: clean medical-education aesthetic, soft pastel colours, modern minimal, respectful fully clothed women. " +
  "Strictly avoid: explicit or clinical imagery, anatomy, blood, needles, nudity, logos, watermarks.";

let client;
function getClient() {
  requireEnv("OPENAI_API_KEY");
  client ??= new OpenAI({ maxRetries: 2, timeout: 180_000 });
  return client;
}

/**
 * Generate one image with gpt-image-1 and save it as PNG.
 * @returns {Promise<string>} absolute path of the saved file
 */
export async function generateImage({ prompt, postType = "image", fileName }) {
  const size = SIZE_BY_TYPE[postType] ?? "1024x1024";
  const outPath = path.join(config.paths.media, fileName);

  const response = await withRetry(
    () =>
      getClient().images.generate({
        model: config.openai.imageModel,
        prompt: `${prompt}\n\n${STYLE_GUARD}`,
        size,
        quality: config.openai.quality,
        n: 1,
      }),
    {
      label: `gpt-image-1 ${fileName}`,
      // Content-policy rejections and bad requests will not succeed on retry.
      shouldRetry: (err) => !(err instanceof OpenAI.BadRequestError || err instanceof OpenAI.AuthenticationError),
    },
  );

  const b64 = response.data?.[0]?.b64_json;
  if (!b64) throw new Error(`No image returned for ${fileName}`);
  await fs.mkdir(config.paths.media, { recursive: true });
  await fs.writeFile(outPath, Buffer.from(b64, "base64"));
  log.info("Image saved", { fileName, size, usage: response.usage });
  return outPath;
}

/** Split "Slide N ..." carousel text into per-slide strings. */
export function splitSlides(text) {
  return text
    .split(/\n(?=Slide \d)/)
    .map((s) => s.trim())
    .filter((s) => /^Slide \d/.test(s));
}

/**
 * Generate all visuals for a post: a cover for every post, plus (optionally) one
 * text-on-design image per carousel slide 2–5.
 */
export async function generatePostImages(post) {
  const base = post.id;
  const images = [];
  try {
    images.push(await generateImage({ prompt: post.visual_prompt, postType: post.post_type, fileName: `${base}-cover.png` }));

    if (post.post_type === "carousel" && config.openai.carouselSlideImages) {
      const slides = splitSlides(post.script_or_slide_content).slice(1);
      for (const [i, slide] of slides.entries()) {
        const prompt =
          `Instagram carousel slide, 1080x1350 portrait, matching a soft pastel women's-health brand. ` +
          `Render this text clearly and legibly in a clean sans-serif, well spaced, with a small minimal icon:\n"""${slide}"""`;
        images.push(await generateImage({ prompt, postType: "carousel", fileName: `${base}-slide${i + 2}.png` }));
      }
    }
  } catch (err) {
    log.error("Image generation failed", { postId: post.id, ...errorMeta(err) });
    throw err;
  }
  return images;
}
