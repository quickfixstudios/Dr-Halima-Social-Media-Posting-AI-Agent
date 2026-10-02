import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DateTime } from "luxon";
import { validBatch, post } from "./fixtures.js";
import { scheduledAt } from "../src/schedule.js";
import { validateBatch } from "../src/validate.js";
import { ruleScan, autoFix, decide, DISCLAIMER } from "../src/compliance.js";
import { computeInsights, planDay, topicIdeas, engagementScore, pillarWeights } from "../src/learning.js";
import { buildUserPrompt, BATCH_FORMAT, COMPLIANCE_FORMAT } from "../src/prompts.js";
import { CONTENT_COLUMNS, postToRow, rowToPost, columnLetter, serialToIsoDate } from "../src/storage/sheets.js";
import { dueForSnapshot, combine } from "../src/sync.js";
import { initialStatus } from "../src/pipeline.js";

const TIMES = ["10:00", "13:00", "16:00", "19:00", "22:00"];

test("slots map to Asia/Dhaka timestamps with explicit offset", () => {
  assert.equal(scheduledAt("2026-10-02", "slot1", { slotTimes: TIMES, timezone: "Asia/Dhaka" }), "2026-10-02T10:00:00+06:00");
  assert.equal(scheduledAt("2026-10-02", "slot5", { slotTimes: TIMES, timezone: "Asia/Dhaka" }), "2026-10-02T22:00:00+06:00");
});

test("a valid batch passes; daily rules are enforced", () => {
  assert.deepEqual(validateBatch(validBatch(), { reelSlots: ["slot2", "slot4"] }).problems, []);
  const b = validBatch();
  b.daily_batch[2].post_type = "reel";
  b.daily_batch[2].content_pillar = "Myth vs Fact";
  const r = validateBatch(b, { reelSlots: ["slot2", "slot4"], recentTopics: ["topic a"] });
  assert.ok(r.problems.some((p) => p.includes("reels must be exactly")));
  assert.ok(r.problems.some((p) => p.includes("content_pillar must be unique")));
  assert.ok(r.problems.some((p) => p.includes("used recently")));
  assert.ok(r.problems.some((p) => p.includes("slot3")));
});

test("reel timing rules", () => {
  const b = validBatch();
  b.daily_batch[1].video_storyboard[0].end_s = 5;
  b.daily_batch[1].video_storyboard.at(-1).end_s = 55;
  const problems = validateBatch(b, { reelSlots: ["slot2", "slot4"] }).problems.join(" | ");
  assert.match(problems, /hook beat must end by 3s/);
  assert.match(problems, /20–40s/);
});

test("compliance rule scan flags unsafe copy but allows negated visual exclusions", () => {
  const clean = validBatch().daily_batch[0];
  assert.deepEqual(ruleScan(clean), []);
  const bad = { ...clean, caption: "Take this pill, 500 mg daily. It is guaranteed and you could die otherwise." };
  const rules = ruleScan(bad).map((h) => h.rule);
  for (const r of ["dosage", "medication_instruction", "absolute_claim", "fear"]) assert.ok(rules.includes(r), r);
  assert.ok(ruleScan({ ...clean, visual_prompt: "Close-up surgery scene" }).some((h) => h.rule === "sensitive_visual"));
});

test("autoFix keeps the disclaimer last and adds save/share + reel disclaimer", () => {
  const p = autoFix({ ...post("slot2", "reel", "Pregnancy", "Relatability", "save-worthy", "x"), caption: "Short caption." });
  assert.ok(p.caption.endsWith(DISCLAIMER));
  assert.match(p.caption, /Save this/);
  const r = post("slot2", "reel", "Pregnancy", "Relatability", "save-worthy", "x");
  r.video_storyboard.at(-1).on_screen_text = "Bye";
  assert.match(autoFix(r).video_storyboard.at(-1).on_screen_text, /Educational only/);
});

test("decide: pass, fix, block, and unreviewed when the LLM review is unavailable", () => {
  const posts = validBatch().daily_batch;
  const review = { reviews: [
    { id: posts[0].id, verdict: "pass", issues: [], suggested_fix: { caption: "", script: "", carousel_slides_text: [] } },
    { id: posts[1].id, verdict: "fix", issues: ["tone"], suggested_fix: { caption: "Fixed caption. 📌 Save this and share it.", script: "", carousel_slides_text: [] } },
    { id: posts[2].id, verdict: "block", issues: ["diagnosis"], suggested_fix: { caption: "", script: "", carousel_slides_text: [] } },
  ] };
  const d = decide(posts, review);
  assert.equal(d[0].verdict, "pass");
  assert.equal(d[1].verdict, "fix_applied");
  assert.match(d[1].post.caption, /^Fixed caption/);
  assert.ok(d[1].post.caption.endsWith(DISCLAIMER));
  assert.equal(d[2].verdict, "block");
  assert.ok(decide(posts, null).every((x) => x.verdict === "unreviewed"));
});

