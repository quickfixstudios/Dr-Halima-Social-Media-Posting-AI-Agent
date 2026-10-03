import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { DateTime } from "luxon";
import { config, imagingConfig } from "../config.js";
import { loadBrand } from "./brands.js";
import { normalizePost } from "./content.js";
import { rankCategories, buildBrief, briefTextBlocks } from "./decision.js";
import { buildImagePrompt, positivePromptText } from "./promptBuilder.js";
import { scanCopy, scanVisualPrompt, checkOverlayText } from "./safety.js";
import { composeImage, composeCarousel } from "./overlay/layouts.js";
import { graphemeCount } from "./overlay/text.js";
import { generateBackground } from "./generator.js";
import { Ledger, loadPricing, estimateCost, checkBudget } from "./budget.js";
import { AssetStore } from "./assets.js";
import { transition, advance } from "./workflow.js";
import { creativeChecklist } from "./creativeReview.js";
import { getReason } from "./regenerate.js";
import { getCategory } from "./categories.js";
import { shortenText } from "./shorten.js";
import { buildMakePayload, prepareImages, sendToMake } from "./make.js";
import { ImageError, classifyError } from "./errors.js";
import { createImageLog } from "./log.js";
import { checkImageText } from "./textCheck.js";
import { infographicTextLines } from "./infographicPrompt.js";

/**
 * The image pipeline — one approved post in, reviewed images out.
 *
 *   createImageJob()  content → brief(s) → prompt(s) → [dry run: preview only]
 *                     → OpenAI picture → Bangla text overlay → checklist → IMAGE_REVIEW_PENDING
 *   runAction()       what a reviewer does next: approve / reject / regenerate / edit prompt /
 *                     edit headline / change type / choose concept / send to Make / mark published
 *
 * `deps` lets tests replace the OpenAI client, clock, Make webhook and Cloudinary upload.
 */

function resolveDeps(deps = {}) {
  const cfg = { ...imagingConfig(), ...(deps.cfg ?? {}) };
  return {
    cfg,
    client: deps.client,
    sleep: deps.sleep,
    fetchImpl: deps.fetchImpl ?? fetch,
    upload: deps.upload,
    shorten: deps.shorten ?? shortenText,
    // Reads AI-drawn Bangla back from the image (tests pass a fake; real runs use the vision model).
    textCheck: deps.textCheck ?? ((buffer, expected, o) => checkImageText(buffer, expected, { ...o, model: cfg.textModel, ...(deps.client && { client: () => deps.client }) })),
    env: deps.env ?? process.env,
    timezone: config.timezone,
  };
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** Choose 1–4 creative directions: best categories first, then alternative treatments of the best one. */
export function planConcepts(ranking, count, brand) {
  const positive = ranking.filter((r) => r.score > 0 || ranking.length === 1);
  const picks = (positive.length ? positive : ranking.slice(0, 1)).slice(0, count).map((r) => ({ visual_type: r.id, fit_score: r.score, reasons: r.reasons }));
  const top = picks[0];
  const extras = [
    // Alternative treatment: the opposite of the brand's default look.
    ...(brand?.image_style === "illustration" ? [{ ...top, concept_mode: "photo", fit_score: top.fit_score - 1, reasons: [...top.reasons, "alternative treatment: photo"] }] : [{ ...top, concept_mode: "illustration", fit_score: top.fit_score - 1, reasons: [...top.reasons, "alternative treatment: illustration"] }]),
    { visual_type: "doctor_trust", fit_score: top.fit_score - 2, reasons: ["alternative treatment: doctor authority visual"] },
  ];
  for (const e of extras) {
    if (picks.length >= count) break;
    if (getCategory(e.visual_type).visual.mode === "photo" && !picks.some((p) => p.visual_type === e.visual_type && p.concept_mode === e.concept_mode)) picks.push(e);
  }
  return picks.slice(0, count);
}

function applyOverrides(brief, overrides = {}) {
  if (overrides.headline) {
    brief.text.headline = overrides.headline;
    brief.text_origins.headline = "human";
  }
  for (const [k, v] of Object.entries(overrides.derived ?? {})) {
    brief.text[k] = v;
    brief.text_origins[k] = "derived";
  }
  return brief;
}

async function renderFinal(brief, brand, background, photo) {
  if (brief.text_mode === "model") {
    // The AI drew the whole infographic (text included) at the post shape — only resize, no overlay.
    const buf = await sharp(background).resize(brief.output.width, brief.output.height, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
    return { buffers: [buf], reports: [{ layout: "model_text", sizes: {}, blocks: [], graphemes: 0 }] };
  }
  if (brief.layout === "carousel") {
    const slides = await composeCarousel({ background, brief, brand, ...brief.output });
    return { buffers: slides.map((s) => s.buffer), reports: slides.map((s) => s.report) };
  }
  const r = await composeImage({ layout: brief.layout, background, photo, brief, brand, ...brief.output });
  return { buffers: [r.buffer], reports: [r.report] };
}

/**
 * Draw the text on a grey placeholder (free) to find text that does not fit BEFORE paying for a picture.
 * Optionally shortens an over-long headline/subtitle with the text model (marked "derived" for review).
 */
async function previewAndFit(brief, brand, { cfg, shorten, log, allowShorten }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const preview = await renderFinal({ ...brief, text_mode: "overlay" }, brand, null, null);
      return preview;
    } catch (err) {
      if (err.code !== "TEXT_TOO_LONG") throw err;
      const label = err.details?.label;
      const canShorten = allowShorten && cfg.shortenWithLlm && attempt === 0 && ["headline", "subtitle"].includes(label) && brief.text_origins[label] !== "human";
      if (!canShorten) {
        brief.halts.push({ code: "text_too_long", message: `${err.message}. ${err.details?.recommend === "carousel" ? "Recommendation: turn this post into a carousel (content_type \"carousel\")." : "Shorten the text, or set IMAGE_TEXT_SHORTEN_WITH_LLM=true."}` });
        return null;
      }
      const target = Math.round(graphemeCount(brief.text[label]) * 0.7);
      log.step(`${label} too long — asking the text model to shorten it to ≤${target} characters (marked for human check)`);
      brief.text[label] = await shorten(brief.text[label], target);
      brief.text_origins[label] = "derived";
      brief.flags.push({ code: "text_shortened", message: `${label} was shortened automatically — check it says nothing new.` });
    }
  }
  return null;
}

