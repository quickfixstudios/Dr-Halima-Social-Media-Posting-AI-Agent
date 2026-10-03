import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { REPO_ROOT } from "../src/config.js";
import { loadBrand } from "../src/imaging/brands.js";
import { normalizePost } from "../src/imaging/content.js";
import { outputSize, generationSize } from "../src/imaging/formats.js";
import { rankCategories, buildBrief } from "../src/imaging/decision.js";
import { buildImagePrompt } from "../src/imaging/promptBuilder.js";
import { composeImage } from "../src/imaging/overlay/layouts.js";
import { renderText } from "../src/imaging/overlay/text.js";
import { scanCopy, scanVisualPrompt, checkOverlayText } from "../src/imaging/safety.js";
import { transition } from "../src/imaging/workflow.js";
import { estimateCost } from "../src/imaging/budget.js";
import { buildMakePayload, assembleCaption, publishAt, prepareImages } from "../src/imaging/make.js";
import { createImageJob, runAction } from "../src/imaging/pipeline.js";
import { createServer } from "../src/server.js";

process.env.IMAGE_LOG = "silent";
const SAMPLES = path.join(REPO_ROOT, "posts/dr_halima/samples");
const sample = (n) => JSON.parse(fs.readFileSync(path.join(SAMPLES, fs.readdirSync(SAMPLES).find((f) => f.startsWith(`sample-0${n}`))), "utf8"));
const brand = loadBrand("dr_halima");

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imaging-test-"));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Fake OpenAI client: returns a plain PNG of the requested size, or the queued errors first. */
function fakeClient({ errors = [], noImage = false } = {}) {
  const calls = [];
  return {
    calls,
    images: {
      generate(params, opts) {
        calls.push({ params, opts });
        const result = (async () => {
          const err = errors.shift();
          if (err) throw err;
          if (noImage) return { data: [] };
          const [width, height] = params.size.split("x").map(Number);
          const png = await sharp({ create: { width, height, channels: 3, background: "#9fb4c0" } }).png().toBuffer();
          return { data: [{ b64_json: png.toString("base64") }], usage: { input_tokens: 120, output_tokens: 4000, input_tokens_details: { text_tokens: 120, image_tokens: 0 } } };
        })();
        return { withResponse: async () => ({ data: await result, request_id: `req_${calls.length}` }) };
      },
    },
  };
}
const httpError = (status, msg = "err") => Object.assign(new Error(msg), { status });
let n = 0;
/** Fresh assets folder + config per test so tests never share state. */
function deps(extra = {}) {
  const assetsDir = path.join(tmp, `run-${++n}`);
  return { cfg: { assetsDir, pricingFile: path.join(tmp, "none.json"), ...(extra.cfg ?? {}) }, client: extra.client ?? fakeClient(), sleep: async () => {}, ...extra, ...(extra.cfg && { cfg: { assetsDir, pricingFile: path.join(tmp, "none.json"), ...extra.cfg } }) };
}

// ── business profile ──
test("business profile loads, resolves fonts and flags placeholder colours", () => {
  assert.equal(brand.id, "dr_halima");
  assert.ok(fs.existsSync(brand.fontFiles.bold));
  assert.equal(brand.colorsArePlaceholders, true);
  assert.match(brand.warnings.join(" "), /colours are not configured/);
  assert.throws(() => loadBrand("no_such_business"), { code: "BRAND_NOT_FOUND" });
  const dir = fs.mkdtempSync(path.join(tmp, "brands-"));
  fs.writeFileSync(path.join(dir, "broken.json"), "{ not json");
  assert.throws(() => loadBrand("broken", { brandsDir: dir }), { code: "BRAND_INVALID" });
  assert.throws(() => loadBrand("../etc"), { code: "INVALID_BUSINESS" });
});

