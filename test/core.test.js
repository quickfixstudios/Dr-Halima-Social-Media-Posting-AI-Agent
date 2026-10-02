import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DateTime } from "luxon";
import { DailyContentSchema } from "../src/schema.js";
import { checkPostSafety, enforceCaptionRules, DISCLAIMER } from "../src/safety.js";
import { slotToUtc } from "../src/utils/time.js";
import { computeInsights, planPillars, engagementScore } from "../src/engagement.js";
import { assignSlots } from "../src/schedulePosts.js";
import { buildPostText } from "../src/buffer.js";
import { splitSlides } from "../src/generateImage.js";

const today = JSON.parse(fs.readFileSync("content/2026-10-02.json", "utf8"));

test("today's content matches the schema (2 reels, unique topics/pillars/hooks)", () => {
  const parsed = DailyContentSchema.parse(today);
  assert.equal(parsed.posts.filter((p) => p.post_type === "reel").length, 2);
});

test("today's content passes the safety review and carries the disclaimer", () => {
  for (const post of today.posts) {
    assert.deepEqual(checkPostSafety(post), [], `post ${post.post_number}`);
    assert.ok(post.caption.includes(DISCLAIMER));
    assert.match(post.caption, /save this/i);
  }
});

test("safety review flags doses, diagnosis and fear language", () => {
  const bad = { ...today.posts[0], caption: "Take this pill: 500 mg daily. This means you have PCOS and it could kill you." };
  const issues = checkPostSafety(bad);
  assert.ok(issues.some((i) => i.includes("dosage")));
  assert.ok(issues.some((i) => i.includes("diagnostic")));
  assert.ok(issues.some((i) => i.includes("fear")));
});

test("enforceCaptionRules appends missing disclaimer and save CTA", () => {
  const fixed = enforceCaptionRules({ ...today.posts[0], caption: "Short caption." });
  assert.ok(fixed.caption.endsWith(DISCLAIMER));
  assert.match(fixed.caption, /Save this/);
});

test("slots convert from brand timezone to UTC", () => {
  assert.equal(slotToUtc("2026-10-02", "10:00", "Asia/Dhaka").toISOString(), "2026-10-02T04:00:00.000Z");
  assert.equal(slotToUtc("2026-10-02", "22:00", "Asia/Dhaka").toISOString(), "2026-10-02T16:00:00.000Z");
});

test("assignSlots keys slots by post_number", () => {
  const posts = today.posts.filter((p) => p.post_number !== 2);
  const slots = assignSlots("2026-10-02", posts, { postTimes: ["10:00", "13:00", "16:00", "19:00", "22:00"], timezone: "Asia/Dhaka" });
  assert.deepEqual(slots.map((s) => s.slot), ["10:00", "16:00", "19:00", "22:00"]);
});

test("buildPostText stays within Instagram's caption limit", () => {
  const long = { ...today.posts[0], caption: "x".repeat(3000) };
  assert.ok(buildPostText(long).length <= 2200);
});

test("splitSlides parses carousel slides", () => {
  assert.equal(splitSlides(today.posts[0].script_or_slide_content).length, 5);
});

test("insights reward winners, demote losers, and rotate pillars", () => {
  const now = DateTime.fromISO("2026-10-02T00:00:00Z");
  const mk = (date, n, pillar, topic, score) => ({
    id: `${date}-${n}`, date, post_number: n, content_pillar: pillar, topic, post_type: "carousel",
    hook_style: "Curiosity", hook_english: `hook ${topic}`, score,
  });
  const history = [
    mk("2026-09-25", 1, "Myth vs Fact", "Myths about periods", 90),
    mk("2026-09-25", 2, "Myth vs Fact", "Myths about pregnancy diet", 80),
    mk("2026-09-26", 1, "Preventive Tips", "Pap smear basics", 10),
    mk("2026-09-26", 2, "Education", "What is the cervix", 30),
    mk("2026-09-27", 1, "Hormonal Health", "Thyroid and periods", 35),
    mk("2026-10-01", 1, "Pregnancy Care", "Hydration in pregnancy", 32),
  ];
  const insights = computeInsights(history, { now });
  assert.equal(insights.winningTopics[0].topic, "Myths about periods");
  assert.ok(insights.losingTopics.some((t) => t.topic === "Pap smear basics"));
  assert.ok(insights.recentTopics.includes("Hydration in pregnancy"));
  const plan = planPillars(insights);
  assert.equal(plan.length, 5);
  assert.ok(plan.includes("Myth vs Fact"));
  assert.ok(plan.includes("Early Warning Signs")); // never used -> rotation bonus
  assert.ok(!plan.includes("Pregnancy Care")); // used yesterday, average score
});

test("engagementScore normalises by reach when available", () => {
  assert.equal(engagementScore({ likes: 10, comments: 2, shares: 1, saves: 1, clicks: 0, reach: 0 }), 24);
  assert.equal(engagementScore({ likes: 10, comments: 2, shares: 1, saves: 1, clicks: 0, reach: 1000 }), 24);
});
