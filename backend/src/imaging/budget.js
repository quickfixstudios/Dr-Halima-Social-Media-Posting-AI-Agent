import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { ImageError } from "./errors.js";

/**
 * Cost controls + usage ledger.
 *
 * Every image-model call (successful or failed) is appended as one JSON line to <ASSETS_DIR>/_ledger.jsonl.
 * Before each call, checkBudget() refuses to spend when a limit is reached.
 * Prices come from backend/config/image-pricing.json only — nothing is hard-coded; unknown prices stay unknown.
 */

export function loadPricing(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { models: {} };
  }
}

/**
 * @returns {{ usd: number|null, basis: string }}
 */
export function estimateCost(pricing, { model, size, quality, usage }) {
  const p = pricing?.models?.[model];
  if (!p) return { usd: null, basis: `no pricing configured for ${model}` };
  const t = p.per_1m_tokens ?? {};
  if (usage && t.image_output != null) {
    const details = usage.input_tokens_details ?? {};
    const textIn = details.text_tokens ?? usage.input_tokens ?? 0;
    const imageIn = details.image_tokens ?? 0;
    const out = usage.output_tokens ?? 0;
    if ((textIn && t.text_input == null) || (imageIn && t.image_input == null)) return { usd: null, basis: "incomplete token pricing" };
    const usd = (textIn * (t.text_input ?? 0) + imageIn * (t.image_input ?? 0) + out * t.image_output) / 1e6;
    return { usd: Math.round(usd * 1e5) / 1e5, basis: "API-reported token usage × configured token prices" };
  }
  const perImage = p.per_image?.[`${size}:${quality}`] ?? p.per_image?.[quality];
  if (perImage != null) return { usd: perImage, basis: "configured per-image price" };
  return { usd: null, basis: "price unknown (fill backend/config/image-pricing.json)" };
}

export class Ledger {
  constructor(assetsDir, { timezone = "Asia/Dhaka" } = {}) {
    this.file = path.join(assetsDir, "_ledger.jsonl");
    this.timezone = timezone;
  }

  entries() {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  record(entry) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  /** Totals for a day/month (Dhaka time) and per post. */
  summary(now = DateTime.now()) {
    const local = now.setZone(this.timezone);
    const day = local.toISODate();
    const month = local.toFormat("yyyy-LL");
    const s = { day, month, today: { generations: 0, failed: 0, usd: 0, unknown: 0 }, month_total: { generations: 0, failed: 0, regenerations: 0, usd: 0, unknown: 0 }, posts: {} };
    for (const e of this.entries()) {
      const d = DateTime.fromISO(e.ts).setZone(this.timezone);
      const key = `${e.business}/${e.post_id}`;
      s.posts[key] ??= { generations: 0, regenerations: 0, failed: 0, usd: 0, unknown: 0 };
      const p = s.posts[key];
      const add = (b) => {
        if (e.status === "failed") b.failed += 1;
        else b.generations += 1;
        if (e.kind === "regenerate" && "regenerations" in b) b.regenerations += 1;
        if (e.cost_usd == null) b.unknown += e.status === "failed" ? 0 : 1;
        else b.usd = Math.round((b.usd + e.cost_usd) * 1e5) / 1e5;
      };
      add(p);
      if (d.toISODate() === day) add(s.today);
      if (d.toFormat("yyyy-LL") === month) add(s.month_total);
    }
    return s;
  }
}

/**
 * Throw an ImageError(BUDGET_*) if one more generation would break a limit.
 * Failed calls count towards the daily limit too (they may still be billed).
 * @returns {string[]} warnings (e.g. a USD budget that cannot be enforced because prices are unknown)
 */
export function checkBudget({ ledger, limits, business, postId, kind, now }) {
  const s = ledger.summary(now);
  const p = s.posts[`${business}/${postId}`] ?? { generations: 0, regenerations: 0, failed: 0, usd: 0, unknown: 0 };
  const warnings = [];
  if (limits.maxGenerationsPerPost != null && p.generations >= limits.maxGenerationsPerPost) {
    throw new ImageError("BUDGET_POST_LIMIT", `Post ${postId} already has ${p.generations} generated images (MAX_IMAGE_GENERATIONS_PER_POST=${limits.maxGenerationsPerPost}).`);
  }
  if (kind === "regenerate" && limits.maxRegenerations != null && p.regenerations >= limits.maxRegenerations) {
    throw new ImageError("BUDGET_REGENERATION_LIMIT", `Post ${postId} has been regenerated ${p.regenerations} times (MAX_REGENERATIONS=${limits.maxRegenerations}). Edit the prompt or headline instead, or raise the limit.`);
  }
  const todayCalls = s.today.generations + s.today.failed;
  if (limits.dailyGenerationLimit != null && todayCalls >= limits.dailyGenerationLimit) {
    throw new ImageError("BUDGET_DAILY_LIMIT", `${todayCalls} image calls today (DAILY_IMAGE_GENERATION_LIMIT=${limits.dailyGenerationLimit}).`);
  }
  for (const [label, budget, bucket] of [
    ["DAILY_IMAGE_BUDGET", limits.dailyBudgetUsd, s.today],
    ["MONTHLY_IMAGE_BUDGET", limits.monthlyBudgetUsd, s.month_total],
  ]) {
    if (budget == null) continue;
    if (bucket.usd >= budget) throw new ImageError("BUDGET_EXCEEDED", `${label}=$${budget} reached ($${bucket.usd} spent).`);
    if (bucket.unknown) warnings.push(`${label} cannot be fully enforced: ${bucket.unknown} image(s) have an unknown price (fill backend/config/image-pricing.json).`);
  }
  return warnings;
}