// ── formats ──
test("aspect ratios map to Facebook sizes and model sizes divisible by 16", () => {
  assert.deepEqual(outputSize("facebook", "4:5"), { width: 1080, height: 1350 });
  assert.deepEqual(outputSize("facebook", "9:16"), { width: 1080, height: 1920 });
  assert.deepEqual(outputSize("facebook", "1.91:1"), { width: 1200, height: 628 });
  assert.throws(() => outputSize("facebook", "2:3"), { code: "UNSUPPORTED_ASPECT" });
  for (const r of [0.8, 1, 1080 / 486, 9 / 16, 1.91]) {
    const [w, h] = generationSize(r).split("x").map(Number);
    assert.equal(w % 16, 0);
    assert.equal(h % 16, 0);
    assert.ok(Math.abs(w / h - Math.min(3, Math.max(1 / 3, r))) < 0.25, `ratio ${r} → ${w}x${h}`);
  }
  assert.equal(generationSize(0.8, { arbitrarySizes: false }), "1024x1536");
  const brief = buildBrief(normalizePost(sample(2)), brand, "pain_solution", { aspect: "1:1" });
  assert.deepEqual(brief.output, { width: 1080, height: 1080 });
});

// ── decision engine ──
test("decision engine picks a fitting visual type for each sample post", () => {
  const expected = { 1: "warning_signs", 2: "pain_solution", 3: "myth_vs_fact", 4: "question_curiosity", 6: "doctor_trust", 7: "statistics", 8: "appointment_cta" };
  for (const [i, type] of Object.entries(expected)) {
    const ranked = rankCategories(normalizePost(sample(i)), brand);
    assert.equal(ranked[0].id, type, `sample ${i}`);
    assert.ok(ranked[0].reasons.length, "explains its choice");
  }
});

test("unsupported image type is rejected", () => {
  assert.throws(() => buildBrief(normalizePost(sample(1)), brand, "hologram"), { code: "UNSUPPORTED_IMAGE_TYPE" });
  assert.throws(() => rankCategories(normalizePost({ ...sample(1), visual_type: "hologram" }), brand), { code: "UNSUPPORTED_IMAGE_TYPE" });
});

test("too many points become a carousel instead of an overloaded image", () => {
  const post = normalizePost({ ...sample(1), key_points: ["এক", "দুই", "তিন", "চার", "পাঁচ", "ছয়", "সাত"] });
  const brief = buildBrief(post, brand, "warning_signs");
  assert.equal(brief.layout, "carousel");
  assert.ok(brief.flags.some((f) => f.code === "converted_to_carousel"));
  assert.equal(brief.text.slides.length, 5);
});

// ── prompt builder ──
test("prompt has every section, Bangladeshi context, negative constraints and no-text rule", () => {
  const brief = buildBrief(normalizePost(sample(2)), brand, "pain_solution");
  const prompt = buildImagePrompt(brief, brand);
  for (const s of ["SUBJECT", "CONTEXT", "EMOTION", "COMPOSITION", "CAMERA", "LIGHTING", "ENVIRONMENT", "VISUAL STYLE", "CULTURAL CONTEXT", "BRAND STYLE", "COLOR DIRECTION", "EMPTY SPACE FOR TEXT", "MEDICAL ACCURACY REQUIREMENTS", "CONTENT SAFETY", "WHAT TO AVOID", "ASPECT RATIO"]) {
    assert.match(prompt, new RegExp(`^${s}:`, "m"), s);
  }
  assert.match(prompt, /Bangladeshi/);
  assert.match(prompt, /Do NOT render any text/);
  assert.match(prompt, /extra fingers/);
  assert.match(prompt, /Dhaka/);
  const modelMode = buildImagePrompt(buildBrief(normalizePost(sample(2)), brand, "pain_solution", { textMode: "model" }), brand);
  assert.match(modelMode, /Render this text exactly/);
  assert.match(modelMode, /তীব্র মাসিকের ব্যথা/);
});

test("prompts change with the post (wardrobe/setting rotate, subject follows the category)", () => {
  const a = buildImagePrompt(buildBrief(normalizePost(sample(2)), brand, "pain_solution"), brand);
  const b = buildImagePrompt(buildBrief(normalizePost(sample(4)), brand, "question_curiosity"), brand);
  assert.notEqual(a, b);
  const v0 = buildBrief(normalizePost(sample(2)), brand, "pain_solution", { variant: 0 }).wardrobe;
  const v1 = buildBrief(normalizePost(sample(2)), brand, "pain_solution", { variant: 1 }).wardrobe;
  assert.notEqual(v0, v1);
});

