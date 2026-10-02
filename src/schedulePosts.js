import { config } from "./config.js";
import { updatePost } from "./db.js";
import { postToBuffer } from "./buffer.js";
import { publishMedia } from "./mediaHost.js";
import { createLogger, errorMeta } from "./logger.js";
import { slotToUtc } from "./utils/time.js";

const log = createLogger("schedulePosts");

/** Map posts (ordered by post_number) onto the daily slots: 10:00, 13:00, 16:00, 19:00, 22:00. */
export function assignSlots(date, posts, { postTimes = config.schedule.postTimes, timezone = config.schedule.timezone } = {}) {
  // Slot is keyed by post_number (not array index) so a skipped post never shifts the others.
  return [...posts]
    .sort((a, b) => a.post_number - b.post_number)
    .map((post) => {
      const slot = postTimes[post.post_number - 1];
      if (!slot) throw new Error(`No time slot configured for post ${post.post_number}`);
      return { post, slot, scheduledAt: slotToUtc(date, slot, timezone) };
    });
}

/** Schedule a single post on Buffer (uploads media first). */
export async function scheduleOne(post, scheduledAt, { dryRun = false } = {}) {
  const isReel = post.post_type === "reel";
  if (isReel && !post.video_url && config.buffer.reelsMode === "await_video") {
    log.info("Reel held until a video is attached", { postId: post.id });
    return updatePost(post.id, { status: "awaiting_video", scheduled_at: scheduledAt.toISOString() });
  }
  if (dryRun) {
    log.info("[dry-run] would schedule", { postId: post.id, scheduledAt: scheduledAt.toISOString(), images: post.images?.length ?? 0 });
    return updatePost(post.id, { status: "dry_run", scheduled_at: scheduledAt.toISOString() });
  }

  const mediaUrls = post.media_urls?.length ? post.media_urls : [];
  if (!mediaUrls.length) for (const file of post.images ?? []) mediaUrls.push(await publishMedia(file));

  const bufferUpdates = await postToBuffer(post, { scheduledAt, mediaUrls, videoUrl: isReel ? post.video_url : undefined });
  return updatePost(post.id, {
    status: "scheduled",
    scheduled_at: scheduledAt.toISOString(),
    media_urls: mediaUrls,
    buffer_updates: bufferUpdates,
  });
}

/**
 * Schedule the day's posts. Posts flagged by the safety review, or whose slot has
 * already passed, are not sent to Buffer.
 */
export async function schedulePosts(date, posts, { dryRun = false, now = new Date() } = {}) {
  const results = [];
  for (const { post, slot, scheduledAt } of assignSlots(date, posts)) {
    if (post.status === "needs_review") {
      log.warn("Skipping post that needs human review", { postId: post.id, issues: post.safety_issues });
      results.push({ id: post.id, slot, status: post.status });
      continue;
    }
    if (post.status === "scheduled") {
      results.push({ id: post.id, slot, status: "scheduled" }); // idempotent re-runs
      continue;
    }
    if (scheduledAt <= now) {
      log.warn("Slot already passed, skipping", { postId: post.id, slot });
      updatePost(post.id, { status: "missed_slot" });
      results.push({ id: post.id, slot, status: "missed_slot" });
      continue;
    }
    try {
      const saved = await scheduleOne(post, scheduledAt, { dryRun });
      results.push({ id: post.id, slot, status: saved.status });
    } catch (err) {
      log.error("Failed to schedule post", { postId: post.id, ...errorMeta(err) });
      updatePost(post.id, { status: "schedule_failed", last_error: err.message });
      results.push({ id: post.id, slot, status: "schedule_failed" });
    }
  }
  return results;
}
