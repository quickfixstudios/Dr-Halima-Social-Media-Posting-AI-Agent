import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Minimal JSON-file database (data/db.json). Swap for Postgres/Mongo/Airtable by
 * re-implementing these functions with the same signatures.
 *
 * Shape: { posts: PostRecord[], runs: RunRecord[] }
 * PostRecord = generated post fields + { id, date, status, scheduled_at, images, media_urls,
 *              buffer_updates: [{ profile_id, update_id }], metrics, score }
 */
const EMPTY = { posts: [], runs: [] };

function load() {
  if (!fs.existsSync(config.paths.db)) return structuredClone(EMPTY);
  return JSON.parse(fs.readFileSync(config.paths.db, "utf8"));
}

function save(db) {
  fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });
  const tmp = `${config.paths.db}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, config.paths.db); // atomic replace
}

export function postId(date, postNumber) {
  return `${date}-${postNumber}`;
}

export function upsertPosts(date, posts) {
  const db = load();
  for (const post of posts) {
    const id = postId(date, post.post_number);
    const existing = db.posts.find((p) => p.id === id);
    if (existing) Object.assign(existing, post);
    else db.posts.push({ id, date, status: "generated", buffer_updates: [], metrics: null, score: null, ...post });
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

export function getPostsByDate(date) {
  return load().posts.filter((p) => p.date === date);
}

export function getAllPosts() {
  return load().posts;
}

export function recordRun(run) {
  const db = load();
  db.runs.push({ ...run, at: new Date().toISOString() });
  save(db);
}