// ── Bangla overlay ──
test("Bangla overlay renders at the exact Facebook size", async () => {
  const post = normalizePost(sample(1));
  const brief = buildBrief(post, brand, "warning_signs");
  const bg = await sharp({ create: { width: 1536, height: 800, channels: 3, background: "#ccc" } }).png().toBuffer();
  const { buffer, report } = await composeImage({ layout: brief.layout, background: bg, brief, brand, ...brief.output });
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, 1080);
  assert.equal(meta.height, 1350);
  assert.equal(meta.format, "jpeg");
  assert.ok(report.sizes.headline >= 40);
  assert.equal(report.blocks.filter((b) => b.label === "items").length, 5);
  assert.ok(report.blocks.some((b) => b.text === "গর্ভাবস্থায় এই ৫টি লক্ষণ অবহেলা করবেন না"));
});

test("long headlines shrink to fit; impossible ones raise TEXT_TOO_LONG instead of cropping", async () => {
  const font = { fontFile: brand.fontFiles.bold, family: brand.fonts.family, width: 900 };
  const fit = await renderText({ ...font, text: "গর্ভাবস্থায় এই ৫টি লক্ষণ অবহেলা করবেন না এবং প্রয়োজন হলে দেরি না করে চিকিৎসকের পরামর্শ নিন", sizePx: 80, minPx: 40, maxLines: 3 });
  assert.ok(fit.sizePx < 80 && fit.lines <= 3);
  await assert.rejects(renderText({ ...font, text: "অনেক লম্বা লেখা ".repeat(60), sizePx: 60, minPx: 40, maxLines: 3 }), { code: "TEXT_TOO_LONG" });
  const r = await createImageJob({ post: { ...sample(2), hook: "তীব্র মাসিকের ব্যথা সবসময় স্বাভাবিক নয় ".repeat(8) }, options: { dryRun: true }, deps: deps() });
  assert.ok(r.concepts[0].halts.some((h) => h.code === "text_too_long"));
  assert.equal(r.estimated_generations, 0);
});

test("optional LLM shortening: too-long headline is shortened and marked for human check", async () => {
  const long = "তীব্র মাসিকের ব্যথা সবসময় স্বাভাবিক নয় ".repeat(8).trim();
  const d = deps({ cfg: { shortenWithLlm: true }, shorten: async () => "তীব্র মাসিকের ব্যথা সবসময় স্বাভাবিক নয়" });
  const r = await createImageJob({ post: { ...sample(2), hook: long }, deps: d });
  assert.equal(r.status, "IMAGE_REVIEW_PENDING");
  const meta = JSON.parse(fs.readFileSync(path.join(r.folder, "metadata.json"), "utf8"));
  assert.equal(meta.candidates[0].brief.text_origins.headline, "derived");
  assert.ok(meta.candidates[0].brief.flags.some((f) => f.code === "text_shortened"));
});

// ── content validation ──
test("empty caption and unapproved content are refused", async () => {
  assert.throws(() => normalizePost({ ...sample(1), caption: "   " }), { code: "EMPTY_CAPTION" });
  await assert.rejects(createImageJob({ post: { ...sample(1), content_status: "draft" }, deps: deps() }), { code: "CONTENT_NOT_APPROVED" });
});

// ── dry run ──
test("dry run spends nothing and writes a preview", async () => {
  const d = deps();
  const r = await createImageJob({ post: sample(3), options: { dryRun: true }, deps: d });
  assert.equal(d.client.calls.length, 0);
  assert.equal(r.dry_run, true);
  assert.equal(r.estimated_generations, 1);
  assert.equal(r.concepts[0].visual_type, "myth_vs_fact");
  assert.ok(fs.existsSync(r.concepts[0].preview_files[0]));
  assert.match(r.expected_output_dir, /dr-halima\/\d{4}\/\d{2}\/sample-03$/);
  assert.ok(!fs.existsSync(path.join(d.cfg.assetsDir, "_ledger.jsonl")));
});

test("several creative directions can be previewed and ranked", async () => {
  const r = await createImageJob({ post: sample(2), options: { dryRun: true, concepts: 3 }, deps: deps() });
  assert.equal(r.concepts.length, 3);
  assert.ok(r.concepts[0].rank_score >= r.concepts[2].rank_score);
  assert.equal(new Set(r.concepts.map((c) => `${c.visual_type}/${c.concept_mode}`)).size, 3);
});

