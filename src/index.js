#!/usr/bin/env node
import cron from "node-cron";
import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { runDaily, importContent } from "./pipeline.js";
import { syncEngagement, computeInsights, planPillars } from "./engagement.js";
import { getAllPosts, updatePost } from "./db.js";
import { scheduleOne } from "./schedulePosts.js";
import { listProfiles } from "./buffer.js";

const log = createLogger("cli");
const [command = "help", ...args] = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];

const commands = {
  // Generate + render + schedule today's (or --date=YYYY-MM-DD) posts.
  run: () => runDaily({ date: option("date"), dryRun: flag("dry-run"), skipImages: flag("skip-images") }),

  // Import content/<date>.json, then render + schedule it.
  import: async () => {
    const file = args.find((a) => !a.startsWith("--"));
    if (!file) throw new Error("Usage: import <content/YYYY-MM-DD.json> [--dry-run]");
    const date = await importContent(file);
    return runDaily({ date, dryRun: flag("dry-run"), skipImages: flag("skip-images") });
  },

  // Attach a rendered/recorded video to a held reel and schedule it in its slot.
  "attach-video": async () => {
    const [postId, videoUrl] = args;
    const post = getAllPosts().find((p) => p.id === postId);
    if (!post || !videoUrl) throw new Error("Usage: attach-video <postId> <publicVideoUrl>");
    const updated = updatePost(postId, { video_url: videoUrl });
    return scheduleOne(updated, new Date(post.scheduled_at));
  },

  sync: () => syncEngagement(),

  insights: async () => {
    const insights = computeInsights(getAllPosts());
    console.log(JSON.stringify({ ...insights, nextPlan: planPillars(insights) }, null, 2));
  },

  profiles: async () => console.log(JSON.stringify(await listProfiles(), null, 2)),

  // Long-running scheduler: generate every morning, sync engagement every night.
  cron: async () => {
    const opts = { timezone: config.schedule.timezone };
    cron.schedule(config.schedule.generateCron, () => runDaily().catch(() => {}), opts);
    cron.schedule(config.schedule.engagementCron, () => syncEngagement().catch((e) => log.error("sync failed", errorMeta(e))), opts);
    log.info("Scheduler running", { ...config.schedule });
    await new Promise(() => {}); // keep alive
  },

  help: async () =>
    console.log(`Usage: node src/index.js <command>
  run [--date=YYYY-MM-DD] [--dry-run] [--skip-images]   generate, render and schedule a day
  import <file.json> [--dry-run] [--skip-images]        import pre-written content and schedule it
  attach-video <postId> <videoUrl>                      schedule a held reel once its video exists
  sync                                                  pull engagement stats from Buffer
  insights                                              print learned performance + next pillar plan
  profiles                                              list Buffer profiles (to find profile IDs)
  cron                                                  run the daily scheduler`),
};

const handler = commands[command] ?? commands.help;
handler().catch((err) => {
  log.error(`Command "${command}" failed`, errorMeta(err));
  process.exitCode = 1;
});
