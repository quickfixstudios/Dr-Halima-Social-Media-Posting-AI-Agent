import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { LEARNING, toPerformanceRecord } from "./engagement.js";
import { DailyBatchSchema, PILLARS, HOOK_PATTERNS, CONTENT_GOALS, SLOTS } from "./schema.js";
import { DISCLAIMER } from "./safety.js";

const SAMPLE_CODE_FILES = [
  "src/generateContent.js",
  "src/generateImage.js",
  "src/mediaHost.js",
  "src/buffer.js",
  "src/schedulePosts.js",
  "src/engagement.js",
  "src/pipeline.js",
  "src/index.js",
  "src/safety.js",
  "src/alerts.js",
  "src/db.js",
  "src/utils/retry.js",
];

async function envVars() {
  const text = await fs.readFile(".env.example", "utf8");
  return Object.fromEntries(
    text
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => {
        const [k, ...v] = l.split("=");
        return [k, v.join("=") || "<required>"];
      }),
  );
}

function automationSystem(env, code) {
  const slots = Object.fromEntries(SLOTS.map((s, i) => [s, config.schedule.postTimes[i]]));
  return {
    runtime: "Node.js >= 20 (ES modules)",
    dependencies: ["@anthropic-ai/sdk", "openai", "zod", "node-cron", "luxon", "dotenv"],
    architecture: {
      overview:
        "A daily agentic pipeline. A learning step plans the 5 slots (pillar, format, hook pattern, goal); Claude writes the batch as schema-validated JSON; a compliance gate holds unsafe posts; gpt-image-1 renders visuals, which are uploaded to get public URLs; Buffer queues each post for its slot; slot watchdog crons guarantee delivery; a nightly sync turns engagement into performance records that steer the next plan.",
      components: [
        { name: "Planner", file: "src/engagement.js#planDay", responsibility: "STEP 1/3/4: choose pillar, post_type, hook_pattern, content_goal per slot from learned performance + rotation" },
        { name: "Content generator", file: "src/generateContent.js#generateContent", responsibility: "STEP 2 + copy: Claude structured output (JSON schema), self-revision on format/safety issues" },
        { name: "Compliance gate", file: "src/safety.js", responsibility: "Blocks diagnosis, prescribing, dosing, absolute claims, fear language, sensitive visuals; enforces disclaimer + save/share CTA" },
        { name: "Image generator", file: "src/generateImage.js#generateImage", responsibility: "gpt-image-1 from visual_prompt → PNG → public image URL" },
        { name: "Media host", file: "src/mediaHost.js#publishMedia", responsibility: "Cloudinary unsigned upload (or static CDN) so Buffer can fetch media" },
        { name: "Publisher", file: "src/buffer.js#postToBuffer", responsibility: "Buffer API: schedule at slot time or publish now" },
        { name: "Scheduler", file: "src/schedulePosts.js + src/index.js#cron", responsibility: "Daily generation cron, 5 slot watchdog crons, nightly engagement sync" },
        { name: "Storage", file: "src/db.js", responsibility: "posts, image URLs, Buffer update IDs, performance records, run log" },
        { name: "Alerts", file: "src/alerts.js#sendAlert", responsibility: "Webhook alerts (Slack/Discord) on any failure or held post" },
      ],
      data_flow: [
        "06:15 cron → computeInsights(history, performance)",
        "planDay(insights) → 5-slot plan",
        "generateContent({ plan, insights, topicSuggestions }) → daily_batch JSON (validated)",
        "checkPostSafety → needs_review + alert for any flagged post",
        "generatePostImages → images[] + image_urls[] saved on the post",
        "schedulePosts → postToBuffer(scheduled_at = slot time in Asia/Dhaka) → buffer_updates saved",
        "slot time + 2 min → publishDueSlot(slot): publish now if not already queued, else alert",
        "23:30 cron → syncEngagement → performance records → next morning's insights",
      ],
      post_status_lifecycle: ["generated", "images_ready", "scheduled", "published", "awaiting_video", "needs_review", "image_failed", "schedule_failed", "dry_run"],
    },
    functions: {
      generateContent: {
        file: "src/generateContent.js",
        signature: "generateContent({ date, plan, insights, topicSuggestions }) => Promise<{ posts, flagged }>",
        api: "Claude Messages API (streaming), model claude-opus-5-5, adaptive thinking, output_config.format = JSON schema, server-side refusal fallback, cached system prompt",
        request_example: {
          model: config.claude.model,
          max_tokens: 48000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          thinking: { type: "adaptive" },
          output_config: { effort: config.claude.effort, format: { type: "json_schema", schema: "<dailyBatchJsonSchema>" } },
          system: [{ type: "text", text: "<SYSTEM_PROMPT>", cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: "Create Dr. Halima's daily batch for 2026-10-02 ... SLOT PLAN ..." }],
        },
      },
      generateImage: {
        file: "src/generateImage.js",
        signature: "generateImage({ prompt, postType, fileName }) => Promise<{ path, url }>",
        api: "OpenAI Images API, model gpt-image-1 (b64 output) → saved PNG → Cloudinary URL",
        request_example: { model: config.openai.imageModel, prompt: "<visual_prompt> + style guard", size: "1024x1536", quality: config.openai.quality, n: 1 },
        sizes: { reel: "1024x1536", carousel: "1024x1536", image: "1024x1024" },
      },
      postToBuffer: {
        file: "src/buffer.js",
        signature: "postToBuffer(post, { scheduledAt, mediaUrls, videoUrl, now }) => Promise<{ profile_id, update_id }[]>",
        api: "POST https://api.bufferapp.com/1/updates/create.json (form-encoded)",
        request_example: {
          "profile_ids[]": ["<BUFFER_PROFILE_ID>"],
          text: "<hook>\n\n<caption>\n\n<hashtags>",
          "media[photo]": "https://res.cloudinary.com/<cloud>/image/upload/dr-halima/2026-10-02-1-cover.png",
          scheduled_at: "2026-10-02T04:00:00.000Z",
          shorten: "false",
        },
      },
      scheduler: {
        file: "src/schedulePosts.js",
        signature: "schedulePosts(date, posts, { dryRun }) / publishDueSlot(slot) / startSlotCrons()",
      },
    },
    scheduler: {
      timezone: config.schedule.timezone,
      slots,
      cron_jobs: [
        { name: "daily-generate", cron: config.schedule.generateCron, action: "runDaily(): plan → generate → images → queue on Buffer" },
        ...SLOTS.map((s, i) => {
          const [h, m] = config.schedule.postTimes[i].split(":").map(Number);
          return { name: `watchdog-${s}`, cron: `${(m + 2) % 60} ${h} * * *`, action: `publishDueSlot("${s}"): publish now if not queued; alert if empty` };
        }),
        { name: "engagement-sync", cron: config.schedule.engagementCron, action: "syncEngagement(): Buffer stats → performance records" },
      ],
      reels: "REELS_MODE=await_video holds reels until `attach-video <postId> <url>`; REELS_MODE=cover_image posts the cover image as a teaser.",
    },
    storage: {
      engine: "JSON file (data/db.json), atomic writes; swap-in interface for Postgres/Mongo",
      collections: {
        posts: "daily_batch item + { date, status, scheduled_at, images[], image_urls[], video_url, buffer_updates[{profile_id, update_id}], metrics, safety_issues, last_error }",
        performance: "{ post_id, likes, comments, shares, saves, engagement_score }",
        runs: "{ date, ok, dryRun, results, error, ms, at }",
      },
      files: { batches: "content/<date>.json", media: "data/media/<postId>-cover.png", logs: "logs/<date>.log (JSON lines)" },
    },
    error_handling: {
      retries: "Exponential backoff + jitter for 408/409/429/5xx/network (utils/retry.js); SDK-level retries for Claude (3) and OpenAI (2); no retry on 400/401 or image content-policy rejections",
      generation: "Up to 3 Claude attempts; format or safety issues are sent back for a targeted rewrite of only the failing posts; refusals use the server-side fallback model",
      idempotency: "Each step records status per post; re-running a date resumes where it failed and never double-posts",
      logging: "Structured JSON lines to stdout + logs/<date>.log with scope, message and metadata",
      alerts: "sendAlert() → ALERT_WEBHOOK_URL on: daily run failure, image failure, Buffer failure, empty slot, post held for compliance, engagement sync failure, unhandled errors",
      compliance_gate: `Posts failing checks are status needs_review and never auto-published. Disclaimer enforced: "${DISCLAIMER}"`,
    },
    environment_variables: env,
    project_structure: [
      "content/<date>.json — daily_batch",
      "deliverables/<date>.json — this document",
      "src/config.js · src/logger.js · src/alerts.js · src/db.js",
      "src/schema.js — zod + JSON schema for the batch and performance records",
      "src/prompts.js · src/topicBank.js · src/safety.js",
      "src/generateContent.js · src/generateImage.js · src/mediaHost.js · src/buffer.js",
      "src/schedulePosts.js · src/engagement.js · src/pipeline.js · src/index.js",
      "test/*.test.js",
    ],
    commands: {
      "npm start": "long-running scheduler (all crons)",
      "node src/index.js run [--date=] [--dry-run] [--skip-images]": "one daily run",
      "node src/index.js import content/2026-10-02.json": "schedule a pre-written batch",
      "node src/index.js attach-video <postId> <url>": "release a held reel",
      "node src/index.js insights": "learned patterns + tomorrow's plan",
      "node src/index.js deliverable": "rebuild this JSON",
    },
    scaling: [
      "Storage: move db.js to Postgres (posts, performance, runs tables; JSONB for batch items).",
      "Queue: run image rendering and Buffer calls as BullMQ/SQS jobs so slow APIs don't block the daily run.",
      "Multi-brand: key everything by brand_id; one config + topic bank + Buffer profile set per brand.",
      "Cost: use the Message Batches API to pre-generate a week of batches overnight at 50% cost; keep the system prompt cached.",
      "Video: plug a text-to-video or template renderer (e.g. Remotion) into the reel step and set video_url automatically.",
      "Observability: ship logs/*.log to a log platform; alert on runs.ok=false and on slot gaps.",
    ],
    sample_code: code,
  };
}

