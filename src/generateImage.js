import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { config, requireEnv } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { withRetry } from "./utils/retry.js";
import { publishMedia } from "./mediaHost.js";

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
 * Generate one image with gpt-image-1 from a visual_prompt, save it locally and
 * publish it to the media host.
 * @returns {Promise<{ path: string, url: string }>}  local file + public image URL
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
  const url = await publishMedia(outPath);
  log.info("Image generated", { fileName, size, url, usage: response.usage });
  return { path: outPath, url };
}

/** Prompt for a text-on-design carousel slide, consistent with the cover's brand look. */
export function slidePrompt(slide) {
  return (
    `Instagram carousel slide, portrait 4:5, soft pastel women's-health brand, clean medical, soft lighting, minimal, modern. ` +
    `Render this text clearly and legibly in a clean rounded sans-serif, generous spacing:\n` +
    `Headline: """${slide.headline}"""\nBody: """${slide.body}"""\n` +
    `Design direction: ${slide.visual_direction}`
  );
}

/**
 * All visuals for a post: a cover for every post, plus (optionally) one image per
 * carousel slide after the cover.
 * @returns {Promise<{ images: string[], image_urls: string[] }>}
 */
export async function generatePostImages(post) {
  const results = [];
  try {
    results.push(await generateImage({ prompt: post.visual_prompt, postType: post.post_type, fileName: `${post.id}-cover.png` }));
    if (post.post_type === "carousel" && config.openai.carouselSlideImages) {
      for (const slide of post.carousel_slides.slice(1)) {
        results.push(await generateImage({ prompt: slidePrompt(slide), postType: "carousel", fileName: `${post.id}-slide${slide.slide_number}.png` }));
      }
    }
  } catch (err) {
    log.error("Image generation failed", { postId: post.id, ...errorMeta(err) });
    throw err;
  }
  return { images: results.map((r) => r.path), image_urls: results.map((r) => r.url) };
}
