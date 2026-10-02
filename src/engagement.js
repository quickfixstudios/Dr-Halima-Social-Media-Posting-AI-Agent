import { DateTime } from "luxon";
import { getAllPosts, getPerformance, updatePost, upsertPerformance } from "./db.js";
import { getUpdateStats } from "./buffer.js";
import { PILLARS, PILLAR_ALIASES, HOOK_PATTERNS, CONTENT_GOALS, SLOTS, PerformanceRecordSchema } from "./schema.js";
import { TOPIC_BANK } from "./topicBank.js";
import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";

const log = createLogger("engagement");

export const LEARNING = {
  weights: { likes: 1, comments: 3, shares: 4, saves: 4 }, // shares/saves signal trust + reach most
  smoothingK: 3, // Bayesian prior: small samples are pulled toward the average (1.0)
  winThreshold: 1.3, // ≥ 1.3× median engagement = winner
  loseThreshold: 0.6, // ≤ 0.6× median = loser
  topicCooldownDays: 45,
  hookCooldownDays: 21,
  recencyBonusPerDay: 0.15, // pillar rotation pressure, capped at 7 days
  temperature: 1.5, // >1 sharpens toward winners, <1 explores more
  reelSlots: ["slot2", "slot4"],
};

const HOOK_ALIASES = { Relatable: "Relatability", "Warning (non-alarmist)": "Gentle warning" };
const canonicalPillar = (p) => PILLAR_ALIASES[p] ?? p;
const canonicalHook = (h) => HOOK_ALIASES[h] ?? h;

/** engagement_score: weighted interactions per 1,000 reach (raw weighted sum when reach is unknown). */
export function engagementScore(m, reach = 0) {
  const weighted = Object.entries(LEARNING.weights).reduce((sum, [k, w]) => sum + (m[k] ?? 0) * w, 0);
  return reach > 0 ? +((weighted / reach) * 1000).toFixed(2) : weighted;
}

/** Build the performance feedback record in the canonical format. */
export function toPerformanceRecord(postId, totals) {
  return PerformanceRecordSchema.parse({
    post_id: postId,
    likes: totals.likes,
    comments: totals.comments,
    shares: totals.shares,
    saves: totals.saves,
    engagement_score: engagementScore(totals, totals.reach),
  });
}

/** Pull Buffer stats for posts published 1–14 days ago and refresh their performance records. */
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
      const totals = { likes: 0, comments: 0, shares: 0, saves: 0, clicks: 0, reach: 0 };
      for (const s of stats) for (const k of Object.keys(totals)) totals[k] += s[k] ?? 0;
      upsertPerformance(toPerformanceRecord(post.id, totals));
      updatePost(post.id, {
        metrics: { ...totals, updated_at: now.toISO() },
        status: stats.some((s) => s.status === "sent") ? "published" : post.status,
      });
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
  return Object.fromEntries(
    Object.entries(groups).map(([k, perfs]) => [
      k,
      { n: perfs.length, score: +((perfs.reduce((a, b) => a + b, 0) + LEARNING.smoothingK) / (perfs.length + LEARNING.smoothingK)).toFixed(2) },
    ]),
  );
}

/**
 * Turn history + performance records into guidance for the next run.
 * Pure function → deterministic and unit-testable.
 */
