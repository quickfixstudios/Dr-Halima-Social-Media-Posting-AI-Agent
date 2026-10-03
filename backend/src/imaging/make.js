import fs from "node:fs";
import path from "node:path";
import { withRetry } from "../retry.js";
import { uploadImage } from "../storage/cloudinary.js";
import { ImageError } from "./errors.js";

/**
 * Hand-off to Make.com. The image pipeline does not schedule or publish: once a person approves the image,
 * this sends one JSON "payload" to the business's Make webhook (a URL that starts a Make scenario when
 * something is POSTed to it). The Make scenario then posts it to Facebook. See IMAGE_AUTOMATION.md §Make.com.
 */

/** Final Facebook caption: approved caption + signature block + hashtags last (house style). */
export function assembleCaption(post, brand) {
  const parts = [post.caption.trim()];
  if (brand.caption_signature?.length) parts.push(brand.caption_signature.join("\n"));
  if (post.hashtags?.trim()) parts.push(post.hashtags.trim());
  return parts.join("\n\n");
}

/**
 * Facebook schedules natively when the post has a "Publish date" between 10 minutes and 30 days ahead.
 * Outside that window (or no time given) we send null → Make publishes immediately.
 */
export function publishAt(scheduledTime, now = Date.now()) {
  if (!scheduledTime) return null;
  const t = Date.parse(scheduledTime);
  if (Number.isNaN(t)) return null;
  const ahead = t - now;
  return ahead >= 10 * 60_000 && ahead <= 30 * 86_400_000 ? new Date(t).toISOString() : null;
}

/**
 * @param {object} p
 * @param {object} p.meta     metadata.json of the post
 * @param {object} p.brand
 * @param {{ url?: string, filename: string, base64?: string, mime: string }[]} p.images
 */
export function buildMakePayload({ meta, brand, images }) {
  const cand = meta.candidates.find((c) => c.id === meta.selected);
  const post = meta.content;
  return {
    post_id: meta.post_id,
    business: brand.id,
    platform: meta.platform,
    caption: assembleCaption(post, brand),
    image_url: images[0]?.url ?? null,
    image_urls: images.map((i) => i.url).filter(Boolean),
    images: images.map(({ filename, mime, base64, url }) => ({ filename, mime, ...(base64 ? { base64 } : {}), ...(url ? { url } : {}) })),
    image_count: images.length,
    // Ready-made value for Make's Facebook "Create a Post with Photos" → Photos field (URL mode only).
    facebook_photos: images.every((i) => i.url) ? images.map((i) => ({ type: "url", url: i.url })) : [],
    publish_at: publishAt(post.scheduled_time),
    content_type: post.content_type || cand.brief.visual_type,
    visual_type: cand.brief.visual_type,
    scheduled_time: post.scheduled_time || null,
    metadata: {
      topic: post.topic,
      hook: post.hook,
      headline: cand.brief.text.headline,
      cta: cand.brief.text.cta || "",
      model: cand.generations.at(-1)?.model ?? null,
      cost_usd: meta.cost?.total_usd ?? null,
      cost_unknown_images: meta.cost?.unknown ?? 0,
      approved_by: meta.approval?.by ?? null,
      approved_at: meta.approval?.at ?? null,
      brief_version: cand.brief.brief_version,
    },
  };
}

export function webhookUrl(brand, env = process.env) {
  const name = brand.make?.webhook_url_env;
  const url = (name && env[name]) || env.MAKE_WEBHOOK_URL;
  if (!url) throw new ImageError("MAKE_WEBHOOK_MISSING", `No Make.com webhook configured. Set ${name || "MAKE_WEBHOOK_URL"} in backend/.env (see IMAGE_AUTOMATION.md §Make.com).`);
  if (!/^https:\/\//.test(url)) throw new ImageError("MAKE_WEBHOOK_INVALID", "The Make webhook URL must start with https://");
  return url;
}

/**
 * Prepare the final image(s) for Make: public URLs (Cloudinary, when configured) or the image bytes inline (base64).
 * @param {"auto"|"url"|"base64"} mode
 */
export async function prepareImages({ files, postId, brand, mode = "auto", cloudinaryConfigured, upload = uploadImage }) {
  const useUrl = mode === "url" || (mode === "auto" && cloudinaryConfigured);
  if (!useUrl && files.length > 1) {
    throw new ImageError("CAROUSEL_NEEDS_URLS", `This post has ${files.length} images. Multi-image posts are sent to Make as links, so set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET (see IMAGE_AUTOMATION.md).`);
  }
  return Promise.all(
    files.map(async (abs, i) => {
      const buf = fs.readFileSync(abs);
      const filename = path.basename(abs);
      if (!useUrl) return { filename, mime: "image/jpeg", base64: buf.toString("base64") };
      const url = await upload({ base64: buf.toString("base64"), mime: "image/jpeg", publicId: `${postId}-${i + 1}-${Date.now()}`, folder: `${brand.asset_folder}/approved` });
      return { filename, mime: "image/jpeg", url };
    }),
  );
}

/** POST the payload to the Make webhook. Returns Make's response (a scenario may reply with { fb_post_id }). */
export async function sendToMake(payload, brand, { fetchImpl = fetch, env = process.env } = {}) {
  const url = webhookUrl(brand, env);
  return withRetry(
    async () => {
      const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`Make webhook answered HTTP ${res.status}: ${text.slice(0, 200)}`), { status: res.status });
      let body = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* Make's default reply is the plain text "Accepted" */
      }
      return { status: res.status, body };
    },
    { label: "make webhook" },
  );
}
