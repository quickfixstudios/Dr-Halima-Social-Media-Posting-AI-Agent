#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { imagingConfig } from "../config.js";
import { createImageJob, runAction, listJobs, openStore } from "./pipeline.js";
import { CATEGORIES } from "./categories.js";
import { REASONS } from "./regenerate.js";
import { ImageError, classifyError } from "./errors.js";
import { NO_PICTURE_LAYOUTS } from "./overlay/layouts.js";

const HELP = `
Dr. Halima image pipeline — commands (run inside the backend folder)

  Make images
    npm run image -- --post sample-01 --dry-run          preview only, no OpenAI cost
    npm run image -- --post sample-01                    generate for real (costs 1 image)
    npm run image -- --post sample-01 --concepts 3       3 creative directions to choose from
    npm run image -- --post path/to/post.json --type myth_vs_fact --aspect 1:1
    npm run image -- --samples                           dry-run every sample post
    npm run image -- --post sample-01 --force            re-run a BLOCKED / FAILED / REJECTED post

  Review
    npm run image -- --list [--status IMAGE_REVIEW_PENDING]
    npm run image -- --show sample-01
    npm run image -- --approve sample-01 [--by "Sabir"] [--candidate c2]
    npm run image -- --reject sample-01 --note "not suitable"
    npm run image -- --regenerate sample-01 --reason face_looks_fake [--note "..."]
    npm run image -- --edit-prompt sample-01 --prompt "..."
    npm run image -- --edit-headline sample-01 --headline "..."
    npm run image -- --change-type sample-01 --type educational_infographic
    npm run image -- --select sample-01 --candidate c2

  Publish
    npm run image -- --send sample-01                    send the approved post to Make.com
    npm run image -- --published sample-01 --fb-post-id 123_456

  Info
    npm run image -- --types        all image types
    npm run image -- --reasons      all regeneration reasons
    npm run image -- --usage        generations and cost today / this month

  Options: --business <id> (default ${imagingConfig().defaultBusiness}) · --json (machine-readable output)
`;

const { values: a } = parseArgs({
  options: {
    post: { type: "string" },
    business: { type: "string" },
    "dry-run": { type: "boolean" },
    type: { type: "string" },
    aspect: { type: "string" },
    concepts: { type: "string" },
    "text-mode": { type: "string" },
    force: { type: "boolean" },
    samples: { type: "boolean" },
    list: { type: "boolean" },
    status: { type: "string" },
    show: { type: "string" },
    approve: { type: "string" },
    reject: { type: "string" },
    regenerate: { type: "string" },
    "edit-prompt": { type: "string" },
    "edit-headline": { type: "string" },
    "change-type": { type: "string" },
    select: { type: "string" },
    send: { type: "string" },
    published: { type: "string" },
    unapprove: { type: "string" },
    reason: { type: "string" },
    note: { type: "string" },
    by: { type: "string" },
    candidate: { type: "string" },
    prompt: { type: "string" },
    headline: { type: "string" },
    "fb-post-id": { type: "string" },
    types: { type: "boolean" },
    reasons: { type: "boolean" },
    usage: { type: "boolean" },
    json: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

const cfg = imagingConfig();
const business = a.business || cfg.defaultBusiness;
const print = (obj) => console.log(a.json ? JSON.stringify(obj, null, 2) : obj);

/** --post accepts a file path, or a post id searched for in posts/<business>/ (including samples/). */
function readPost(ref) {
  const candidates = [ref, path.resolve(ref), path.join(cfg.postsDir, business, `${ref}.json`)];
  for (const f of candidates) if (fs.existsSync(f) && fs.statSync(f).isFile()) return JSON.parse(fs.readFileSync(f, "utf8"));
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".json") ? [path.join(dir, e.name)] : [])) : []);
  for (const f of walk(path.join(cfg.postsDir, business))) {
    const json = JSON.parse(fs.readFileSync(f, "utf8"));
    if (json.post_id === ref || json.id === ref || path.basename(f, ".json") === ref) return json;
  }
  throw new ImageError("POST_FILE_NOT_FOUND", `Could not find post "${ref}" (looked for a file and in ${path.join(cfg.postsDir, business)})`);
}

function showDry(r) {
  console.log(`\n── DRY RUN: ${r.post_id} (${r.business}) — no OpenAI credits used ──`);
  if (r.content_safety.length) console.log("Content safety:", r.content_safety.map((i) => `${i.blocking ? "BLOCK" : "warn"} ${i.rule} "${i.match}"`).join("; "));
  for (const [i, c] of r.concepts.entries()) {
    console.log(`\nConcept ${i + 1}: ${c.label}${c.concept_mode && c.concept_mode !== "photo" ? ` (${c.concept_mode})` : ""}  [rank ${c.rank_score}]`);
    console.log(`  Why: ${c.reasons.join(", ") || "default"}`);
    console.log(`  Layout: ${c.layout} · Final size: ${c.output_size.width}×${c.output_size.height} · AI picture size: ${c.generation_size ?? (NO_PICTURE_LAYOUTS.has(c.layout) ? "none — designed infographic, no cost" : "none — real photo")}`);
    console.log(`  Text on image:\n    ${c.overlay_text.join("\n    ")}`);
    if (c.flags.length) console.log(`  Notes:\n    ${c.flags.map((f) => f.message).join("\n    ")}`);
    if (c.halts.length) console.log(`  BLOCKED:\n    ${c.halts.map((h) => h.message).join("\n    ")}`);
    if (c.checklist) console.log(`  Checklist: ${c.checklist.status}${c.checklist.notes.length ? ` — ${c.checklist.notes.join(" ")}` : ""}`);
    if (c.preview_files.length) console.log(`  Preview: ${c.preview_files.join(", ")}`);
    console.log(`  Prompt:\n    ${c.prompt.split("\n").join("\n    ")}`);
  }
  console.log(`\nWould generate: ${r.estimated_generations} image(s) → ${r.expected_output_dir}${r.blocked ? "\nResult: BLOCKED — fix the issues above first." : ""}\n`);
}

