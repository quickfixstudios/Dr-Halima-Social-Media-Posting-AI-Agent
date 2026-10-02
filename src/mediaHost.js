import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { withRetry } from "./utils/retry.js";

const log = createLogger("mediaHost");

/**
 * Buffer only accepts media by public URL. Upload a local file and return its URL.
 * - cloudinary: unsigned upload preset (https://cloudinary.com/documentation/upload_images#unsigned_upload)
 * - static: you sync data/media to a CDN/bucket served at PUBLIC_MEDIA_BASE_URL
 */
export async function publishMedia(filePath) {
  const { host, cloudinaryCloud, cloudinaryPreset, publicBaseUrl } = config.media;

  if (host === "static") {
    if (!publicBaseUrl) throw new Error("PUBLIC_MEDIA_BASE_URL is required when MEDIA_HOST=static");
    return `${publicBaseUrl.replace(/\/$/, "")}/${path.basename(filePath)}`;
  }

  if (!cloudinaryCloud || !cloudinaryPreset) {
    throw new Error("CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET are required when MEDIA_HOST=cloudinary");
  }
  const data = await fs.readFile(filePath);
  const form = new FormData();
  form.append("file", new Blob([data], { type: "image/png" }), path.basename(filePath));
  form.append("upload_preset", cloudinaryPreset);
  form.append("folder", "dr-halima");

  const json = await withRetry(
    async () => {
      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryCloud}/image/upload`, { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw Object.assign(new Error(`Cloudinary upload failed: ${body?.error?.message ?? res.statusText}`), { status: res.status });
      return body;
    },
    { label: `cloudinary ${path.basename(filePath)}` },
  );
  log.info("Media uploaded", { file: path.basename(filePath), url: json.secure_url });
  return json.secure_url;
}
