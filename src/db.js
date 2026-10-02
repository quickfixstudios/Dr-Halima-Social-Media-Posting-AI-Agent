import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Minimal JSON-file database (data/db.json). Swap for Postgres/Mongo/Airtable by
 * re-implementing these functions with the same signatures (see README "Scaling").
 *
 * {
 *   posts:       PostRecord[]          // daily_batch item + { date, status, scheduled_at, images, image_urls, buffer_updates, ... }
 *   performance: PerformanceRecord[]   // { post_id, likes, comments, shares, saves, engagement_score }
 *   runs:        RunRecord[]           // audit log of pipeline runs
 * }
 */
const EMPTY = { posts: [], performance: [], runs: [] };

function load() {
  if (!fs.existsSync(config.paths.db)) return structuredClone(EMPTY);
  return { ...structuredClone(EMPTY), ...JSON.parse(fs.readFileSync(config.paths.db, "utf8")) };
}

function save(db) {
  fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });
  const tmp = `${config.paths.db}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, config.paths.db); // atomic replace
}

export function upsertPosts(date, posts) {
  const db = load();
  for (const post of posts) {
    const existing = db.posts.find((p) => p.id === post.id);
    if (existing) Object.assign(existing, post);
    else db.posts.push({ date, status: "generated", buffer_updates: [], images: [], image_urls: [], ...post });
  }
  save(db);
  return db.posts.filter((p) => p.date === date);
}

export function updatePost(id, patch) {
  const db = load();
  const post = db.posts.find((p) => p.id === id);
  if (!post) throw new Error(`Post ${id} not found`);
  Object.assign(post, patch);
  save(db);
  return post;
}

export function getPost(id) {
  return load().posts.find((p) => p.id === id);
}

export function getPostsByDate(date) {
  return load().posts.filter((p) => p.date === date);
}

export function getAllPosts() {
  return load().posts;
}

export function upsertPerformance(record) {
  const db = load();
  const i = db.performance.findIndex((r) => r.post_id === record.post_id);
  if (i >= 0) db.performance[i] = record;
  else db.performance.push(record);
  save(db);
}

export function getPerformance() {
  return load().performance;
}

export function recordRun(run) {
  const db = load();
  db.runs.push({ ...run, at: new Date().toISOString() });
  save(db);
}
