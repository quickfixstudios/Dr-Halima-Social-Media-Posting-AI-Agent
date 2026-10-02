import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DateTime } from "luxon";
import { DailyBatchSchema, PILLARS, HOOK_PATTERNS, CONTENT_GOALS, PerformanceRecordSchema } from "../src/schema.js";
import { checkPostSafety, enforceCaptionRules, DISCLAIMER } from "../src/safety.js";
import { slotToUtc } from "../src/utils/time.js";
import { computeInsights, planDay, topicSuggestions, engagementScore, toPerformanceRecord } from "../src/engagement.js";
import { assignSlots } from "../src/schedulePosts.js";
import { buildPostText } from "../src/buffer.js";
import { toBatchItem } from "../src/pipeline.js";

const today = JSON.parse(fs.readFileSync("content/2026-10-02.json", "utf8"));
const posts = today.daily_batch;
const TIMES = ["10:00", "13:00", "16:00", "19:00", "22:00"];

test("today's batch matches the schema (2 reels, 3 image/carousel, unique, all goals)", () => {
  const { daily_batch } = DailyBatchSchema.parse(today);
  assert.equal(daily_batch.filter((p) => p.post_type === "reel").length, 2);
  assert.deepEqual(daily_batch.map((p) => p.scheduled_slot), ["slot1", "slot2", "slot3", "slot4", "slot5"]);
});

test("reels are 20–40 s with the hook inside 3 s and a storyboard ending on the disclaimer", () => {
  for (const reel of posts.filter((p) => p.post_type === "reel")) {
    assert.ok(reel.estimated_length_seconds >= 20 && reel.estimated_length_seconds <= 40);
    assert.ok(reel.video_storyboard[0].end_s <= 3);
    assert.equal(reel.video_storyboard.at(-1).end_s, reel.estimated_length_seconds);
  }
});

test("today's batch passes the compliance gate", () => {
  for (const post of posts) {
    assert.deepEqual(checkPostSafety(post), [], post.id);
    assert.ok(post.caption.includes(DISCLAIMER));
    assert.match(post.caption, /save this/i);
    assert.match(post.caption, /share/i);
  }
});

test("compliance gate flags dosing, diagnosis, absolute claims and fear", () => {
  const bad = { ...posts[0], caption: "Take this pill: 500 mg daily. This means you have PCOS. It will always work, or it could kill you." };
  const issues = checkPostSafety(bad).join(" | ");
  for (const reason of ["dosage", "diagnostic", "absolute", "fear"]) assert.match(issues, new RegExp(reason));
  const reel = posts.find((p) => p.post_type === "reel");
  const noDisclaimer = { ...reel, video_storyboard: reel.video_storyboard.map((b, i, a) => (i === a.length - 1 ? { ...b, on_screen_text: "Bye" } : b)) };
  assert.ok(checkPostSafety(noDisclaimer).some((i) => i.includes("final frame")));
});

test("enforceCaptionRules appends missing disclaimer and save CTA", () => {
  const fixed = enforceCaptionRules({ ...posts[0], caption: "Short caption." });
  assert.ok(fixed.caption.endsWith(DISCLAIMER));
  assert.match(fixed.caption, /Save this/);
});

test("slots map to Asia/Dhaka times in UTC", () => {
  const slots = assignSlots("2026-10-02", posts, { postTimes: TIMES, timezone: "Asia/Dhaka" });
  assert.deepEqual(
    slots.map((s) => s.scheduledAt.toISOString()),
    ["04:00", "07:00", "10:00", "13:00", "16:00"].map((t) => `2026-10-02T${t}:00.000Z`),
  );
  assert.equal(slotToUtc("2026-10-02", "22:00", "Asia/Dhaka").toISOString(), "2026-10-02T16:00:00.000Z");
});

test("Buffer text keeps the disclaimer and hashtags when trimmed", () => {
  const long = { ...posts[0], caption: "x".repeat(3000) + `\n\n${DISCLAIMER}` };
  const text = buildPostText(long);
  assert.ok(text.length <= 2200);
  assert.ok(text.includes(DISCLAIMER));
  assert.ok(text.endsWith(posts[0].hashtags.join(" ")));
});

test("performance records use the canonical format", () => {
  const rec = toPerformanceRecord("2026-10-02-1", { likes: 10, comments: 2, shares: 1, saves: 1, reach: 0 });
  assert.deepEqual(Object.keys(rec), ["post_id", "likes", "comments", "shares", "saves", "engagement_score"]);
  assert.equal(rec.engagement_score, 24);
  PerformanceRecordSchema.parse(rec);
  assert.equal(engagementScore({ likes: 10, comments: 2, shares: 1, saves: 1 }, 1000), 24);
});

test("toBatchItem strips storage-only fields", () => {
  const item = toBatchItem({ ...posts[0], status: "scheduled", buffer_updates: [], date: "2026-10-02" });
  assert.equal(item.status, undefined);
  DailyBatchSchema.parse({ daily_batch: posts.map(toBatchItem) });
});