function showJob(meta) {
  const c = meta.candidates.find((x) => x.id === meta.selected) ?? meta.candidates.at(-1);
  console.log(`\n${meta.post_id} — ${meta.status}`);
  console.log(`Topic: ${meta.content.topic}\nHook: ${meta.content.hook}`);
  if (meta.blocked?.length) console.log(`Blocked: ${meta.blocked.map((b) => b.message).join(" | ")}`);
  for (const x of meta.candidates) {
    const f = x.finals.at(-1);
    console.log(`  ${x.id === meta.selected ? "▶" : " "} ${x.id} ${x.visual_type}${x.concept_mode ? ` (${x.concept_mode})` : ""} — ${x.status}${f ? ` — ${f.files.join(", ")} — checklist ${f.checklist.status}` : ""}${x.error ? ` — ${x.error.message}` : ""}`);
  }
  if (c) console.log(`Headline: ${c.brief.text.headline}\nCTA: ${c.brief.text.cta || "—"}\nCost: ${meta.cost ? `$${meta.cost.total_usd}${meta.cost.unknown ? ` + ${meta.cost.unknown} image(s) with unknown price` : ""}` : "—"}`);
  console.log("");
}

async function main() {
  if (a.help || process.argv.length <= 2) return console.log(HELP);
  if (a.types) return CATEGORIES.forEach((c) => console.log(`${c.id.padEnd(24)} ${c.label} (layout: ${c.layout})`));
  if (a.reasons) return Object.entries(REASONS).forEach(([k, r]) => console.log(`${k.padEnd(34)} ${r.label} — ${r.scope === "overlay" ? "redraws text only (free)" : "new picture (1 generation)"}`));
  if (a.usage) {
    const { ledger } = openStore(business);
    const s = ledger.summary();
    return print({ today: s.today, month: s.month_total, limits: cfg.limits });
  }
  if (a.samples) {
    const dir = path.join(cfg.postsDir, business, "samples");
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
      const r = await createImageJob({ businessId: business, post: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), options: { dryRun: true } });
      a.json ? print(r) : showDry(r);
    }
    return;
  }
  if (a.post) {
    const r = await createImageJob({
      businessId: business,
      post: readPost(a.post),
      options: { dryRun: a["dry-run"] || undefined, visualType: a.type, aspect: a.aspect, concepts: a.concepts, textMode: a["text-mode"], force: a.force },
    });
    return r.dry_run && !a.json ? showDry(r) : print(r);
  }
  if (a.list) {
    const jobs = listJobs({ businessId: business, status: a.status });
    if (a.json) return print(jobs.map((m) => ({ post_id: m.post_id, status: m.status, updated_at: m.updated_at })));
    if (!jobs.length) return console.log("No image jobs yet.");
    return jobs.forEach((m) => console.log(`${m.post_id.padEnd(22)} ${m.status.padEnd(22)} ${m.content?.topic ?? ""}`));
  }
  if (a.show) {
    const { store } = openStore(business);
    const meta = store.load(a.show);
    return a.json ? print(meta) : showJob(meta);
  }
  const action =
    (a.approve && ["approve", a.approve]) ||
    (a.reject && ["reject", a.reject]) ||
    (a.regenerate && ["regenerate", a.regenerate]) ||
    (a["edit-prompt"] && ["edit_prompt", a["edit-prompt"]]) ||
    (a["edit-headline"] && ["edit_headline", a["edit-headline"]]) ||
    (a["change-type"] && ["change_type", a["change-type"]]) ||
    (a.select && ["select", a.select]) ||
    (a.send && ["send", a.send]) ||
    (a.published && ["published", a.published]) ||
    (a.unapprove && ["unapprove", a.unapprove]);
  if (action) {
    const r = await runAction({
      businessId: business,
      postId: action[1],
      action: action[0],
      params: { reason: a.reason, note: a.note, by: a.by, candidate: a.candidate, prompt: a.prompt, headline: a.headline, visual_type: a.type, fb_post_id: a["fb-post-id"] },
    });
    if (a.json) return print(r);
    const { store } = openStore(business);
    return showJob(store.load(action[1]));
  }
  console.log(HELP);
}

main().catch((err) => {
  const { code, message } = classifyError(err);
  console.error(`[IMAGE ERROR] ${message} (${code})`);
  process.exitCode = 1;
});