// ── real run (fake OpenAI) ──
test("real run: generate → overlay → review pending, with files, ledger and request id", async () => {
  const d = deps();
  const r = await createImageJob({ post: sample(1), deps: d });
  assert.equal(r.status, "IMAGE_REVIEW_PENDING");
  assert.equal(d.client.calls.length, 1);
  assert.equal(d.client.calls[0].params.size, "1536x800");
  assert.ok(fs.existsSync(r.candidates[0].final_files[0]));
  const meta = JSON.parse(fs.readFileSync(path.join(r.folder, "metadata.json"), "utf8"));
  assert.equal(meta.candidates[0].generations[0].request_id, "req_1");
  assert.ok(fs.existsSync(path.join(r.folder, meta.candidates[0].generations[0].file)));
  assert.deepEqual(meta.history.map((h) => h.to), ["CONTENT_APPROVED", "IMAGE_BRIEF_GENERATED", "IMAGE_PROMPT_GENERATED", "IMAGE_GENERATED", "TEXT_OVERLAY_APPLIED", "IMAGE_REVIEW_PENDING"]);
  const ledger = fs.readFileSync(path.join(d.cfg.assetsDir, "_ledger.jsonl"), "utf8").trim().split("\n");
  assert.equal(ledger.length, 1);
  assert.equal(JSON.parse(ledger[0]).cost_usd, null); // no pricing configured → unknown, never guessed
  await assert.rejects(createImageJob({ post: sample(1), deps: d }), { code: "ALREADY_EXISTS" });
});

test("no image returned → NO_IMAGE_RETURNED and status FAILED", async () => {
  const d = deps({ client: fakeClient({ noImage: true }) });
  await assert.rejects(createImageJob({ post: sample(2), deps: d }), { code: "NO_IMAGE_RETURNED" });
});

test("API timeout is retried, then reported as API_TIMEOUT", async () => {
  const timeout = () => Object.assign(new Error("Request timed out."), { name: "APIConnectionTimeoutError" });
  const d = deps({ client: fakeClient({ errors: [timeout(), timeout(), timeout()] }) });
  await assert.rejects(createImageJob({ post: sample(2), deps: d }), { code: "API_TIMEOUT" });
  assert.equal(d.client.calls.length, 3);
});

test("rate limit is retried and then succeeds; bad requests are not retried", async () => {
  const d = deps({ client: fakeClient({ errors: [httpError(429, "Rate limit")] }) });
  const r = await createImageJob({ post: sample(2), deps: d });
  assert.equal(r.status, "IMAGE_REVIEW_PENDING");
  assert.equal(d.client.calls.length, 2);
  const d2 = deps({ client: fakeClient({ errors: [httpError(400, "Your request was rejected by the safety system")] }) });
  await assert.rejects(createImageJob({ post: sample(2), deps: d2 }), { code: "API_BAD_REQUEST" });
  assert.equal(d2.client.calls.length, 1);
});

test("missing API key gives a clear error", async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(createImageJob({ post: sample(2), deps: { ...deps(), client: undefined } }), { code: "MISSING_API_KEY" });
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

// ── doctor photo ──
test("no approved doctor photo → non-identifying visual + flag; with photo → real photo, no AI call", async () => {
  const brief = buildBrief(normalizePost(sample(6)), brand, "doctor_trust");
  assert.equal(brief.doctor_presence, false);
  assert.ok(brief.flags.some((f) => f.code === "missing_doctor_photo"));
  assert.match(brief.subject, /no face, no person/);

  const dir = fs.mkdtempSync(path.join(tmp, "brands-"));
  const photo = path.join(dir, "portrait.jpg");
  await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#d9c6b0" } }).jpeg().toFile(photo);
  const raw = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "brands/dr_halima.json"), "utf8"));
  raw.person.photo_path = photo;
  raw.person.photo_approved = true;
  fs.writeFileSync(path.join(dir, "dr_halima.json"), JSON.stringify(raw));
  const d = deps({ cfg: { brandsDir: dir } });
  const r = await createImageJob({ post: sample(6), deps: d });
  assert.equal(r.status, "IMAGE_REVIEW_PENDING");
  assert.equal(d.client.calls.length, 0);
  const meta = JSON.parse(fs.readFileSync(path.join(r.folder, "metadata.json"), "utf8"));
  assert.equal(meta.candidates[0].brief.use_real_photo, true);
  assert.equal(meta.candidates[0].generations[0].kind, "real_photo");
});

