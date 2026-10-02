import { DateTime } from "luxon";
import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { alert } from "./alerts.js";
import { readContent, appendContent, appendLog, readTopicBank } from "./storage/sheets.js";
import { syncEngagement } from "./sync.js";
import { computeInsights, planDay, topicIdeas } from "./learning.js";
import { generateBatch, reviewCompliance } from "./openai/content.js";
import { generatePostImages } from "./openai/images.js";
import { decide } from "./compliance.js";
import { scheduledAt, todayLocal } from "./schedule.js";

const log = createLogger("pipeline");

/** Status a post lands in after compliance + images. */
export function initialStatus({ post, verdict }, { imageError } = {}) {
  if (verdict === "block" || verdict === "unreviewed" || imageError) return "needs_review";
  if (config.approvalRequired) return "needs_review";
  if (post.post_type === "reel" && config.reelsMode !== "cover_only") return "awaiting_video";
  return "ready";
}

/** Plan + generate + compliance (no side effects). Used by /v1/generate and the daily run. */
export async function buildBatch(date, existingPosts) {
  const posts = existingPosts.filter((p) => p.date !== date);
  const insights = computeInsights(posts);
  const plan = planDay(insights, { date });
  let bank = [];
  try {
    bank = await readTopicBank();
  } catch (err) {
    log.warn("Topic bank unavailable", errorMeta(err));
  }
  const { posts: generated, problems } = await generateBatch({ date, plan, insights, topicIdeas: topicIdeas(insights, plan, bank) });
  const review = await reviewCompliance(generated);
  const decisions = decide(generated, review);
  return { plan, insights, decisions, validationProblems: problems };
}

/**
 * Full daily run (Mode B): sync → learn → plan → generate → validate → comply → images → Sheets → alerts.
 * Idempotent per date unless `force`.
 */
export async function dailyRun({ date = todayLocal(), force = false, runId = `${date}-${DateTime.now().toFormat("HHmmss")}` } = {}) {
  log.info("Daily run started", { date, runId });
  try {
    let existing = await readContent();
    if (!force && existing.some((p) => p.date === date)) {
      log.info("Batch already exists, skipping", { date });
      return { status: "skipped", reason: "batch exists", date };
    }

    try {
      const s = await syncEngagement({ posts: existing });
      if (s.updated) existing = await readContent();
    } catch (err) {
      await alert("Engagement sync failed (generation continues)", { error: err.message }, "info");
    }

    const { plan, decisions, validationProblems } = await buildBatch(date, existing);

    const rows = [];
    for (const d of decisions) {
      let imageUrls = [];
      let imageError;
      if (d.verdict !== "block") {
        try {
          imageUrls = await generatePostImages(d.post, date);
        } catch (err) {
          imageError = err.message;
          await alert("Image generation failed", { post: d.post.id, error: err.message });
        }
      }
      const notes = [...d.issues, ...validationProblems.filter((p) => p.startsWith(d.post.scheduled_slot))];
      rows.push({
        ...d.post,
        date,
        scheduled_at: scheduledAt(date, d.post.scheduled_slot),
        image_urls: imageUrls,
        status: initialStatus(d, { imageError }),
        compliance_status: d.verdict,
        compliance_notes: notes.join("; "),
        retry_count: 0,
        last_error: imageError ?? "",
        run_id: runId,
      });
    }
    await appendContent(rows);
    await appendLog({ module: "dailyRun", message: `batch ${runId} stored: ${rows.map((r) => `${r.scheduled_slot}=${r.status}`).join(", ")}` }).catch(() => {});

    const held = rows.filter((r) => r.status === "needs_review");
    const reels = rows.filter((r) => r.status === "awaiting_video");
    if (held.length) await alert("Posts held for review", { posts: held.map((r) => `${r.id}: ${r.compliance_notes || r.last_error || "approval required"}`) });
    if (reels.length) await alert("Reels need a video", { reels: reels.map((r) => `${r.id} (${r.scheduled_at})`) }, "info");

    log.info("Daily run finished", { date, runId, plan: plan.map((p) => `${p.scheduled_slot}:${p.post_type}:${p.content_pillar}`) });
    return { status: "done", date, runId, posts: rows.map((r) => ({ id: r.id, slot: r.scheduled_slot, type: r.post_type, status: r.status })) };
  } catch (err) {
    log.error("Daily run failed", { date, runId, ...errorMeta(err) });
    await alert("Daily run failed", { date, runId, error: err.message });
    throw err;
  }
}