test("initial status mapping", () => {
  const p = (t) => ({ post: { post_type: t } });
  assert.equal(initialStatus({ ...p("image"), verdict: "pass" }), "ready");
  assert.equal(initialStatus({ ...p("reel"), verdict: "pass" }), "awaiting_video");
  assert.equal(initialStatus({ ...p("image"), verdict: "block" }), "needs_review");
  assert.equal(initialStatus({ ...p("image"), verdict: "unreviewed" }), "needs_review");
  assert.equal(initialStatus({ ...p("image"), verdict: "pass" }, { imageError: "x" }), "needs_review");
});

test("strict schemas: every object lists all properties as required with additionalProperties false", () => {
  const walk = (node, path) => {
    if (node?.type === "object") {
      assert.equal(node.additionalProperties, false, path);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), path);
      for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`);
    }
    if (node?.type === "array") walk(node.items, `${path}[]`);
  };
  for (const f of [BATCH_FORMAT, COMPLIANCE_FORMAT]) {
    assert.equal(f.type, "json_schema");
    assert.equal(f.strict, true);
    walk(f.schema, f.name);
  }
});

test("user prompt template is fully rendered", () => {
  const insights = computeInsights([], { now: DateTime.fromISO("2026-10-02", { zone: "Asia/Dhaka" }) });
  const plan = planDay(insights, { date: "2026-10-02", slotTimes: TIMES, reelSlots: ["slot2", "slot4"] });
  const prompt = buildUserPrompt({ date: "2026-10-02", plan, insights, topicIdeas: {} });
  assert.ok(!/\{\{\w+\}\}/.test(prompt), "no unresolved placeholders");
  assert.match(prompt, /slot2 \(13:00\): reel/);
});

// ---------- learning ----------
const now = DateTime.fromISO("2026-10-02T06:00", { zone: "Asia/Dhaka" });
const row = (date, slot, pillar, topic, score, extra = {}) => ({
  id: `${date}-${slot}`, date, content_pillar: pillar, topic, engagement_score: score,
  post_type: "carousel", hook_pattern: "Curiosity", content_goal: "save-worthy", hook_english: `hook ${topic}`, ...extra,
});
const history = [
  row("2026-09-10", 1, "Myth vs Fact", "Topic M1", 120, { hook_pattern: "Myth-breaking" }),
  row("2026-09-11", 1, "Myth vs Fact", "Topic M2", 110, { hook_pattern: "Myth-breaking" }),
  row("2026-09-12", 1, "Myth vs Fact", "Topic M3", 100, { hook_pattern: "Myth-breaking" }),
  row("2026-09-10", 3, "Preventive Tips", "Topic P1", 10, { post_type: "image" }),
  row("2026-09-11", 3, "Preventive Tips", "Topic P2", 12, { post_type: "image" }),
  row("2026-09-12", 3, "Education", "Topic E1", 40, { post_type: "image" }),
  row("2026-09-13", 3, "Hormonal Health", "Topic H1", 45),
  row("2026-10-01", 2, "Pregnancy", "Topic G1", 42, { post_type: "reel" }),
];

test("engagement score", () => {
  assert.equal(engagementScore({ likes: 10, comments: 2, shares: 1, saves: 1 }), 24);
  assert.equal(engagementScore({ likes: 10, comments: 2, shares: 1, saves: 1, reach: 1000 }), 24);
});

test("insights: winners, losers, cooldowns", () => {
  const i = computeInsights(history, { now });
  assert.equal(i.winningTopics[0].topic, "Topic M1");
  assert.equal(i.winningHooks[0].pattern, "Myth-breaking");
  assert.ok(i.losingTopics.some((t) => t.topic === "Topic P1"));
  assert.ok(i.recentTopics.includes("Topic G1"));
  assert.ok(i.pillarPerformance["Myth vs Fact"].score > i.pillarPerformance["Preventive Tips"].score);
  assert.equal(computeInsights(history.slice(0, 3), { now }).winningTopics.length, 0, "needs ≥ 5 scored posts");
});

test("planDay obeys slot rules for every date", () => {
  const i = computeInsights(history, { now });
  for (let d = 1; d <= 60; d++) {
    const plan = planDay(i, { date: `seed-${d}`, slotTimes: TIMES, reelSlots: ["slot2", "slot4"] });
    assert.deepEqual(plan.map((s) => s.scheduled_slot), ["slot1", "slot2", "slot3", "slot4", "slot5"]);
    assert.deepEqual(plan.filter((s) => s.post_type === "reel").map((s) => s.scheduled_slot), ["slot2", "slot4"]);
    assert.ok(plan.some((s) => s.post_type === "carousel"));
    assert.equal(new Set(plan.map((s) => s.content_pillar)).size, 5);
    const es = plan.find((s) => s.content_pillar === "Emotional Support");
    if (es) assert.equal(es.scheduled_slot, "slot5");
    assert.ok(!["slot2", "slot4"].includes(es?.scheduled_slot));
  }
});

test("planDay favours winning pillars, rotates unused ones, and is reproducible", () => {
  const i = computeInsights(history, { now });
  const w = pillarWeights(i);
  assert.ok(w["Emotional Support"] > w["Pregnancy"], "never-used pillar gets the rotation bonus");
  let myth = 0, prevent = 0;
  for (let d = 0; d < 300; d++) {
    const plan = planDay(i, { date: `d${d}`, slotTimes: TIMES, reelSlots: ["slot2", "slot4"] });
    if (plan.some((s) => s.content_pillar === "Myth vs Fact")) myth++;
    if (plan.some((s) => s.content_pillar === "Preventive Tips")) prevent++;
  }
  assert.ok(myth > prevent, `${myth} vs ${prevent}`);
  assert.deepEqual(planDay(i, { date: "x", slotTimes: TIMES }), planDay(i, { date: "x", slotTimes: TIMES }));
});

test("topic ideas exclude recent and low-performing topics", () => {
  const i = computeInsights(history, { now });
  const bank = [
    { content_pillar: "Pregnancy", topic: "Topic G1", priority: 1 },
    { content_pillar: "Pregnancy", topic: "Fresh pregnancy topic", priority: 1 },
    { content_pillar: "Preventive Tips", topic: "Topic P1", priority: 1 },
  ];
  const ideas = topicIdeas(i, [{ content_pillar: "Pregnancy" }, { content_pillar: "Preventive Tips" }], bank);
  assert.deepEqual(ideas.Pregnancy, ["Fresh pregnancy topic"]);
  assert.deepEqual(ideas["Preventive Tips"], []);
});

// ---------- storage + sync ----------
test("Content columns match sheets/Content.csv and rows round-trip", () => {
  const header = fs.readFileSync(new URL("../../sheets/Content.csv", import.meta.url), "utf8").trim().split(",");
  assert.deepEqual(CONTENT_COLUMNS, header);
  assert.equal(columnLetter(CONTENT_COLUMNS.length - 1), "AJ");
  assert.equal(serialToIsoDate(46297), "2026-10-02");
  const p = { ...validBatch().daily_batch[0], date: "2026-10-02", image_urls: ["https://a", "https://b"], status: "ready", likes: 5 };
  const r = postToRow(p);
  assert.equal(r[1], "2026-10-02");
  assert.equal(r[0], `'${p.id}`);
  const back = rowToPost(r.map((v) => (typeof v === "string" ? v.replace(/^'/, "") : v)), 2);
  assert.equal(back.hashtags, p.hashtags.join(" "));
  assert.equal(back.image_urls, "https://a,https://b");
  assert.deepEqual(JSON.parse(back.carousel_slides_json), p.carousel_slides);
  assert.equal(back.likes, 5);
});

test("engagement snapshots are taken on day 1, 3 and 7", () => {
  const mk = (d) => ({ id: d, status: "published", published_at: `${d}T10:00:05+06:00` });
  const due = dueForSnapshot([mk("2026-10-01"), mk("2026-09-29"), mk("2026-09-25"), mk("2026-09-30"), { ...mk("2026-10-01"), status: "ready" }], now).map((p) => p.id);
  assert.deepEqual(due, ["2026-10-01", "2026-09-29", "2026-09-25"]);
  const c = combine({ likes: 10, comments: 2, shares: 1, saves: 1, reach: 500 }, { likes: 5, comments: 0, shares: 0, saves: 0, reach: 500 });
  assert.equal(c.likes, 15);
  assert.equal(c.engagement_score, engagementScore({ likes: 15, comments: 2, shares: 1, saves: 1, reach: 1000 }));
});