// ── never invent ──
test("missing verified statistic halts the data visual (no API call, status BLOCKED)", async () => {
  const d = deps();
  const r = await createImageJob({ post: sample(7), deps: d });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blocked.some((b) => b.code === "requires_verified_statistic"));
  assert.equal(d.client.calls.length, 0);
  const ok = await createImageJob({ post: { ...sample(7), post_id: "stat-ok", verified_statistics: [{ value: "৪৯%", label: "উদাহরণ লেবেল", source: "উদাহরণ সূত্র" }] }, options: { dryRun: true }, deps: deps() });
  assert.equal(ok.concepts[0].halts.length, 0);
});

test("missing contact details halt the appointment poster", async () => {
  const r = await createImageJob({ post: sample(8), options: { dryRun: true }, deps: deps() });
  assert.ok(r.concepts[0].halts.some((h) => h.code === "requires_contact_details"));
});

test("medical safety: upgraded titles, risky claims, unsourced numbers and unsafe visuals are caught", () => {
  const p5 = normalizePost(sample(5));
  assert.ok(scanCopy(p5, brand).some((i) => i.rule === "title_upgrade" && i.blocking));
  assert.deepEqual(scanCopy(normalizePost(sample(6)), brand), []);
  assert.deepEqual(scanCopy(normalizePost({ ...sample(2), caption: "ব্যথা বাড়লে একজন বিশেষজ্ঞ চিকিৎসকের পরামর্শ নিন।" }), brand), [], "advising to see a specialist is fine");
  assert.ok(scanCopy(normalizePost({ ...sample(2), caption: "এই চিকিৎসায় ১০০% সেরে যাবে" }), brand).some((i) => i.rule === "absolute_claim_bn"));
  const issues = checkOverlayText([{ label: "headline", text: "৯০% নারী আক্রান্ত", origin: "derived" }], normalizePost(sample(2)), brand);
  assert.ok(issues.some((i) => i.rule === "unsourced_number" && i.blocking));
  assert.deepEqual(scanVisualPrompt("A calm woman at home, no blood, no needles"), []);
  assert.equal(scanVisualPrompt("close-up of a syringe")[0].rule, "sensitive_visual");
});

test("a title-upgrade post is BLOCKED before any image is made", async () => {
  const d = deps();
  const r = await createImageJob({ post: sample(5), deps: d });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blocked.some((b) => b.code === "title_upgrade"));
  assert.equal(d.client.calls.length, 0);
});

// ── cost limits ──
test("cost limits stop spending", async () => {
  const d = deps({ cfg: { limits: { maxGenerationsPerPost: 1, maxRegenerations: 3, dailyGenerationLimit: 25 } } });
  await createImageJob({ post: sample(2), deps: d });
  await assert.rejects(runAction({ postId: "sample-02", action: "regenerate", params: { reason: "too_dramatic" }, deps: d }), { code: "BUDGET_POST_LIMIT" });
  const priced = path.join(tmp, "pricing.json");
  fs.writeFileSync(priced, JSON.stringify({ models: { "gpt-image-2.5-sunburst": { per_1m_tokens: { text_input: 5, image_input: 10, image_output: 40 } } } }));
  assert.deepEqual(estimateCost(JSON.parse(fs.readFileSync(priced, "utf8")), { model: "gpt-image-2.5-sunburst", usage: { input_tokens: 1000, output_tokens: 1000, input_tokens_details: { text_tokens: 1000, image_tokens: 0 } } }), { usd: 0.045, basis: "API-reported token usage × configured token prices" });
  const d2 = deps({ cfg: { pricingFile: priced, limits: { maxGenerationsPerPost: 6, maxRegenerations: 3, dailyGenerationLimit: 25, dailyBudgetUsd: 0.1 } } });
  await createImageJob({ post: sample(2), deps: d2 }); // 120×5 + 4000×40 per 1M = $0.1606 → budget now exceeded
  await assert.rejects(createImageJob({ post: sample(1), deps: d2 }), { code: "BUDGET_EXCEEDED" });
  const d3 = deps({ cfg: { limits: { maxGenerationsPerPost: 6, maxRegenerations: 3, dailyGenerationLimit: 1 } } });
  await createImageJob({ post: sample(2), deps: d3 });
  await assert.rejects(createImageJob({ post: sample(1), deps: d3 }), { code: "BUDGET_DAILY_LIMIT" });
});