function costTotals(meta) {
  let usd = 0;
  let unknown = 0;
  for (const c of meta.candidates) for (const g of c.generations) if (g.kind !== "real_photo") g.cost_usd == null ? unknown++ : (usd += g.cost_usd);
  meta.cost = { total_usd: Math.round(usd * 1e5) / 1e5, unknown, note: unknown ? "Some prices are unknown — fill backend/config/image-pricing.json" : "" };
}

function summarize(meta, store) {
  const dir = store ? store.dirFor(meta.post_id) : null;
  return {
    status: meta.status,
    post_id: meta.post_id,
    business: meta.business,
    folder: dir,
    selected: meta.selected,
    cost: meta.cost,
    blocked: meta.blocked ?? [],
    candidates: meta.candidates.map((c) => ({
      id: c.id,
      visual_type: c.visual_type,
      concept_mode: c.concept_mode ?? null,
      fit_score: c.fit_score,
      status: c.status,
      final_files: c.finals.at(-1)?.files.map((f) => (dir ? path.join(dir, f) : f)) ?? [],
      checklist: c.finals.at(-1)?.checklist ?? null,
      flags: c.brief.flags,
      error: c.error ?? null,
    })),
  };
}

/** Create the brief + prompt for one concept and test-fit its text. Pure apart from the optional shorten call. */
async function prepareConcept(concept, post, brand, options, d, log, index) {
  const brief = buildBrief(post, brand, concept.visual_type, {
    aspect: options.aspect,
    textMode: options.textMode ?? d.cfg.textMode,
    conceptMode: concept.concept_mode,
    variant: concept.variant ?? 0,
    arbitrarySizes: d.cfg.arbitrarySizes,
  });
  applyOverrides(brief, concept.text_overrides);
  const prompt = buildImagePrompt(brief, brand, { adjustments: concept.adjustments ?? [], promptOverride: concept.prompt_override });
  const promptIssues = scanVisualPrompt(positivePromptText(brief, concept.adjustments ?? [], concept.prompt_override));
  // A brief halted for missing information (statistic, contact details…) has nothing valid to draw yet.
  const preview = brief.halts.length ? null : await previewAndFit(brief, brand, { cfg: d.cfg, shorten: d.shorten, log, allowShorten: !options.dryRun });
  const overlayIssues = checkOverlayText(briefTextBlocks(brief), post, brand);
  const checklist = preview ? creativeChecklist({ brief, report: preview.reports, overlayIssues, brand }) : null;
  const halts = [...brief.halts, ...promptIssues.map((i) => ({ code: "unsafe_visual_prompt", message: `Prompt asks for "${i.match}" — not allowed in medical images.` })), ...overlayIssues.filter((i) => i.blocking).map((i) => ({ code: i.rule, message: `${i.label}: "${i.match}" — ${i.note}` }))];
  log.step(`Concept ${index + 1}: ${getCategory(brief.visual_type).label}${concept.concept_mode ? ` (${concept.concept_mode})` : ""} — layout ${brief.layout}, ${brief.output.width}×${brief.output.height}${brief.generation_size ? `, AI picture ${brief.generation_size}` : ""}`);
  for (const f of brief.flags) log.warn(f.message);
  for (const h of halts) log.error(h.message);
  return { brief, prompt, preview, overlayIssues, checklist, halts };
}

