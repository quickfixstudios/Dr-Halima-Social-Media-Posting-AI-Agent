import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { ImageError } from "./errors.js";

/**
 * File layout (never overwrites an existing file):
 *
 *   assets/<brand asset_folder>/<YYYY>/<MM>/<post-id>/
 *     source/      approved real photos copied in for this post (e.g. the doctor's portrait)
 *     generated/   raw pictures exactly as the AI returned them   (gen-001.png, gen-002.png …)
 *     final/       finished images with Bangla text                (final-001.jpg, final-002-slide-2.jpg …)
 *     metadata.json   everything about the post: content, briefs, prompts, costs, review history
 *   assets/<brand asset_folder>/index.json   post-id → folder
 *   assets/_ledger.jsonl                     one line per image-model call (cost + usage)
 */
export class AssetStore {
  constructor(assetsDir, brand, { timezone = "Asia/Dhaka" } = {}) {
    this.root = path.join(assetsDir, brand.asset_folder);
    this.indexFile = path.join(this.root, "index.json");
    this.timezone = timezone;
  }

  index() {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, "utf8"));
    } catch {
      return {};
    }
  }

  dirFor(postId, { create = false } = {}) {
    const idx = this.index();
    if (idx[postId]) return path.join(this.root, idx[postId]);
    if (!create) throw new ImageError("POST_NOT_FOUND", `No image job for post "${postId}" yet. Create one with: npm run image -- --post ${postId}`);
    const now = DateTime.now().setZone(this.timezone);
    const rel = path.join(now.toFormat("yyyy"), now.toFormat("LL"), postId);
    for (const sub of ["source", "generated", "final"]) fs.mkdirSync(path.join(this.root, rel, sub), { recursive: true });
    this.#writeJson(this.indexFile, { ...idx, [postId]: rel });
    return path.join(this.root, rel);
  }

  exists(postId) {
    return Boolean(this.index()[postId]);
  }

  load(postId) {
    const file = path.join(this.dirFor(postId), "metadata.json");
    if (!fs.existsSync(file)) throw new ImageError("POST_NOT_FOUND", `metadata.json missing for ${postId}`);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  save(meta) {
    meta.updated_at = new Date().toISOString();
    this.#writeJson(path.join(this.dirFor(meta.post_id, { create: true }), "metadata.json"), meta);
    return meta;
  }

  /** Write a new file in <sub>/ with the next free number: <prefix>-001<suffix>.<ext>. Returns the path relative to the post folder. */
  writeNew(postId, sub, prefix, ext, buffer, suffix = "") {
    const dir = path.join(this.dirFor(postId, { create: true }), sub);
    fs.mkdirSync(dir, { recursive: true });
    const taken = fs.readdirSync(dir).filter((f) => f.startsWith(`${prefix}-`)).map((f) => Number(f.slice(prefix.length + 1, prefix.length + 4)) || 0);
    const n = String((taken.length ? Math.max(...taken) : 0) + 1).padStart(3, "0");
    const name = `${prefix}-${n}${suffix}.${ext}`;
    fs.writeFileSync(path.join(dir, name), buffer, { flag: "wx" }); // wx = fail instead of overwrite
    return path.join(sub, name);
  }

  /** Write several files that share one number (carousel slides). */
  writeSeries(postId, sub, prefix, ext, buffers) {
    const first = this.writeNew(postId, sub, prefix, ext, buffers[0], buffers.length > 1 ? "-slide-1" : "");
    const base = first.replace(/-slide-1\.\w+$/, "");
    const rest = buffers.slice(1).map((buf, i) => {
      const rel = `${base}-slide-${i + 2}.${ext}`;
      fs.writeFileSync(path.join(this.dirFor(postId), rel), buf, { flag: "wx" });
      return rel;
    });
    return [first, ...rest];
  }

  absolute(postId, rel) {
    const dir = this.dirFor(postId);
    const abs = path.resolve(dir, rel);
    if (!abs.startsWith(dir + path.sep)) throw new ImageError("INVALID_ASSET", `Asset path escapes the post folder: ${rel}`);
    if (!fs.existsSync(abs)) throw new ImageError("INVALID_ASSET", `Asset file missing: ${rel}`);
    return abs;
  }

  list() {
    return Object.keys(this.index())
      .map((id) => {
        try {
          return this.load(id);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  #writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, file); // atomic: a crash never leaves a half-written metadata.json
  }
}