// ── review actions ──
test("regenerate: text-only reasons are free; background reasons change only the prompt section needed", async () => {
  const d = deps();
  await createImageJob({ post: sample(2), deps: d });
  await assert.rejects(runAction({ postId: "sample-02", action: "regenerate", params: { reason: "keep_image_change_text" }, deps: d }), { code: "HEADLINE_REQUIRED" });
  let r = await runAction({ postId: "sample-02", action: "regenerate", params: { reason: "keep_image_change_text", headline: "মাসিকের ব্যথা নিয়ে চুপ থাকবেন না" }, deps: d });
  assert.equal(d.client.calls.length, 1, "no new API call");
  assert.equal(r.status, "IMAGE_REVIEW_PENDING");
  r = await runAction({ postId: "sample-02", action: "regenerate", params: { reason: "face_looks_fake" }, deps: d });
  assert.equal(d.client.calls.length, 2);
  assert.match(d.client.calls[1].params.prompt, /unretouched skin texture/);
  const meta = JSON.parse(fs.readFileSync(path.join(r.folder, "metadata.json"), "utf8"));
  assert.equal(meta.candidates[0].prompts.length, 2);
  assert.equal(meta.candidates[0].finals.length, 3);
  assert.equal(meta.candidates[0].brief.text.headline, "মাসিকের ব্যথা নিয়ে চুপ থাকবেন না", "human headline survives a background regeneration");
  assert.equal(new Set(meta.candidates[0].finals.flatMap((f) => f.files)).size, 3, "originals never overwritten");
  await assert.rejects(runAction({ postId: "sample-02", action: "regenerate", params: { reason: "make_it_pink" }, deps: d }), { code: "UNKNOWN_REASON" });
});

test("edit headline, change type, approve, send to Make, published", async () => {
  const d = deps();
  await createImageJob({ post: sample(1), deps: d });
  await assert.rejects(runAction({ postId: "sample-01", action: "send", deps: d }), { code: "NOT_APPROVED" });
  await runAction({ postId: "sample-01", action: "edit_headline", params: { headline: "গর্ভাবস্থায় এই লক্ষণগুলো অবহেলা করবেন না" }, deps: d });
  let r = await runAction({ postId: "sample-01", action: "change_type", params: { visual_type: "educational_infographic" }, deps: d });
  assert.equal(r.selected, "c2");
  r = await runAction({ postId: "sample-01", action: "approve", params: { by: "Tester" }, deps: d });
  assert.equal(r.status, "READY_TO_SCHEDULE");
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ fb_post_id: "103052652458065_999" }), { status: 200 });
  };
  r = await runAction({ postId: "sample-01", action: "send", deps: { ...d, fetchImpl, env: { MAKE_WEBHOOK_URL_DR_HALIMA: "https://hook.eu2.make.com/test" } } });
  assert.equal(r.status, "PUBLISHED");
  const payload = sent[0].body;
  assert.equal(sent[0].url, "https://hook.eu2.make.com/test");
  assert.equal(payload.post_id, "sample-01");
  assert.equal(payload.business, "dr_halima");
  assert.equal(payload.visual_type, "educational_infographic");
  assert.ok(payload.images[0].base64.length > 1000, "image bytes inline when Cloudinary is not configured");
  assert.ok(payload.caption.trim().endsWith("#গর্ভকালীন_যত্ন #PregnancyCare"), "hashtags last");
  assert.match(payload.caption, /— ডা. হালিমা/);
  assert.equal(payload.metadata.approved_by, "Tester");
});

