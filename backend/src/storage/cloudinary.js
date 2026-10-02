import { config, requireConfig } from "../config.js";
import { withRetry } from "../retry.js";

/** Unsigned upload of a base64 image to Cloudinary; returns the public HTTPS URL. */
export async function uploadImage({ base64, mime = "image/jpeg", publicId, folder }) {
  const { cloud, preset } = config.cloudinary;
  requireConfig(["CLOUDINARY_CLOUD_NAME", cloud], ["CLOUDINARY_UPLOAD_PRESET", preset]);
  return withRetry(
    async () => {
      const form = new FormData();
      form.append("file", `data:${mime};base64,${base64}`);
      form.append("upload_preset", preset);
      if (folder) form.append("folder", folder);
      if (publicId) form.append("public_id", publicId);
      const res = await fetch(`https://api.cloudinary.com/v1_1/${cloud}/image/upload`, { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(`Cloudinary upload failed: ${body?.error?.message ?? res.statusText}`), { status: res.status });
      return body.secure_url;
    },
    { label: `cloudinary ${publicId}` },
  );
}