/**
 * Create images for one approved post.
 * @param {object} p
 * @param {string} [p.businessId]
 * @param {object} p.post        raw post object (see posts/dr_halima/samples)
 * @param {object} [p.options]   { dryRun, visualType, aspect, concepts (1-4), textMode, force }
 */
export async function createImageJob({ businessId, post: raw, options = {}, deps = {} }) {
  const d = resolveDeps(deps);
  const brand = loadBrand(businessId || raw?.business || d.cfg.defaultBusiness, { brandsDir: d.cfg.brandsDir });
  const post = normalizePost({ ...raw, business: brand.id, ...(options.visualType && { visual_type: options.visualType }) });
  const log = createImageLog(post.post_id, deps.logSink && { sink: deps.logSink });
  const dryRun = options.dryRun ?? d.cfg.dryRun;
  for (const w of brand.warnings) log.warn(w);

  if (brand.safety.require_content_approval && post.content_status !== "approved") {
    throw new ImageError("CONTENT_NOT_APPROVED", `Post ${post.post_id} has content_status "${post.content_status}". Images are only made for approved content (content_status: "approved").`);
  }
  const copyIssues = scanCopy(post, brand);
  for (const i of copyIssues) log.error(`Content safety: ${i.rule} "${i.match}"${i.note ? ` — ${i.note}` : ""}`);

  const ranking = rankCategories(post, brand);
  log.step(`Selected type: ${getCategory(ranking[0].id).label} (score ${ranking[0].score}: ${ranking[0].reasons.join(", ") || "default"})`);
  const concepts = planConcepts(ranking, clamp(Number(options.concepts ?? 1), 1, 4), brand);
  log.step("Generating creative brief" + (concepts.length > 1 ? `s for ${concepts.length} concepts` : ""));
  const prepared = [];
  for (const [i, c] of concepts.entries()) prepared.push({ concept: c, ...(await prepareConcept(c, post, brand, { ...options, dryRun }, d, log, i)) });
  log.step("Prompt generated");

  const copyBlocking = copyIssues.filter((i) => i.blocking);
  const viable = copyBlocking.length ? [] : prepared.filter((p) => !p.halts.length);
  const rankFit = (p) => p.concept.fit_score + 2 * ["hook_clear", "mobile_readable", "text_density_ok", "content_image_alignment"].filter((k) => p.checklist?.[k]).length;

  if (dryRun) {
    const outDir = path.join(d.cfg.assetsDir, "_dryrun", brand.asset_folder, post.post_id);
    fs.mkdirSync(outDir, { recursive: true });
    const now = DateTime.now().setZone(d.timezone);
    const result = {
      dry_run: true,
      post_id: post.post_id,
      business: brand.id,
      blocked: copyBlocking.length > 0 || !viable.length,
      content_safety: copyIssues,
      estimated_generations: viable.reduce((n, p) => n + (p.brief.generation_size ? 1 : 0), 0),
      expected_output_dir: path.join(d.cfg.assetsDir, brand.asset_folder, now.toFormat("yyyy"), now.toFormat("LL"), post.post_id),
      concepts: [],
    };
    for (const [i, p] of prepared.entries()) {
      const previewFiles = [];
      if (p.preview) {
        p.preview.buffers.forEach((buf, j) => {
          const f = path.join(outDir, `concept-${i + 1}${p.preview.buffers.length > 1 ? `-slide-${j + 1}` : ""}.jpg`);
          fs.writeFileSync(f, buf);
          previewFiles.push(f);
        });
      }
      result.concepts.push({
        rank_score: rankFit(p),
        visual_type: p.brief.visual_type,
        label: p.brief.visual_type_label,
        concept_mode: p.concept.concept_mode ?? p.brief.concept_mode,
        reasons: p.concept.reasons,
        layout: p.brief.layout,
        output_size: p.brief.output,
        generation_size: p.brief.generation_size,
        overlay_text: briefTextBlocks(p.brief).map((b) => `${b.label}: ${b.text}`),
        halts: p.halts,
        flags: p.brief.flags,
        checklist: p.checklist,
        preview_files: previewFiles,
        brief: p.brief,
        prompt: p.prompt,
      });
    }
    result.concepts.sort((a, b) => b.rank_score - a.rank_score);
    log.step(`Dry run finished — no OpenAI credits used. Preview: ${outDir}`);
    return result;
  }

  // ── real run ──
  const store = new AssetStore(d.cfg.assetsDir, brand, { timezone: d.timezone });
  let meta;
  if (store.exists(post.post_id)) {
    meta = store.load(post.post_id);
    if (!["BLOCKED", "FAILED", "IMAGE_REJECTED"].includes(meta.status) || !options.force) {
      throw new ImageError("ALREADY_EXISTS", `Post ${post.post_id} already has an image job (status ${meta.status}). Use the review actions (regenerate, change type…)${["BLOCKED", "FAILED", "IMAGE_REJECTED"].includes(meta.status) ? " or re-run with --force" : ""}.`);
    }
  } else {
    meta = { meta_version: 1, business: brand.id, post_id: post.post_id, platform: post.platform, created_at: new Date().toISOString(), status: null, history: [], candidates: [] };
    transition(meta, "CONTENT_APPROVED", "content approved");
  }
  Object.assign(meta, { content: post, content_safety: copyIssues, ranking: ranking.slice(0, 6), blocked: [] });
  transition(meta, "IMAGE_BRIEF_GENERATED");

  if (!viable.length) {
    meta.blocked = [...copyBlocking.map((i) => ({ code: i.rule, message: `"${i.match}"${i.note ? ` — ${i.note}` : ""}` })), ...prepared.flatMap((p) => p.halts)];
    meta.candidates.push(...prepared.map((p, i) => newCandidate(meta, p, i, "blocked")));
    transition(meta, "BLOCKED", meta.blocked.map((b) => b.code).join(", "));
    costTotals(meta);
    store.save(meta);
    log.error(`Blocked: ${meta.blocked.map((b) => b.message).join(" | ")}`);
    return summarize(meta, store);
  }
  transition(meta, "IMAGE_PROMPT_GENERATED");
  store.save(meta);

  const ctx = { d, brand, store, log, ledger: new Ledger(d.cfg.assetsDir, { timezone: d.timezone }), pricing: loadPricing(d.cfg.pricingFile) };
  viable.sort((a, b) => rankFit(b) - rankFit(a));
  const made = [];
  for (const [i, p] of viable.entries()) {
    const cand = newCandidate(meta, p, i, "pending");
    meta.candidates.push(cand);
    try {
      await produceCandidate(ctx, meta, cand, { kind: "generate" });
      made.push(cand);
    } catch (err) {
      const { code, message } = classifyError(err);
      cand.status = "failed";
      cand.error = { code, message };
      log.error(`${message}`);
      if (code.startsWith("BUDGET") || code === "MISSING_API_KEY") break;
    } finally {
      costTotals(meta);
      store.save(meta);
    }
  }
  if (!made.length) {
    transition(meta, "FAILED", meta.candidates.at(-1)?.error?.code ?? "");
    store.save(meta);
    const last = meta.candidates.at(-1)?.error;
    throw new ImageError(last?.code ?? "FAILED", last?.message ?? "No image could be produced", { summary: summarize(meta, store) });
  }
  meta.selected = made[0].id;
  advance(meta, ["IMAGE_GENERATED", "TEXT_OVERLAY_APPLIED", "IMAGE_REVIEW_PENDING"]);
  store.save(meta);
  log.step(`Awaiting approval (${made.length} concept${made.length > 1 ? "s" : ""}). Review with: npm run review`);
  return summarize(meta, store);
}