// ---------- learning system ----------
const now = DateTime.fromISO("2026-10-03T00:00:00Z");
const mk = (date, n, pillar, topic, extra = {}) => ({
  id: `${date}-${n}`, date, scheduled_slot: `slot${n}`, content_pillar: pillar, topic,
  post_type: "carousel", hook_pattern: "Curiosity", content_goal: "save-worthy", hook_english: `hook ${topic}`, ...extra,
});
const history = [
  mk("2026-09-20", 1, "Myth vs Fact", "Myths about periods", { hook_pattern: "Myth-breaking" }),
  mk("2026-09-21", 1, "Myth vs Fact", "Pregnancy food myths", { hook_pattern: "Myth-breaking" }),
  mk("2026-09-22", 1, "Myth vs Fact", "Contraception myths", { hook_pattern: "Myth-breaking" }),
  mk("2026-09-20", 2, "Preventive Tips", "Iron-rich foods for women", { post_type: "image" }),
  mk("2026-09-21", 2, "Preventive Tips", "Bone health for women before 40", { post_type: "image" }),
  mk("2026-09-22", 2, "Education", "What hormones actually do", { post_type: "image" }),
  mk("2026-09-23", 3, "Hormonal Health", "Thyroid and menstrual health"), // legacy pillar name
  mk("2026-10-02", 1, "Pregnancy Guidance", "First-trimester fatigue", { post_type: "reel" }),
];
const performance = [
  ["2026-09-20-1", 120], ["2026-09-21-1", 110], ["2026-09-22-1", 100],
  ["2026-09-20-2", 10], ["2026-09-21-2", 12], ["2026-09-22-2", 40],
  ["2026-09-23-3", 45], ["2026-10-02-1", 42],
].map(([post_id, engagement_score]) => ({ post_id, likes: 0, comments: 0, shares: 0, saves: 0, engagement_score }));

test("insights find winning topics/hooks, losing topics, and map legacy pillars", () => {
  const insights = computeInsights(history, performance, { now });
  assert.equal(insights.winningTopics[0].topic, "Myths about periods");
  assert.equal(insights.winningHooks[0].pattern, "Myth-breaking");
  assert.ok(insights.losingTopics.some((t) => t.topic === "Iron-rich foods for women"));
  assert.ok(insights.pillarPerformance["Hormonal/Period Health"]);
  assert.ok(insights.pillarPerformance["Myth vs Fact"].score > insights.pillarPerformance["Preventive Tips"].score);
  assert.ok(insights.formatPerformance.carousel.score > insights.formatPerformance.image.score);
});

test("planDay obeys the daily rules on every date", () => {
  const insights = computeInsights(history, performance, { now });
  for (let d = 1; d <= 30; d++) {
    const plan = planDay(insights, { date: `2026-11-${String(d).padStart(2, "0")}`, postTimes: TIMES });
    assert.equal(plan.length, 5);
    assert.deepEqual(plan.filter((s) => s.post_type === "reel").map((s) => s.scheduled_slot), ["slot2", "slot4"]);
    assert.ok(plan.some((s) => s.post_type === "carousel"));
    assert.equal(new Set(plan.map((s) => s.content_pillar)).size, 5);
    assert.ok(plan.every((s) => PILLARS.includes(s.content_pillar)));
    assert.deepEqual(new Set(plan.map((s) => s.hook_pattern)), new Set(HOOK_PATTERNS));
    for (const g of CONTENT_GOALS) assert.ok(plan.some((s) => s.content_goal === g), g);
    const es = plan.find((s) => s.content_pillar === "Emotional Support");
    if (es) assert.equal(es.scheduled_slot, "slot5");
    const mvf = plan.find((s) => s.content_pillar === "Myth vs Fact");
    if (mvf) assert.equal(mvf.hook_pattern, "Myth-breaking");
  }
});

test("planDay favours winning pillars and is reproducible per date", () => {
  const insights = computeInsights(history, performance, { now });
  let myth = 0;
  let prevent = 0;
  for (let d = 1; d <= 200; d++) {
    const plan = planDay(insights, { date: `d${d}`, postTimes: TIMES });
    if (plan.some((s) => s.content_pillar === "Myth vs Fact")) myth++;
    if (plan.some((s) => s.content_pillar === "Preventive Tips")) prevent++;
  }
  assert.ok(myth > prevent, `myth ${myth} vs prevent ${prevent}`);
  assert.deepEqual(planDay(insights, { date: "2026-11-01", postTimes: TIMES }), planDay(insights, { date: "2026-11-01", postTimes: TIMES }));
});

test("topic suggestions exclude recent and low-performing topics", () => {
  const insights = computeInsights(history, performance, { now });
  const plan = [{ content_pillar: "Pregnancy Guidance" }, { content_pillar: "Preventive Tips" }];
  const s = topicSuggestions(insights, plan, 10);
  assert.ok(!s["Pregnancy Guidance"].includes("First-trimester fatigue"));
  assert.ok(!s["Preventive Tips"].includes("Iron-rich foods for women"));
});