export function computeInsights(posts, performance, { now = DateTime.utc() } = {}) {
  const daysAgo = (p) => now.diff(DateTime.fromISO(p.date, { zone: "utc" }), "days").days;
  const perfById = Object.fromEntries(performance.map((r) => [r.post_id, r.engagement_score]));
  const norm = posts.map((p) => ({
    ...p,
    content_pillar: canonicalPillar(p.content_pillar),
    hook_pattern: canonicalHook(p.hook_pattern ?? p.hook_style),
    content_goal: p.content_goal ?? "unknown",
    scheduled_slot: p.scheduled_slot ?? (p.post_number ? `slot${p.post_number}` : "unknown"),
  }));

  const scored = norm.filter((p) => typeof perfById[p.id] === "number");
  const med = median(scored.map((p) => perfById[p.id])) || 1;
  for (const p of scored) p.perf = +(perfById[p.id] / med).toFixed(2);
  const byPerf = [...scored].sort((a, b) => b.perf - a.perf);
  const winners = byPerf.filter((p) => p.perf >= LEARNING.winThreshold);
  const losers = byPerf.filter((p) => p.perf <= LEARNING.loseThreshold).reverse();
  const topic = (p) => ({ pillar: p.content_pillar, topic: p.topic, score: p.perf });

  const lastUsedPillar = {};
  for (const pillar of PILLARS) {
    const used = norm.filter((p) => p.content_pillar === pillar).map(daysAgo);
    lastUsedPillar[pillar] = used.length ? Math.min(...used) : null; // null = never used
  }

  return {
    sampleSize: scored.length,
    medianScore: med,
    winningTopics: winners.slice(0, 6).map(topic),
    losingTopics: losers.slice(0, 6).map(topic),
    winningHooks: winners.slice(0, 5).map((p) => ({ pattern: p.hook_pattern, hook: p.hook_english, score: p.perf })),
    pillarPerformance: groupPerformance(scored, "content_pillar"),
    formatPerformance: groupPerformance(scored, "post_type"),
    hookPatternPerformance: groupPerformance(scored, "hook_pattern"),
    goalPerformance: groupPerformance(scored, "content_goal"),
    slotPerformance: groupPerformance(scored, "scheduled_slot"),
    recentTopics: norm.filter((p) => daysAgo(p) <= LEARNING.topicCooldownDays).map((p) => p.topic),
    recentHooks: norm.filter((p) => daysAgo(p) <= LEARNING.hookCooldownDays).map((p) => p.hook_english),
    lastUsedPillar,
  };
}

// ---------- decision system (STEP 1, 3, 4) ----------