function newCandidate(meta, p, i, status) {
  return {
    id: `c${meta.candidates.length + 1}`,
    visual_type: p.brief.visual_type,
    concept_mode: p.concept.concept_mode ?? null,
    fit_score: p.concept.fit_score,
    reasons: p.concept.reasons,
    status,
    variant: p.concept.variant ?? 0,
    adjustments: p.concept.adjustments ?? [],
    text_overrides: p.concept.text_overrides ?? {},
    prompt_override: p.concept.prompt_override ?? "",
    brief: p.brief,
    prompts: [{ version: 1, at: new Date().toISOString(), text: p.prompt, reason: "initial" }],
    generations: [],
    finals: [],
  };
}

/** Make (or re-use) the picture for a candidate, draw the text, save files and update the checklist. */
async function produceCandidate(ctx, meta, cand, { kind, reuseGeneration = false, reason = "" }) {
  const { d, brand, store, log, ledger, pricing } = ctx;
  const brief = cand.brief;
  let background = null;
  let photo = null;
  if (brief.use_real_photo) {
    if (!cand.generations.length) {
      const rel = store.writeNew(meta.post_id, "source", "photo", path.extname(brand.photoFile).slice(1) || "jpg", fs.readFileSync(brand.photoFile));
      cand.generations.push({ id: "g1", kind: "real_photo", file: rel, created_at: new Date().toISOString() });
      log.step("Using the approved real photograph (no AI face)");
    }
    photo = fs.readFileSync(store.absolute(meta.post_id, cand.generations.at(-1).file));
  } else if (!brief.generation_size) {
    log.step("Designed infographic (icons + Bangla text) — no AI picture needed, no cost");
  } else if (reuseGeneration && cand.generations.length) {
    background = fs.readFileSync(store.absolute(meta.post_id, cand.generations.at(-1).file));
  } else {
    // AI-drawn infographics are read back and regenerated (within limits) while a Bangla line is misspelled.
    const checking = brief.text_mode === "model" && d.cfg.textCheck.enabled;
    const tries = checking ? 1 + d.cfg.textCheck.retries : 1;
    let best = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      const g = await generateOnce(ctx, meta, cand, { kind: attempt === 1 ? kind : "text_retry", reason: attempt === 1 ? reason : "Bangla text check failed" });
      if (checking) {
        g.record.text_check = await runTextCheck(ctx, brief, g.buffer);
        if (!best || (g.record.text_check.score ?? 0) > (best.record.text_check.score ?? 0)) best = g;
        if (g.record.text_check.ok || g.record.text_check.error) break;
        if (attempt < tries) log.warn(`Bangla text check failed (${g.record.text_check.wrong.map((w) => w.role).join(", ")}) — regenerating (${attempt + 1}/${tries})`);
      } else best = g;
    }
    // The best attempt becomes the current generation (finals point at the last one).
    cand.generations = [...cand.generations.filter((x) => x !== best.record), best.record];
    background = best.buffer;
  }
  const { buffers, reports } = await renderFinal(brief, brand, background, photo);
  const files = store.writeSeries(meta.post_id, "final", "final", "jpg", buffers);
  const overlayIssues = checkOverlayText(briefTextBlocks(brief), meta.content, brand);
  const textCheck = brief.text_mode === "model" ? cand.generations.at(-1)?.text_check ?? null : null;
  if (brief.text_mode === "model") overlayIssues.push(...modelTextIssues(textCheck));
  const checklist = creativeChecklist({ brief, report: reports, overlayIssues, brand, textCheck });
  cand.finals.push({ id: `f${cand.finals.length + 1}`, files, from_generation: cand.generations.at(-1)?.id ?? null, reports, overlay_issues: overlayIssues, text_check: textCheck, checklist, reason, created_at: new Date().toISOString() });
  cand.status = "ready";
  delete cand.error;
  log.step(`${brief.text_mode === "model" ? "AI-drawn infographic kept" : "Bengali overlay applied"} → ${files.join(", ")}`);
  log.step(`Creative checklist: ${checklist.status}${checklist.failed_major.length ? ` (failed: ${checklist.failed_major.join(", ")})` : ""}`);
}