test("Make payload builder and missing webhook", async () => {
  const post = normalizePost(sample(2));
  assert.match(assembleCaption(post, brand), /এই পোস্টটি শুধুমাত্র শিক্ষামূলক উদ্দেশ্যে।[\s\S]*— ডা. হালিমা[\s\S]*#মাসিকের_ব্যথা$/);
  const brief = buildBrief(post, brand, "pain_solution");
  const meta = { post_id: "x", platform: "facebook", content: post, selected: "c1", candidates: [{ id: "c1", brief, generations: [{ model: "m" }] }], approval: { by: "A", at: "t" }, cost: { total_usd: 0, unknown: 1 } };
  const p = buildMakePayload({ meta, brand, images: [{ filename: "final-001.jpg", mime: "image/jpeg", url: "https://res.cloudinary.com/x.jpg" }] });
  assert.equal(p.image_url, "https://res.cloudinary.com/x.jpg");
  assert.deepEqual(Object.keys(p).slice(0, 8), ["post_id", "business", "platform", "caption", "image_url", "image_urls", "images", "image_count"]);
  const d = deps();
  await createImageJob({ post: sample(2), deps: d });
  await runAction({ postId: "sample-02", action: "approve", deps: d });
  await assert.rejects(runAction({ postId: "sample-02", action: "send", deps: { ...d, env: {} } }), { code: "MAKE_WEBHOOK_MISSING" });
});

test("Facebook scheduling window and multi-image rule", async () => {
  const now = Date.parse("2026-10-03T10:00:00Z");
  assert.equal(publishAt("2026-10-03T19:00:00+06:00", now), "2026-10-03T13:00:00.000Z");
  assert.equal(publishAt("2026-10-03T16:05:00+06:00", now), null, "less than 10 minutes ahead → publish now");
  assert.equal(publishAt("2026-12-30T10:00:00Z", now), null, "more than 30 days ahead");
  assert.equal(publishAt("", now), null);
  await assert.rejects(prepareImages({ files: ["a.jpg", "b.jpg"], postId: "x", brand, mode: "auto", cloudinaryConfigured: false }), { code: "CAROUSEL_NEEDS_URLS" });
  const one = path.join(tmp, "one.jpg");
  await sharp({ create: { width: 10, height: 10, channels: 3, background: "#fff" } }).jpeg().toFile(one);
  const viaUrl = await prepareImages({ files: [one], postId: "x", brand, mode: "url", upload: async () => "https://res.cloudinary.com/demo/one.jpg" });
  assert.deepEqual(viaUrl, [{ filename: "one.jpg", mime: "image/jpeg", url: "https://res.cloudinary.com/demo/one.jpg" }]);
});

// ── workflow ──
test("workflow refuses to skip approval", () => {
  const meta = { status: "IMAGE_REVIEW_PENDING", history: [] };
  assert.throws(() => transition(meta, "SENT_TO_MAKE"), { code: "INVALID_TRANSITION" });
  assert.throws(() => transition({ status: "TEXT_OVERLAY_APPLIED" }, "IMAGE_APPROVED"), { code: "INVALID_TRANSITION" });
  transition(meta, "IMAGE_APPROVED");
  assert.equal(meta.history.length, 1);
});

// ── HTTP API ──
test("POST /v1/image-jobs (dry run) works through the existing API", async () => {
  const server = createServer({ apiKey: "k" });
  await new Promise((r) => server.listen(0, r));
  const saved = process.env.ASSETS_DIR;
  process.env.ASSETS_DIR = path.join(tmp, "api");
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/image-jobs`, { method: "POST", headers: { Authorization: "Bearer k", "Content-Type": "application/json" }, body: JSON.stringify({ post: sample(4), dry_run: true }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.concepts[0].visual_type, "question_curiosity");
    const bad = await fetch(`http://127.0.0.1:${server.address().port}/v1/image-jobs`, { method: "POST", headers: { Authorization: "Bearer k", "Content-Type": "application/json" }, body: JSON.stringify({ post: { ...sample(4), caption: "" }, dry_run: true }) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, "EMPTY_CAPTION");
  } finally {
    if (saved === undefined) delete process.env.ASSETS_DIR;
    else process.env.ASSETS_DIR = saved;
    server.close();
  }
});
