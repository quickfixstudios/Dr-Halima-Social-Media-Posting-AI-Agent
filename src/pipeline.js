import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { getAllPosts, getPostsByDate, recordRun, updatePost, upsertPosts } from "./db.js";
import { computeInsights, planPillars } from "./engagement.js";
import { generateContent } from "./generateContent.js";
import { generatePostImages } from "./generateImage.js";
import { schedulePosts } from "./schedulePosts.js";
import { DailyContentSchema } from "./schema.js";
import { checkPostSafety } from "./safety.js";
import { todayIn } from "./utils/time.js";

const log = createLogger("pipeline");

async function writeContentFile(date, posts) {
  await fs.mkdir(config.paths.content, { recursive: true });
  const strip = ({ id, date: _d, status, buffer_updates, metrics, score, images, media_urls, scheduled_at, safety_issues, last_error, ...rest }) => rest;
  await fs.writeFile(path.join(config.paths.content, `${date}.json`), JSON.stringify({ posts: posts.map(strip) }, null, 2));
}

async function renderImages(posts) {
  for (const post of posts) {
    if (post.images?.length) continue; // already rendered on a previous run
    try {
      const images = await generatePostImages(post);
      updatePost(post.id, { images, status: post.status === "generated" ? "images_ready" : post.status });
    } catch (err) {
      updatePost(post.id, { status: "image_failed", last_error: err.message });
    }
  }
}

/**
 * Full daily run: insights -> plan -> Claude content -> safety -> images -> store -> Buffer.
 * Idempotent per date: re-running resumes from whatever step failed.
 */
export async function runDaily({ date = todayIn(config.schedule.timezone), dryRun = false, skipImages = false } = {}) {
  const started = Date.now();
  log.info("Daily run started", { date, dryRun });
  try {
    let posts = getPostsByDate(date);

    if (!posts.length) {
      const history = getAllPosts().filter((p) => p.date !== date);
      const insights = computeInsights(history);
      const plan = { pillars: planPillars(insights) };
      log.info("Plan", { plan, winning: insights.winningTopics.length, losing: insights.losingTopics.length });

      const { posts: generated, flagged } = await generateContent({ date, plan, insights });
      posts = upsertPosts(date, generated);
      for (const [num, issues] of Object.entries(flagged)) {
        updatePost(`${date}-${num}`, { status: "needs_review", safety_issues: issues });
      }
      posts = getPostsByDate(date);
      await writeContentFile(date, posts);
    }

    if (!skipImages) await renderImages(posts.filter((p) => p.status !== "needs_review"));
    const results = await schedulePosts(date, getPostsByDate(date).filter((p) => p.status !== "image_failed"), { dryRun });

    recordRun({ date, ok: true, dryRun, results, ms: Date.now() - started });
    log.info("Daily run finished", { date, results });
    return results;
  } catch (err) {
    recordRun({ date, ok: false, error: err.message, ms: Date.now() - started });
    log.error("Daily run failed", { date, ...errorMeta(err) });
    throw err;
  }
}

/** Import a hand-written / pre-generated content file (e.g. content/2026-10-02.json) into the store. */
export async function importContent(file) {
  const date = path.basename(file, ".json");
  const parsed = DailyContentSchema.parse(JSON.parse(await fs.readFile(file, "utf8")));
  upsertPosts(date, parsed.posts);
  for (const post of parsed.posts) {
    const issues = checkPostSafety(post);
    if (issues.length) updatePost(`${date}-${post.post_number}`, { status: "needs_review", safety_issues: issues });
  }
  log.info("Imported content", { date, posts: parsed.posts.length });
  return date;
}
