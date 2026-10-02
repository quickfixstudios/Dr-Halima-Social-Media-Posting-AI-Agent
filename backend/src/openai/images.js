import { config } from "../config.js";
import { createLogger } from "../logger.js";
import { withRetry } from "../retry.js";
import { openai, OpenAI } from "./client.js";
import { uploadImage } from "../storage/cloudinary.js";

const log = createLogger("images");

const SIZE = { reel: "1024x1536", carousel: "1024x1536", image: "1024x1024" };
const STYLE_GUARD =
  "Style guard: clean medical aesthetic, soft natural lighting, minimal, modern, female-focused, diverse women modestly and fully dressed. " +
  "Strictly no text, no anatomy, no blood, no medical instruments, no nudity, no logos, no watermarks.";

const isModelUnavailable = (err) => (err instanceof OpenAI.NotFoundError || err instanceof OpenAI.BadRequestError) && /model/i.test(err.message);

async function render(model, prompt, size) {
  return withRetry(
    () =>
      openai().images.generate({ model, prompt, size, quality: config.openai.imageQuality, output_format: "jpeg", output_compression: 85, n: 1 }),
    { label: `image ${model}`, shouldRetry: (err) => !(err instanceof OpenAI.BadRequestError || err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.NotFoundError) },
  );
}

/**
 * visual_prompt → gpt-image (auto-fallback when the primary model is retired) → Cloudinary → public URL.
 * @returns {Promise<{ url: string, model: string }>}
 */
export async function generateImage({ prompt, postType, publicId, folder, withStyleGuard = true }) {
  const fullPrompt = withStyleGuard ? `${prompt}\n\n${STYLE_GUARD}` : prompt;
  const size = SIZE[postType] ?? "1024x1024";
  let model = config.openai.imageModel;
  let res;
  try {
    res = await render(model, fullPrompt, size);
  } catch (err) {
    if (!isModelUnavailable(err) || !config.openai.imageModelFallback) throw err;
    log.warn("Primary image model unavailable, using fallback", { from: model, to: config.openai.imageModelFallback, error: err.message });
    model = config.openai.imageModelFallback;
    res = await render(model, fullPrompt, size);
  }
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error(`No image returned for ${publicId}`);
  const url = await uploadImage({ base64: b64, mime: "image/jpeg", publicId, folder });
  log.info("Image ready", { publicId, model, size, url });
  return { url, model };
}

export function slidePrompt(slide) {
  return (
    `Instagram carousel slide, portrait 4:5, soft pastel women's-health brand: clean medical, soft lighting, minimal, modern. ` +
    `Render this text exactly, clearly and legibly in a clean rounded sans-serif with generous spacing.\n` +
    `Headline: """${slide.headline}"""\nBody: """${slide.body}"""\nDesign: ${slide.visual_direction}\n` +
    `No photos of anatomy, no medical instruments, no logos.`
  );
}

/** All images for a post: cover (+ one per extra carousel slide when CAROUSEL_SLIDE_IMAGES=true). */
export async function generatePostImages(post, date) {
  const folder = `dr-halima/${date}`;
  const urls = [(await generateImage({ prompt: post.visual_prompt, postType: post.post_type, publicId: `${post.id}-cover`, folder })).url];
  if (post.post_type === "carousel" && config.openai.carouselSlideImages) {
    for (const slide of post.carousel_slides.slice(1)) {
      urls.push((await generateImage({ prompt: slidePrompt(slide), postType: "carousel", publicId: `${post.id}-s${slide.slide_number}`, folder, withStyleGuard: false })).url);
    }
  }
  return urls;
}
