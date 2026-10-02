import { DateTime } from "luxon";
import { getAllPosts, updatePost } from "./db.js";
import { getUpdateStats } from "./buffer.js";
import { PILLARS } from "./schema.js";
import { createLogger, errorMeta } from "./logger.js";

const log = createLogger("engagement");

const WEIGHTS = { likes: 1, comments: 3, shares: 4, saves: 4, clicks: 0.5 };
const SMOOTHING_K = 3; // Bayesian prior strength: pulls small samples toward average (1.0)
const WIN_THRESHOLD = 1.3; // >= 30% above median = high performer
const LOSE_THRESHOLD = 0.6; // <= 40% below median = low performer

/** Weighted engagement; per-1000-reach when reach is known so big days don't dominate. */
export function engagementScore(m) {
  const weighted = Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + (m[k] ?? 0) * w, 0);
  return m.reach > 0 ? +(weighted / m.reach * 1000).toFixed(2) : weighted;
}

function sumMetrics(list) {
  const total = { likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, reach: 0 };
  for (const m of list) for (const k of Object.keys(total)) total[k] += m[k] ?? 0;
  return total;
}

/**
 * Pull stats from Buffer for posts published 1–14 days ago and store metrics + score.
 */
export async function syncEngagement({ now = DateTime.utc() } = {}) {
  const candidates = getAllPosts().filter((p) => {
    if (!p.scheduled_at || !p.buffer_updates?.length) return false;
    const age = now.diff(DateTime.fromISO(p.scheduled_at), "days").days;
    return age >= 1 && age <= 14;
  });
  log.info("Syncing engagement", { posts: candidates.length });

  for (const post of candidates) {
    try {
      const stats = [];
      for (const { update_id } of post.buffer_updates) stats.push(await getUpdateStats(update_id));
      const metrics = { ...sumMetrics(stats), updated_at: now.toISO() };
      const sent = stats.some((s) => s.status === "sent");
      updatePost(post.id, { metrics, score: engagementScore(metrics), status: sent ? "published" : post.status });
    } catch (err) {
      log.error("Failed to sync post", { postId: post.id, ...errorMeta(err) });
    }
  }
}

function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function groupPerformance(scored, key) {
  const groups = {};
  for (const p of scored) (groups[p[key]] ??= []).push(p.perf);
  return Object.entries(groups)
    .map(([k, perfs]) => ({
      key: k,
      n: perfs.length,
      score: +((perfs.reduce((a, b) => a + b, 0) + SMOOTHING_K) / (perfs.length + SMOOTHING_K)).toFixed(2),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Turn stored history into guidance for the next generation run.
 * Pure function of the post list -> easy to test and reason about.
 */
export function computeInsights(posts, { now = DateTime.utc(), topicWindowDays = 45, hookWindowDays = 21 } = {}) {
  const daysAgo = (p) => now.diff(DateTime.fromISO(p.date, { zone: "utc" }), "days").days;

  const scored = posts.filter((p) => typeof p.score === "number").map((p) => ({ ...p }));
  const med = median(scored.map((p) => p.score)) || 1;
  for (const p of scored) p.perf = +(p.score / med).toFixed(2);

  const byPerf = [...scored].sort((a, b) => b.perf - a.perf);
  const toTopic = (p) => ({ pillar: p.content_pillar, topic: p.topic, score: p.perf });

  return {
    winningTopics: byPerf.filter((p) => p.perf >= WIN_THRESHOLD).slice(0, 6).map(toTopic),
    losingTopics: byPerf.filter((p) => p.perf <= LOSE_THRESHOLD).slice(-6).map(toTopic),
    pillarPerformance: groupPerformance(scored, "content_pillar"),
    bestFormats: groupPerformance(scored, "post_type"),
    hookStylePerformance: groupPerformance(scored, "hook_style"),
    recentTopics: posts.filter((p) => daysAgo(p) <= topicWindowDays).map((p) => p.topic),
    recentHooks: posts.filter((p) => daysAgo(p) <= hookWindowDays).map((p) => p.hook_english),
    lastUsedPillar: Object.fromEntries(
      PILLARS.map((pillar) => {
        const used = posts.filter((p) => p.content_pillar === pillar).map(daysAgo);
        return [pillar, used.length ? Math.min(...used) : Infinity];
      }),
    ),
  };
}

/**
 * Choose today's 5 pillars: exploit what performs (smoothed score) while
 * guaranteeing rotation (bonus grows with days since a pillar was last used).
 */
export function planPillars(insights, count = 5) {
  const perf = Object.fromEntries(insights.pillarPerformance.map((p) => [p.key, p.score]));
  return PILLARS.map((pillar) => {
    const days = insights.lastUsedPillar[pillar];
    const recency = Math.min(Number.isFinite(days) ? days : 7, 7) * 0.15;
    return { pillar, weight: (perf[pillar] ?? 1) + recency };
  })
    .sort((a, b) => b.weight - a.weight)
    .slice(0, count)
    .map((p) => p.pillar);
}