/** One paid image generation, saved and recorded in the ledger. */
async function generateOnce(ctx, meta, cand, { kind, reason }) {
  const { d, brand, store, log, ledger, pricing } = ctx;
  const brief = cand.brief;
  for (const w of checkBudget({ ledger, limits: d.cfg.limits, business: brand.id, postId: meta.post_id, kind })) log.warn(w);
  const prompt = cand.prompts.at(-1);
  log.step(`Sending request to OpenAI (${d.cfg.imageModel}, ${brief.generation_size}, quality ${d.cfg.quality})`);
  let gen;
  try {
    gen = await generateBackground({
      prompt: prompt.text,
      size: brief.generation_size,
      quality: d.cfg.quality,
      model: d.cfg.imageModel,
      timeoutMs: d.cfg.timeoutMs,
      retries: d.cfg.retries,
      client: d.client,
      sleep: d.sleep,
      onRetry: (err, n) => log.warn(`${classifyError(err).message} — retrying (attempt ${n + 1})`),
    });
  } catch (err) {
    const { code, message } = classifyError(err);
    ledger.record({ business: brand.id, post_id: meta.post_id, candidate: cand.id, kind, model: d.cfg.imageModel, size: brief.generation_size, quality: d.cfg.quality, status: "failed", error: code, cost_usd: null });
    throw new ImageError(code, message);
  }
  const file = store.writeNew(meta.post_id, "generated", "gen", "png", gen.buffer);
  const cost = estimateCost(pricing, gen);
  ledger.record({ business: brand.id, post_id: meta.post_id, candidate: cand.id, kind, model: gen.model, size: gen.size, quality: gen.quality, status: "ok", cost_usd: cost.usd, request_id: gen.requestId, usage: gen.usage });
  const record = { id: `g${cand.generations.length + 1}`, kind, reason, file, model: gen.model, size: gen.size, quality: gen.quality, request_id: gen.requestId, usage: gen.usage, cost_usd: cost.usd, cost_basis: cost.basis, attempts: gen.attempts, prompt_version: prompt.version, created_at: new Date().toISOString() };
  cand.generations.push(record);
  log.step(`Image saved (${file})${cost.usd != null ? ` — $${cost.usd}` : " — cost unknown"}`);
  return { buffer: gen.buffer, record };
}

