#!/usr/bin/env node
import cron from "node-cron";
import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { runDaily, importContent } from "./pipeline.js";
import { syncEngagement, currentInsights, planDay, topicSuggestions } from "./engagement.js";
import { getPost, getPerformance, updatePost } from "./db.js";
import { scheduleOne, startSlotCrons, publishDueSlot } from "./schedulePosts.js";
import { listProfiles } from "./buffer.js";
import { sendAlert } from "./alerts.js";
import { buildDeliverable } from "./buildDeliverable.js";
import { todayIn } from "./utils/time.js";

const log = createLogger("cli");
const [command = "help", ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const positional = args.filter((a) => !a.startsWith("--"));

const commands = {
  // Generate + render + schedule today's (or --date=YYYY-MM-DD) batch.
  run: () => runDaily({ date: option("date"), dryRun: flag("dry-run"), skipImages: flag("skip-images") }),

  // Import content/<date>.json, then render + schedule it.
  import: async () => {
    if (!positional[0]) throw new Error("Usage: import <content/YYYY-MM-DD.json> [--dry-run] [--skip-images]");
    const date = await importContent(positional[0]);
    return runDaily({ date, dryRun: flag("dry-run"), skipImages: flag("skip-images") });
  },

  // Attach a recorded/rendered video to a held reel and schedule it in its slot.
  "attach-video": async () => {
    const [postId, videoUrl] = positional;
    const post = getPost(postId);
    if (!post || !videoUrl) throw new Error("Usage: attach-video <postId> <publicVideoUrl>");
    const updated = updatePost(postId, { video_url: videoUrl, status: "images_ready" });
    const slotAt = new Date(post.scheduled_at);
    return scheduleOne(updated, slotAt > new Date() ? slotAt : new Date(), { now: slotAt <= new Date() });
  },

  // Manually fire a slot watchdog, e.g. `publish-slot slot3`.
  "publish-slot": () => publishDueSlot(positional[0]),

  sync: () => syncEngagement(),

  performance: async () => console.log(JSON.stringify(getPerformance(), null, 2)),

  insights: async () => {
    const insights = currentInsights();
    const plan = planDay(insights, { date: option("date") ?? todayIn(config.schedule.timezone) });
    console.log(JSON.stringify({ insights, nextPlan: plan, topicSuggestions: topicSuggestions(insights, plan) }, null, 2));
  },

  // Write deliverables/<date>.json = { daily_batch, automation_system, learning_system }.
  deliverable: async () => console.log(await buildDeliverable(option("date") ?? todayIn(config.schedule.timezone))),

  profiles: async () => console.log(JSON.stringify(await listProfiles(), null, 2)),

  // Long-running scheduler.
  cron: async () => {
    const tz = { timezone: config.schedule.timezone };
    cron.schedule(config.schedule.generateCron, () => runDaily().catch(() => {}), tz);
    cron.schedule(config.schedule.engagementCron, () => syncEngagement().catch((e) => sendAlert("Engagement sync failed", { error: e.message })), tz);
    startSlotCrons();
    log.info("Scheduler running", { ...config.schedule });
    await new Promise(() => {}); // keep alive
  },

  help: async () =>
    console.log(`Usage: node src/index.js <command>
  run [--date=YYYY-MM-DD] [--dry-run] [--skip-images]   plan, generate, render and schedule a day
  import <file.json> [--dry-run] [--skip-images]        import a pre-written batch and schedule it
  attach-video <postId> <videoUrl>                      schedule a held reel once its video exists
  publish-slot <slot1..slot5>                           run a slot watchdog now
  sync                                                  pull engagement from Buffer -> performance records
  performance                                           print performance records
  insights [--date=]                                    learned patterns + next slot plan
  deliverable [--date=]                                 build deliverables/<date>.json
  profiles                                              list Buffer profiles
  cron                                                  daily generation + 5 slot watchdogs + nightly sync`),
};

process.on("unhandledRejection", (err) => sendAlert("Unhandled error", { error: String(err?.message ?? err) }));
(commands[command] ?? commands.help)().catch((err) => {
  log.error(`Command "${command}" failed`, errorMeta(err));
  process.exitCode = 1;
});