function learningSystem() {
  const example = toPerformanceRecord("2026-10-02-1", { likes: 412, comments: 37, shares: 96, saves: 210, reach: 9800 });
  return {
    objective: "Increase the probability of winning patterns (hooks, topics, content types, goals) and reduce low performers, without ever repeating content.",
    signals: ["likes", "comments", "shares", "saves", "reach (for normalisation)"],
    performance_record_format: { post_id: "", likes: 0, comments: 0, shares: 0, saves: 0, engagement_score: 0 },
    example_performance_record: example,
    engagement_score: {
      formula: "(likes×1 + comments×3 + shares×4 + saves×4) / reach × 1000; raw weighted sum when reach is unavailable",
      weights: LEARNING.weights,
      why: "Shares and saves signal trust and reach the strongest; normalising by reach compares posts fairly across days.",
      relative_performance: "perf = engagement_score / median(engagement_score) — 1.0 is a typical post",
    },
    pattern_detection: {
      dimensions: ["content_pillar", "post_type", "hook_pattern", "content_goal", "scheduled_slot", "topic", "hook_english"],
      smoothing: `Bayesian average per group: (Σperf + ${LEARNING.smoothingK}) / (n + ${LEARNING.smoothingK}) so one viral post can't dominate`,
      winners: `perf ≥ ${LEARNING.winThreshold} → winningTopics (fresh angles requested) and winningHooks (structure reused, wording never)`,
      losers: `perf ≤ ${LEARNING.loseThreshold} → losingTopics (blocked from prompts and topic suggestions)`,
    },
    decision_policy: {
      step1_pillar: `Sample 5 of ${PILLARS.length} pillars without replacement with weight = (pillar score × (1 + ${LEARNING.recencyBonusPerDay} × days since last used, max 7))^${LEARNING.temperature}. Seeded by date for reproducibility.`,
      step2_topic: "Claude picks a globally high-search, practical topic; topic bank suggestions exclude recent and low-performing topics.",
      step3_hook: `Each of ${HOOK_PATTERNS.join(", ")} used exactly once per day; natural pillar matches first (Myth vs Fact→Myth-breaking, Warning/Awareness→Gentle warning, Emotional Support→Reassurance), the rest sampled by hook-pattern score.`,
      step4_goal: `Every day includes ${CONTENT_GOALS.join(", ")}; pillar affinity sets the default and the weakest-performing duplicate goal is swapped to fill gaps.`,
      formats: `Reels fixed at ${LEARNING.reelSlots.join(" and ")}; other slots choose carousel vs image with P(carousel) = carousel score / (carousel + image score), clamped 0.34–0.85, at least one carousel.`,
      slotting: "Emotional Support goes to slot5 (10 PM); the highest-weight pillars take the reel slots.",
      exploration: "Weighted sampling (not argmax) keeps a non-zero chance for every pillar and pattern, so new winners can be discovered.",
    },
    repetition_guard: {
      topics: `No topic from the last ${LEARNING.topicCooldownDays} days (prompt + topic bank filter + batch uniqueness check)`,
      hooks: `No hook resembling one from the last ${LEARNING.hookCooldownDays} days`,
      within_day: "Unique topic, pillar, hook pattern and slot per post (schema-enforced)",
    },
    data_flow: [
      "Buffer update stats (per profile) → summed per post",
      "toPerformanceRecord() → performance collection",
      "computeInsights(posts, performance) → group scores, winners, losers, cooldown lists",
      "planDay(insights) → slot plan (STEP 1, 3, 4)",
      "buildUserPrompt(plan, insights, topicSuggestions) → Claude (STEP 2 + copy)",
      "new batch → published → measured → loop",
    ],
    cold_start: "With no data every score is 1.0, so planning is driven by rotation and variety until engagement arrives (~1 week).",
    tunables: LEARNING,
  };
}

/** Build deliverables/<date>.json = { daily_batch, automation_system, learning_system }. */
export async function buildDeliverable(date) {
  const batchFile = path.join(config.paths.content, `${date}.json`);
  const { daily_batch } = DailyBatchSchema.parse(JSON.parse(await fs.readFile(batchFile, "utf8")));
  const code = {};
  for (const file of SAMPLE_CODE_FILES) code[file] = await fs.readFile(file, "utf8");

  const deliverable = { daily_batch, automation_system: automationSystem(await envVars(), code), learning_system: learningSystem() };
  const out = path.resolve("deliverables", `${date}.json`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, JSON.stringify(deliverable, null, 2));
  return out;
}