/** Read the AI-drawn Bangla text back and compare it with what was asked for. Never throws. */
async function runTextCheck({ d, log }, brief, buffer) {
  try {
    const r = await d.textCheck(buffer, infographicTextLines(brief), { threshold: d.cfg.textCheck.threshold });
    const summary = { ok: r.ok, score: r.score, wrong: r.wrong.map(({ role, text, similarity }) => ({ role, text, similarity })), garbled: r.garbled, transcript: r.transcript };
    log.step(r.ok ? `Bangla text check passed (score ${r.score})` : `Bangla text check: ${r.wrong.length} line(s) wrong${r.garbled.length ? `, garbled: ${r.garbled.join(", ")}` : ""} (score ${r.score})`);
    return summary;
  } catch (err) {
    const { message } = classifyError(err);
    log.warn(`Bangla text check could not run (${message}) — proofread by hand`);
    return { ok: false, score: null, wrong: [], garbled: [], transcript: [], error: message };
  }
}

/** Review notes for an AI-drawn infographic. */
function modelTextIssues(check) {
  const proofread = { rule: "model_rendered_text", match: "", blocking: false, note: "The AI drew the Bangla text itself — proofread every letter before approving." };
  if (!check) return [{ ...proofread, note: `${proofread.note} (automatic text check is off)` }];
  if (check.error) return [{ ...proofread, note: `${proofread.note} (automatic text check failed: ${check.error})` }];
  return [
    proofread,
    ...check.wrong.map((w) => ({ rule: "model_text_mismatch", label: w.role, match: w.text, blocking: false, note: `Not found as written on the image (match ${Math.round(w.similarity * 100)}%) — check the spelling or regenerate.` })),
    ...check.garbled.map((g) => ({ rule: "model_text_garbled", label: "garbled", match: g, blocking: false, note: "Unreadable or invented Bangla on the image." })),
  ];
}

// ─────────────────────────────── review actions ───────────────────────────────

export const ACTIONS = ["approve", "reject", "select", "regenerate", "edit_prompt", "edit_headline", "change_type", "send", "published", "unapprove"];

/**
 * Apply a reviewer's action to a post.
 * @param {object} p  { businessId, postId, action, params, deps }
 */
