#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { imagingConfig } from "../config.js";
import { generatePost, CONTENT_TYPES } from "./postGenerator.js";

const HELP = `
Write draft posts with the same rules as the live Make scenario (pure Bangla, 7 content types).

  npm run content -- --type myth_vs_fact          one draft of a chosen type
  npm run content -- --count 3                    three drafts, random types
  npm run content -- --approve <post_id>          mark a draft approved (then: npm run image -- --post <post_id>)
  npm run content -- --types                      list content types

Drafts are saved in posts/<business>/drafts/. Read them before approving.
`;
const { values: a } = parseArgs({ options: { type: { type: "string" }, count: { type: "string" }, approve: { type: "string" }, by: { type: "string" }, business: { type: "string" }, types: { type: "boolean" }, help: { type: "boolean", short: "h" } } });
const cfg = imagingConfig();
const business = a.business || cfg.defaultBusiness;
const dir = path.join(cfg.postsDir, business, "drafts");

async function main() {
  if (a.help) return console.log(HELP);
  if (a.types) return Object.entries(CONTENT_TYPES).forEach(([k, v]) => console.log(`${k.padEnd(22)} ${v.label}`));
  if (a.approve) {
    const file = path.join(dir, `${path.basename(a.approve)}.json`);
    if (!fs.existsSync(file)) throw new Error(`No draft ${file}`);
    const post = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(post, { content_status: "approved", approved_by: a.by || "reviewer", approved_at: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(post, null, 2) + "\n");
    return console.log(`[CONTENT] Approved ${post.post_id}. Next: npm run image -- --post ${post.post_id} --dry-run`);
  }
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < Number(a.count || 1); i++) {
    const post = await generatePost({ type: a.type, business });
    const file = path.join(dir, `${post.post_id}.json`);
    fs.writeFileSync(file, JSON.stringify(post, null, 2) + "\n", { flag: "wx" });
    console.log(`\n[CONTENT] ${post.generator.content_type_label} → ${file}\nHook: ${post.hook}\n\n${post.caption}\n${post.hashtags}`);
    for (const w of post.generator.warnings) console.log(`[CONTENT WARNING] ${w}`);
    console.log(`\nApprove with: npm run content -- --approve ${post.post_id}`);
  }
}
main().catch((err) => {
  console.error(`[CONTENT ERROR] ${err.message}`);
  process.exitCode = 1;
});
