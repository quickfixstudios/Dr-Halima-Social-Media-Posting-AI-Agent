import { DateTime } from "luxon";
import { config } from "./config.js";
import { PILLARS, HOOK_PATTERNS, CONTENT_GOALS } from "./validate.js";
import { SLOTS } from "./schedule.js";

export const LEARNING = {
  weights: { likes: 1, comments: 3, shares: 4, saves: 4 },
  windowDays: 60,
  smoothingK: 3,
  winThreshold: 1.3,
  loseThreshold: 0.6,
  minScored: 5,
  topicCooldownDays: 45,
  hookCooldownDays: 21,
  recencyBonusPerDay: 0.15,
  temperature: 1.5,
};

/** (likes + 3·comments + 4·shares + 4·saves) / reach × 1000; raw weighted sum when reach is 0. */
export function engagementScore({ likes = 0, comments = 0, shares = 0, saves = 0, reach = 0 }) {
  const w = LEARNING.weights;
  const weighted = likes * w.likes + comments * w.comments + shares * w.shares + saves * w.saves;
  return reach > 0 ? Math.round((weighted / reach) * 1000 * 100) / 100 : weighted;
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function groupScores(scored, key) {
  const groups = {};
  for (const p of scored) (groups[p[key]] ??= []).push(p.perf);
  const k = LEARNING.smoothingK;
  return Object.fromEntries(
    Object.entries(groups).map(([g, perfs]) => [g, { n: perfs.length, score: Math.round(((perfs.reduce((a, b) => a + b, 0) + k) / (perfs.length + k)) * 100) / 100 }]),
  );
}

/**
 * Learning context from stored posts (Content rows). Pure → unit-testable.
 * @param {object[]} posts rows with date, content_pillar, post_type, hook_pattern, content_goal, topic, hook_english, engagement_score
 */
export function computeInsights(posts, { now = DateTime.now().setZone(config.schedule.timezone) } = {}) {
  const today = now.startOf("day");
  const ageDays = (p) => Math.round(today.diff(DateTime.fromISO(p.date, { zone: config.schedule.timezone }).startOf("day"), "days").days);
  const inWindow = posts.filter((p) => ageDays(p) <= LEARNING.windowDays && ageDays(p) >= 0);
  const scoredRaw = inWindow.filter((p) => typeof p.engagement_score === "number" && !Number.isNaN(p.engagement_score));
  const med = median(scoredRaw.map((p) => p.engagement_score));
  const scored = med > 0 ? scoredRaw.map((p) => ({ ...p, perf: Math.round((p.engagement_score / med) * 100) / 100 })) : [];
  const enough = scored.length >= LEARNING.minScored;

  const byPerf = [...scored].sort((a, b) => b.perf - a.perf);
  const topic = (p) => ({ pillar: p.content_pillar, topic: p.topic, score: p.perf });
  const lastUsed = Object.fromEntries(
    PILLARS.map((pillar) => {
      const ages = posts.filter((p) => p.content_pillar === pillar).map(ageDays).filter((d) => d >= 0);
      return [pillar, ages.length ? Math.min(...ages) : null];
    }),
  );

  return {
    scoredPosts: scored.length,
    medianScore: med,
    winningTopics: enough ? byPerf.filter((p) => p.perf >= LEARNING.winThreshold).slice(0, 6).map(topic) : [],
    winningHooks: enough ? byPerf.filter((p) => p.perf >= LEARNING.winThreshold).slice(0, 5).map((p) => ({ pattern: p.hook_pattern, hook: p.hook_english, score: p.perf })) : [],
    losingTopics: enough ? byPerf.filter((p) => p.perf <= LEARNING.loseThreshold).reverse().slice(0, 6).map(topic) : [],
    pillarPerformance: groupScores(scored, "content_pillar"),
    formatPerformance: groupScores(scored, "post_type"),
    hookPatternPerformance: groupScores(scored, "hook_pattern"),
    goalPerformance: groupScores(scored, "content_goal"),
    recentTopics: posts.filter((p) => ageDays(p) >= 0 && ageDays(p) <= LEARNING.topicCooldownDays).map((p) => p.topic).filter(Boolean),
    recentHooks: posts.filter((p) => ageDays(p) >= 0 && ageDays(p) <= LEARNING.hookCooldownDays).map((p) => p.hook_english).filter(Boolean),
    lastUsedPillar: lastUsed,
  };
}

/** Deterministic PRNG seeded by a string (same date → same plan). */
export function seededRandom(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedSample(weights, count, rng) {
  const pool = Object.entries(weights).map(([k, w]) => [k, Math.max(w, 0.01) ** LEARNING.temperature]);
  const out = [];
  while (out.length < count && pool.length) {
    let r = rng() * pool.reduce((s, [, w]) => s + w, 0);
    let i = pool.findIndex(([, w]) => (r -= w) <= 0);
    if (i < 0) i = pool.length - 1;
    out.push(pool.splice(i, 1)[0][0]);
  }
  return out;
}

const score = (group, key) => group[key]?.score ?? 1;

export function pillarWeights(insights) {
  return Object.fromEntries(
    PILLARS.map((p) => {
      const days = insights.lastUsedPillar[p];
      return [p, Math.round(score(insights.pillarPerformance, p) * (1 + LEARNING.recencyBonusPerDay * Math.min(days ?? 7, 7)) * 1000) / 1000];
    }),
  );
}

/**
 * STEP 1 (+ format) decisions for the 5 slots.
 * Pillars: weighted sampling (performance × rotation). Reels: fixed slots, highest-weight non-Emotional pillars.
 * Emotional Support → slot5. Carousel vs image by format performance (≥ 1 carousel).
 */
export function planDay(insights, { date, slotTimes = config.schedule.slotTimes, reelSlots = config.schedule.reelSlots } = {}) {
  const rng = seededRandom(`plan:${date}`);
  const weights = pillarWeights(insights);
  const chosen = weightedSample(weights, 5, rng).sort((a, b) => weights[b] - weights[a]);

  const plan = SLOTS.map((slot, i) => ({ scheduled_slot: slot, time: slotTimes[i], post_type: reelSlots.includes(slot) ? "reel" : null, content_pillar: null }));
  const take = (pred) => {
    const i = chosen.findIndex(pred);
    return i < 0 ? undefined : chosen.splice(i, 1)[0];
  };
  const es = take((p) => p === "Emotional Support");
  if (es) plan[4].content_pillar = es;
  for (const s of plan.filter((x) => x.post_type === "reel" && !x.content_pillar)) s.content_pillar = take(() => true);
  for (const s of plan.filter((x) => !x.content_pillar)) s.content_pillar = take(() => true);

  const fp = insights.formatPerformance;
  const pCarousel = Math.min(0.85, Math.max(0.34, score(fp, "carousel") / (score(fp, "carousel") + score(fp, "image"))));
  for (const s of plan.filter((x) => !x.post_type)) s.post_type = rng() < pCarousel ? "carousel" : "image";
  if (!plan.some((s) => s.post_type === "carousel")) plan.find((s) => s.post_type === "image").post_type = "carousel";
  return plan;
}

/** Topic Bank ideas per planned pillar, minus recent and low-performing topics. */
export function topicIdeas(insights, plan, bank, perPillar = 4) {
  const blocked = [...insights.recentTopics, ...insights.losingTopics.map((t) => t.topic)].map((t) => t.toLowerCase());
  const isBlocked = (t) => blocked.some((b) => b.includes(t.toLowerCase()) || t.toLowerCase().includes(b));
  return Object.fromEntries(
    plan.map((s) => [
      s.content_pillar,
      bank
        .filter((r) => r.content_pillar === s.content_pillar && !isBlocked(r.topic))
        .sort((a, b) => Number(a.priority ?? 9) - Number(b.priority ?? 9))
        .slice(0, perPillar)
        .map((r) => r.topic),
    ]),
  );
}

export { HOOK_PATTERNS, CONTENT_GOALS };