export async function runAction({ businessId, postId, action, params = {}, deps = {} }) {
  const d = resolveDeps(deps);
  const brand = loadBrand(businessId || d.cfg.defaultBusiness, { brandsDir: d.cfg.brandsDir });
  const store = new AssetStore(d.cfg.assetsDir, brand, { timezone: d.timezone });
  const meta = store.load(postId);
  const log = createImageLog(postId, deps.logSink && { sink: deps.logSink });
  const ctx = { d, brand, store, log, ledger: new Ledger(d.cfg.assetsDir, { timezone: d.timezone }), pricing: loadPricing(d.cfg.pricingFile) };
  const cand = () => {
    const c = meta.candidates.find((x) => x.id === (params.candidate || meta.selected));
    if (!c) throw new ImageError("NO_CANDIDATE", `No image candidate "${params.candidate || meta.selected}" for ${postId}`);
    return c;
  };
  const requireReview = () => {
    if (meta.status !== "IMAGE_REVIEW_PENDING") throw new ImageError("INVALID_TRANSITION", `This action needs status IMAGE_REVIEW_PENDING (current: ${meta.status})`);
  };
  const regen = async (c, { kind, reason, reuse }) => {
    try {
      if (!reuse) transition(meta, "IMAGE_PROMPT_GENERATED", reason);
      await produceCandidate(ctx, meta, c, { kind, reuseGeneration: reuse, reason });
      if (!reuse) transition(meta, "IMAGE_GENERATED");
      advance(meta, ["TEXT_OVERLAY_APPLIED", "IMAGE_REVIEW_PENDING"]);
    } catch (err) {
      const { code, message } = classifyError(err);
      log.error(message);
      meta.last_error = { code, message, at: new Date().toISOString() };
      if (meta.status !== "IMAGE_REVIEW_PENDING") transition(meta, "FAILED", code);
      // Put the post back in review so the previous images stay usable.
      if (meta.status === "FAILED" && meta.candidates.some((x) => x.finals.length)) transition(meta, "IMAGE_REVIEW_PENDING", "previous images kept after a failed regeneration");
      costTotals(meta);
      store.save(meta);
      throw new ImageError(code, message);
    }
  };
  const rebuild = (c) => {
    const b = buildBrief(meta.content, brand, c.visual_type, { aspect: c.brief.aspect_ratio, textMode: c.brief.text_mode, conceptMode: c.concept_mode ?? undefined, variant: c.variant, arbitrarySizes: d.cfg.arbitrarySizes });
    applyOverrides(b, c.text_overrides);
    if (c.brief.headline_scale) b.headline_scale = c.brief.headline_scale;
    c.brief = b;
  };
  const newPrompt = (c, reasonText) => {
    const text = buildImagePrompt(c.brief, brand, { adjustments: c.adjustments, promptOverride: c.prompt_override });
    const issues = scanVisualPrompt(positivePromptText(c.brief, c.adjustments, c.prompt_override));
    if (issues.length) throw new ImageError("UNSAFE_PROMPT", `The prompt asks for "${issues[0].match}", which is not allowed in medical images.`);
    c.prompts.push({ version: c.prompts.length + 1, at: new Date().toISOString(), text, reason: reasonText });
  };

  switch (action) {
    case "approve": {
      requireReview();
      const c = cand();
      const final = c.finals.at(-1);
      if (!final) throw new ImageError("NO_FINAL_IMAGE", "Nothing to approve yet");
      const blocking = final.overlay_issues.filter((i) => i.blocking);
      if (blocking.length) throw new ImageError("SAFETY_BLOCK", `Cannot approve: ${blocking.map((i) => `${i.rule} "${i.match}"`).join(", ")}`);
      meta.selected = c.id;
      meta.approval = { by: params.by || "reviewer", at: new Date().toISOString(), note: params.note || "", candidate: c.id, final: final.id };
      advance(meta, ["IMAGE_APPROVED", "READY_TO_SCHEDULE"], `approved by ${meta.approval.by}`);
      log.step(`Approved (${c.id}/${final.id}) — ready to send to Make.com`);
      break;
    }
    case "unapprove":
      transition(meta, "IMAGE_REVIEW_PENDING", params.note || "approval withdrawn");
      delete meta.approval;
      break;
    case "reject":
      requireReview();
      meta.rejection = { at: new Date().toISOString(), reason: params.reason || params.note || "" };
      transition(meta, "IMAGE_REJECTED", meta.rejection.reason);
      log.step(`Rejected: ${meta.rejection.reason || "no reason given"}`);
      break;
    case "select":
      requireReview();
      if (!cand().finals.length) throw new ImageError("NO_FINAL_IMAGE", "That concept has no finished image");
      meta.selected = cand().id;
      transition(meta, "IMAGE_REVIEW_PENDING", `concept ${meta.selected} chosen`);
      break;
    case "regenerate": {
      requireReview();
      const c = cand();
      const r = getReason(params.reason);
      log.step(`Regenerating — reason: ${r.label}${params.note ? ` (${params.note})` : ""}`);
      if (r.scope === "overlay") {
        if (r.needsHeadline) {
          if (!params.headline) throw new ImageError("HEADLINE_REQUIRED", 'This reason needs a new headline (params.headline / --headline "...")');
          c.text_overrides = { ...c.text_overrides, headline: params.headline };
          applyOverrides(c.brief, c.text_overrides);
        }
        r.overlay?.(c.brief);
        await regen(c, { kind: "overlay", reason: params.reason, reuse: true });
      } else {
        c.adjustments = [...c.adjustments, ...(r.prompt ?? [])];
        c.variant += r.variant ?? 0;
        rebuild(c);
        newPrompt(c, params.reason + (params.note ? `: ${params.note}` : ""));
        await regen(c, { kind: "regenerate", reason: params.reason, reuse: false });
      }
      break;
    }
    case "edit_prompt": {
      requireReview();
      const c = cand();
      if (!params.prompt?.trim()) throw new ImageError("PROMPT_REQUIRED", "params.prompt is empty");
      c.prompt_override = params.prompt.trim();
      newPrompt(c, "edited by reviewer");
      await regen(c, { kind: "regenerate", reason: "edit_prompt", reuse: false });
      break;
    }
    case "edit_headline": {
      requireReview();
      const c = cand();
      if (!params.headline?.trim()) throw new ImageError("HEADLINE_REQUIRED", "params.headline is empty");
      c.text_overrides = { ...c.text_overrides, headline: params.headline.trim() };
      applyOverrides(c.brief, c.text_overrides);
      await regen(c, { kind: "overlay", reason: "edit_headline", reuse: true });
      break;
    }
    case "change_type": {
      requireReview();
      getCategory(params.visual_type);
      const p = await prepareConcept({ visual_type: params.visual_type, fit_score: 0, reasons: ["chosen by reviewer"] }, meta.content, brand, {}, d, log, meta.candidates.length);
      if (p.halts.length) throw new ImageError("BLOCKED", p.halts.map((h) => h.message).join(" | "));
      const c = newCandidate(meta, { ...p, concept: { visual_type: params.visual_type, fit_score: 0, reasons: ["chosen by reviewer"] } }, 0, "pending");
      meta.candidates.push(c);
      await regen(c, { kind: "regenerate", reason: "change_type", reuse: false });
      meta.selected = c.id;
      break;
    }
    case "send": {
      if (meta.status !== "READY_TO_SCHEDULE") throw new ImageError("NOT_APPROVED", `Only approved images can be sent to Make.com (status: ${meta.status})`);
      const c = meta.candidates.find((x) => x.id === meta.approval.candidate);
      const final = c.finals.find((f) => f.id === meta.approval.final);
      const images = await prepareImages({
        files: final.files.map((f) => store.absolute(postId, f)),
        postId,
        brand,
        mode: d.cfg.makeImageDelivery,
        cloudinaryConfigured: Boolean(config.cloudinary.cloud && config.cloudinary.preset),
        ...(d.upload && { upload: d.upload }),
      });
      const payload = buildMakePayload({ meta, brand, images });
      const record = { ...payload, images: payload.images.map(({ base64, ...rest }) => ({ ...rest, ...(base64 && { base64_bytes: Math.round((base64.length * 3) / 4) }) })) };
      const payloadFile = store.writeNew(postId, ".", "make-payload", "json", Buffer.from(JSON.stringify(record, null, 2)));
      log.step("Sending approved post to Make.com");
      const response = await sendToMake(payload, brand, { fetchImpl: d.fetchImpl, env: d.env });
      meta.make = { sent_at: new Date().toISOString(), payload_file: payloadFile, response };
      transition(meta, "SENT_TO_MAKE", `HTTP ${response.status}`);
      const fbId = response.body?.fb_post_id ?? response.body?.post_id;
      if (fbId) {
        meta.make.fb_post_id = fbId;
        transition(meta, "PUBLISHED", `Facebook post ${fbId}`);
      }
      log.step(`Make.com answered HTTP ${response.status}${fbId ? ` — published as ${fbId}` : ""}`);
      break;
    }
    case "published":
      meta.make = { ...(meta.make ?? {}), fb_post_id: params.fb_post_id ?? null, published_at: new Date().toISOString() };
      transition(meta, "PUBLISHED", params.fb_post_id ? `Facebook post ${params.fb_post_id}` : "marked published");
      break;
    default:
      throw new ImageError("UNKNOWN_ACTION", `Unknown action "${action}". Use one of: ${ACTIONS.join(", ")}`);
  }
  costTotals(meta);
  store.save(meta);
  return summarize(meta, store);
}

/** Small helpers for the CLI / review screen. */
export function listJobs({ businessId, status, deps = {} } = {}) {
  const d = resolveDeps(deps);
  const brand = loadBrand(businessId || d.cfg.defaultBusiness, { brandsDir: d.cfg.brandsDir });
  const store = new AssetStore(d.cfg.assetsDir, brand, { timezone: d.timezone });
  return store
    .list()
    .filter((m) => !status || m.status === status)
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}

export function openStore(businessId, deps = {}) {
  const d = resolveDeps(deps);
  const brand = loadBrand(businessId || d.cfg.defaultBusiness, { brandsDir: d.cfg.brandsDir });
  return { brand, store: new AssetStore(d.cfg.assetsDir, brand, { timezone: d.timezone }), cfg: d.cfg, ledger: new Ledger(d.cfg.assetsDir, { timezone: d.timezone }) };
}
