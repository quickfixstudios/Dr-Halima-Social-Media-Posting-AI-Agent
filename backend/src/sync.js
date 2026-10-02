import { DateTime } from "luxon";
import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { readContent, updateContent, appendPerformance } from "./storage/sheets.js";
import { instagramMetrics, facebookMetrics } from "./meta.js";
import { engagementScore } from "./learning.js";

const log = createLogger("sync");
export const SNAPSHOT_DAYS = [1, 3, 7];

/** Posts due for a snapshot today: published exactly 1, 3 or 7 days ago (Asia/Dhaka dates). */
export function dueForSnapshot(posts, now = DateTime.now().setZone(config.schedule.timezone)) {
  const today = now.startOf("day");
  return posts.filter((p) => {
    if (p.status !== "published" || !p.published_at) return false;
    const published = DateTime.fromISO(p.published_at).setZone(config.schedule.timezone).startOf("day");
    return SNAPSHOT_DAYS.includes(Math.round(today.diff(published, "days").days));
  });
}

export function combine(ig, fb) {
  const sum = (k) => (ig?.[k] ?? 0) + (fb?.[k] ?? 0);
  const totals = { likes: sum("likes"), comments: sum("comments"), shares: sum("shares"), saves: sum("saves"), reach: sum("reach") };
  return { ...totals, engagement_score: engagementScore(totals) };
}

/** Refresh engagement for due posts: Content metrics columns + Performance snapshot rows. */
export async function syncEngagement({ posts } = {}) {
  posts ??= await readContent();
  const due = dueForSnapshot(posts);
  const capturedAt = DateTime.now().setZone(config.schedule.timezone).toISO({ suppressMilliseconds: true });
  let updated = 0;
  for (const post of due) {
    try {
      const ig = post.ig_media_id ? await instagramMetrics(post.ig_media_id) : null;
      const fb = post.fb_post_id ? await facebookMetrics(post.fb_post_id) : null;
      const total = combine(ig, fb);
      await updateContent(post._row, { ...total, metrics_updated_at: capturedAt });
      const snap = (platform, m) => ({ post_id: post.id, captured_at: capturedAt, platform, ...m, engagement_score: engagementScore(m) });
      await appendPerformance([ig && snap("instagram", ig), fb && snap("facebook", fb), snap("total", total)].filter(Boolean));
      updated++;
    } catch (err) {
      log.error("Engagement sync failed for post", { postId: post.id, ...errorMeta(err) });
    }
  }
  log.info("Engagement sync done", { due: due.length, updated });
  return { due: due.length, updated };
}