/** Small seeded PRNG so a given date always produces the same plan (reproducible runs). */
export function seededRandom(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (const c of seedText) h = Math.imul(h ^ c.charCodeAt(0), 3432918353), (h = (h << 13) | (h >>> 19));
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/** Sample `count` distinct keys with probability ∝ weight^temperature. */
function weightedSample(weights, count, rng) {
  const pool = Object.entries(weights).map(([key, w]) => [key, Math.max(w, 0.01) ** LEARNING.temperature]);
  const picked = [];
  while (picked.length < count && pool.length) {
    let r = rng() * pool.reduce((s, [, w]) => s + w, 0);
    const i = pool.findIndex(([, w]) => (r -= w) <= 0);
    picked.push(pool.splice(i === -1 ? pool.length - 1 : i, 1)[0][0]);
  }
  return picked;
}

const score = (group, key) => group[key]?.score ?? 1;

const HOOK_AFFINITY = { "Myth vs Fact": "Myth-breaking", "Warning/Awareness": "Gentle warning", "Emotional Support": "Reassurance" };
const GOAL_AFFINITY = {
  "Emotional Support": "share-worthy",
  "Myth vs Fact": "share-worthy",
  "Warning/Awareness": "authority-building",
  Education: "authority-building",
  "Preventive Tips": "save-worthy",
  "Pregnancy Guidance": "save-worthy",
  "Hormonal/Period Health": "save-worthy",
};

/**
 * Build today's slot plan: which pillar, format, hook pattern and goal goes in each slot.
 * Exploits winners (performance-weighted sampling) while forcing rotation and variety.
 */
export function planDay(insights, { date, postTimes = config.schedule.postTimes } = {}) {
  const rng = seededRandom(date ?? "seed");

  // STEP 1 — pillars: performance × rotation bonus, sampled without replacement.
  const pillarWeights = Object.fromEntries(
    PILLARS.map((pillar) => {
      const days = insights.lastUsedPillar[pillar];
      const recency = 1 + LEARNING.recencyBonusPerDay * Math.min(days ?? 7, 7);
      return [pillar, score(insights.pillarPerformance, pillar) * recency];
    }),
  );
  const pillars = weightedSample(pillarWeights, 5, rng);

  // Emotional content performs best late; the strongest pillar takes a reel slot.
  const order = [...pillars];
  const late = order.indexOf("Emotional Support");
  if (late >= 0) order.push(order.splice(late, 1)[0]);

  // Formats: 2 reels at fixed slots; other slots choose carousel vs image by performance.
  const carouselShare = Math.min(0.85, Math.max(0.34, score(insights.formatPerformance, "carousel") / (score(insights.formatPerformance, "carousel") + score(insights.formatPerformance, "image"))));
  const plan = SLOTS.map((slot, i) => ({
    scheduled_slot: slot,
    time: postTimes[i],
    post_type: LEARNING.reelSlots.includes(slot) ? "reel" : rng() < carouselShare ? "carousel" : "image",
  }));
  if (!plan.some((s) => s.post_type === "carousel")) plan.find((s) => s.post_type === "image").post_type = "carousel";

  // Put Emotional Support in slot5; fill reels first with the highest-weight remaining pillars.
  const assigned = new Array(5);
  if (late >= 0) assigned[4] = order.pop();
  const reelIdx = plan.map((s, i) => (s.post_type === "reel" && !assigned[i] ? i : -1)).filter((i) => i >= 0);
  const rest = [...order].sort((a, b) => pillarWeights[b] - pillarWeights[a]);
  for (const i of reelIdx) assigned[i] = rest.shift();
  for (let i = 0; i < 5; i++) assigned[i] ??= rest.shift();
  plan.forEach((s, i) => (s.content_pillar = assigned[i]));

  // STEP 3 — hook patterns: each used once; natural pillar affinities first, then by performance.
  const hooksLeft = new Set(HOOK_PATTERNS);
  for (const s of plan) {
    const h = HOOK_AFFINITY[s.content_pillar];
    if (h && hooksLeft.has(h)) (s.hook_pattern = h), hooksLeft.delete(h);
  }
  for (const s of plan.filter((p) => !p.hook_pattern)) {
    const [h] = weightedSample(Object.fromEntries([...hooksLeft].map((k) => [k, score(insights.hookPatternPerformance, k)])), 1, rng);
    s.hook_pattern = h;
    hooksLeft.delete(h);
  }

  // STEP 4 — goals: pillar affinity, then guarantee every goal appears at least once.
  for (const s of plan) s.content_goal = GOAL_AFFINITY[s.content_pillar];
  for (const goal of CONTENT_GOALS) {
    if (plan.some((s) => s.content_goal === goal)) continue;
    const counts = Object.fromEntries(CONTENT_GOALS.map((g) => [g, plan.filter((s) => s.content_goal === g).length]));
    const donor = plan
      .filter((s) => counts[s.content_goal] > 1)
      .sort((a, b) => score(insights.goalPerformance, a.content_goal) - score(insights.goalPerformance, b.content_goal))[0];
    donor.content_goal = goal;
  }
  return plan;
}

/** STEP 2 helper: topic ideas per pillar minus anything recently used or low-performing. */
export function topicSuggestions(insights, plan, perPillar = 5) {
  const blocked = [...insights.recentTopics, ...insights.losingTopics.map((t) => t.topic)].map((t) => t.toLowerCase());
  const isBlocked = (t) => blocked.some((b) => b.includes(t.toLowerCase()) || t.toLowerCase().includes(b));
  return Object.fromEntries(plan.map((s) => [s.content_pillar, (TOPIC_BANK[s.content_pillar] ?? []).filter((t) => !isBlocked(t)).slice(0, perPillar)]));
}

export function currentInsights(now) {
  return computeInsights(getAllPosts(), getPerformance(), { now });
}
