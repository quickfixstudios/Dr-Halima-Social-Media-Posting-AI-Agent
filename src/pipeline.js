import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { getAllPosts, getPerformance, getPostsByDate, recordRun, updatePost, upsertPosts } from "./db.js";
import { computeInsights, planDay, topicSuggestions } from "./engagement.js";
import { generateContent } from "./generateContent.js";
import { generatePostImages } from "./generateImage.js";
import { schedulePosts } from "./schedulePosts.js";
import { DailyBatchSchema, PostSchema } from "./schema.js";
import { checkPostSafety } from "./safety.js";
import { sendAlert } from "./alerts.js";
import { todayIn } from "./utils/time.js";

const log = createLogger("pipeline");
const BATCH_FIELDS = Object.keys(PostSchema.shape);

/** Strip storage-only fields so content/<date>.json stays in the daily_batch format. */
export function toBatchItem(post) {
  return Object.fromEntries(BATCH_FIELDS.map((k) => [k, post[k]]));
}

async function writeBatchFile(date, posts) {
  await fs.mkdir(config.paths.content, { recursive: true });
  await fs.writeFile(path.join(config.paths.content, `${date}.json`), JSON.stringify({ daily_batch: posts.map(toBatchItem) }, null, 2));
}

async function flagForReview(posts) {
  for (const post of posts) {
    const issues = checkPostSafety(post);
    if (!issues.length) continue;
    updatePost(post.id, { status: "needs_review", safety_issues: issues });
    await sendAlert("Post held for medical-compliance review", { post: post.id, issues });
  }
}

async function renderImages(posts) {
  for (const post of posts) {
    if (post.image_urls?.length) {
      if (post.status === "generated") updatePost(post.id, { status: "images_ready" });
      continue; // already rendered on a previous run
    }
    try {
      const { images, image_urls } = await generatePostImages(post);
      updatePost(post.id, { images, image_urls, status: "images_ready" });
    } catch (err) {
      updatePost(post.id, { status: "image_failed", last_error: err.message });
      await sendAlert("Image generation failed", { post: post.id, error: err.message });
    }
  }
}

/**
 * Full daily run: insights → slot plan → Claude batch → compliance → images → store → Buffer.
 * Idempotent per date: re-running resumes from whatever step failed.
 */
export async function runDaily({ date = todayIn(config.schedule.timezone), dryRun = false, skipImages = false } = {}) {
  const started = Date.now();
  log.info("Daily run started", { date, dryRun });
  try {
    if (!getPostsByDate(date).length) {
      const insights = computeInsights(getAllPosts().filter((p) => p.date !== date), getPerformance());
      const plan = planDay(insights, { date });
      const { posts } = await generateContent({ date, plan, insights, topicSuggestions: topicSuggestions(insights, plan) });
      upsertPosts(date, posts);
      await flagForReview(posts);
      await writeBatchFile(date, posts);
    }

    const posts = getPostsByDate(date);
    if (skipImages) {
      for (const p of posts) if (p.status === "generated") updatePost(p.id, { status: "images_ready" });
    } else {
      await renderImages(posts.filter((p) => p.status === "generated" || p.status === "image_failed"));
    }
    const results = await schedulePosts(date, getPostsByDate(date), { dryRun });

    recordRun({ date, ok: true, dryRun, results, ms: Date.now() - started });
    log.info("Daily run finished", { date, results });
    return results;
  } catch (err) {
    recordRun({ date, ok: false, error: err.message, ms: Date.now() - started });
    log.error("Daily run failed", { date, ...errorMeta(err) });
    await sendAlert("Daily run failed", { date, error: err.message });
    throw err;
  }
}

/** Import a pre-written batch file (e.g. content/2026-10-02.json) into the store. */
export async function importContent(file) {
  const date = path.basename(file, ".json");
  const { daily_batch } = DailyBatchSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  upsertPosts(date, daily_batch);
  await flagForReview(daily_batch);
  log.info("Imported batch", { date, posts: daily_batch.length });
  return date;
}
