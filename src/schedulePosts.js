import cron from "node-cron";
import { config } from "./config.js";
import { getPostsByDate, updatePost } from "./db.js";
import { postToBuffer } from "./buffer.js";
import { sendAlert } from "./alerts.js";
import { createLogger, errorMeta } from "./logger.js";
import { SLOTS, slotIndex } from "./schema.js";
import { slotToUtc, todayIn } from "./utils/time.js";

const log = createLogger("schedulePosts");

const SCHEDULABLE = new Set(["images_ready", "schedule_failed", "dry_run"]);

export function slotTime(slot, postTimes = config.schedule.postTimes) {
  const time = postTimes[slotIndex(slot)];
  if (!time) throw new Error(`No time configured for ${slot}`);
  return time;
}

/** Map posts onto their slots (slot1 → 10:00 … slot5 → 22:00, Asia/Dhaka by default). */
export function assignSlots(date, posts, { postTimes = config.schedule.postTimes, timezone = config.schedule.timezone } = {}) {
  return [...posts]
    .sort((a, b) => slotIndex(a.scheduled_slot) - slotIndex(b.scheduled_slot))
    .map((post) => {
      const time = slotTime(post.scheduled_slot, postTimes);
      return { post, time, scheduledAt: slotToUtc(date, time, timezone) };
    });
}

/** Send one post to Buffer, either queued for its slot or published immediately (`now`). */
export async function scheduleOne(post, scheduledAt, { dryRun = false, now = false } = {}) {
  const isReel = post.post_type === "reel";
  if (isReel && !post.video_url && config.buffer.reelsMode === "await_video") {
    log.info("Reel held until a video is attached", { postId: post.id });
    return updatePost(post.id, { status: "awaiting_video", scheduled_at: scheduledAt.toISOString() });
  }
  if (dryRun) {
    log.info("[dry-run] would schedule", { postId: post.id, scheduledAt: scheduledAt.toISOString(), images: post.image_urls?.length ?? 0 });
    return updatePost(post.id, { status: "dry_run", scheduled_at: scheduledAt.toISOString() });
  }
  const bufferUpdates = await postToBuffer(post, {
    scheduledAt,
    now,
    mediaUrls: post.image_urls ?? [],
    videoUrl: isReel ? post.video_url : undefined,
  });
  return updatePost(post.id, { status: "scheduled", scheduled_at: scheduledAt.toISOString(), buffer_updates: bufferUpdates });
}

/**
 * Morning pass: queue all of the day's posts on Buffer for their slots.
 * Flagged posts, already-scheduled posts and passed slots are skipped.
 */
export async function schedulePosts(date, posts, { dryRun = false, now = new Date() } = {}) {
  const results = [];
  for (const { post, time, scheduledAt } of assignSlots(date, posts)) {
    const result = { id: post.id, slot: post.scheduled_slot, time };
    if (!SCHEDULABLE.has(post.status)) {
      results.push({ ...result, status: post.status });
      continue;
    }
    if (scheduledAt <= now) {
      // The slot cron below will publish it immediately if it is still within its slot.
      results.push({ ...result, status: "slot_passed" });
      continue;
    }
    try {
      const saved = await scheduleOne(post, scheduledAt, { dryRun });
      results.push({ ...result, status: saved.status });
    } catch (err) {
      log.error("Failed to schedule post", { postId: post.id, ...errorMeta(err) });
      updatePost(post.id, { status: "schedule_failed", last_error: err.message });
      await sendAlert("Buffer scheduling failed", { post: post.id, slot: post.scheduled_slot, error: err.message });
      results.push({ ...result, status: "schedule_failed" });
    }
  }
  return results;
}

/**
 * Slot watchdog — runs at each slot time (10:00, 13:00, 16:00, 19:00, 22:00).
 * Guarantees 5 posts/day: if the slot's post never reached Buffer (late generation,
 * earlier failure, reel video attached late), publish it now; otherwise alert.
 */
export async function publishDueSlot(slot, { date = todayIn(config.schedule.timezone), now = new Date() } = {}) {
  const post = getPostsByDate(date).find((p) => p.scheduled_slot === slot);
  if (!post) return sendAlert("No post for slot", { date, slot });
  if (post.status === "scheduled" || post.status === "published") return log.info("Slot already covered", { postId: post.id, slot });
  if (!SCHEDULABLE.has(post.status) && !(post.status === "awaiting_video" && post.video_url)) {
    return sendAlert("Slot will be empty", { post: post.id, slot, status: post.status, error: post.last_error ?? "-" });
  }
  try {
    await scheduleOne(post, now, { now: true });
    log.info("Published at slot time", { postId: post.id, slot });
  } catch (err) {
    updatePost(post.id, { status: "schedule_failed", last_error: err.message });
    await sendAlert("Slot publish failed", { post: post.id, slot, error: err.message });
  }
}

/** Register one cron job per slot in the brand timezone. */
export function startSlotCrons({ postTimes = config.schedule.postTimes, timezone = config.schedule.timezone } = {}) {
  return SLOTS.map((slot, i) => {
    const [hour, minute] = postTimes[i].split(":").map(Number);
    // +2 minutes so Buffer's own scheduled send has a chance to go first.
    return cron.schedule(`${(minute + 2) % 60} ${minute + 2 >= 60 ? hour + 1 : hour} * * *`, () => publishDueSlot(slot), { timezone });
  });
}
