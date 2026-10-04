import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bool = (v, d = false) => (v === undefined || v === "" ? d : v === "true");
const num = (v, d = null) => (v === undefined || v === "" ? d : Number(v));

/** Repository root (one level above backend/). brands/, posts/ and assets/ live there. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const config = {
  port: Number(process.env.PORT ?? 8080),
  apiKey: process.env.BACKEND_API_KEY,
  timezone: process.env.TIMEZONE ?? "Asia/Dhaka",
  cloudinary: {
    cloud: process.env.CLOUDINARY_CLOUD_NAME,
    preset: process.env.CLOUDINARY_UPLOAD_PRESET,
  },
  logLevel: process.env.LOG_LEVEL ?? "info",
};

export function imagingConfig(env = process.env) {
  return {
    textModel: env.OPENAI_TEXT_MODEL || env.TEXT_MODEL || "gpt-6-luna",
    imageModel: env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
    // Newer GPT image models accept any WIDTHxHEIGHT divisible by 16; older ones only the 3 standard sizes.
    arbitrarySizes: bool(env.IMAGE_MODEL_ARBITRARY_SIZES, true),
    quality: env.IMAGE_QUALITY || "high",
    timeoutMs: num(env.IMAGE_TIMEOUT_MS, 180_000),
    retries: num(env.IMAGE_RETRIES, 3),
    dryRun: bool(env.IMAGE_GENERATION_DRY_RUN),
    // "model" (default) = GPT Image draws the whole infographic incl. Bangla text, read back by textCheck.js;
    // "overlay" = GPT Image draws only the picture and our renderer writes the Bangla text.
    textMode: env.IMAGE_TEXT_MODE === "overlay" ? "overlay" : "model",
    textCheck: {
      enabled: bool(env.IMAGE_TEXT_CHECK, true),
      retries: num(env.IMAGE_TEXT_CHECK_RETRIES, 2), // extra generations when a Bangla line is misspelled
      threshold: num(env.IMAGE_TEXT_CHECK_THRESHOLD, 0.97), // 1 = letter-perfect
    },
    shortenWithLlm: bool(env.IMAGE_TEXT_SHORTEN_WITH_LLM),
    defaultBusiness: env.IMAGE_DEFAULT_BUSINESS || "dr_halima",
    brandsDir: env.BRANDS_DIR || path.join(REPO_ROOT, "brands"),
    postsDir: env.POSTS_DIR || path.join(REPO_ROOT, "posts"),
    assetsDir: env.ASSETS_DIR || path.join(REPO_ROOT, "assets"),
    pricingFile: env.IMAGE_PRICING_FILE || path.join(REPO_ROOT, "backend/config/image-pricing.json"),
    limits: {
      maxGenerationsPerPost: num(env.MAX_IMAGE_GENERATIONS_PER_POST, 6),
      maxRegenerations: num(env.MAX_REGENERATIONS, 3),
      dailyGenerationLimit: num(env.DAILY_IMAGE_GENERATION_LIMIT, 25),
      dailyBudgetUsd: num(env.DAILY_IMAGE_BUDGET),
      monthlyBudgetUsd: num(env.MONTHLY_IMAGE_BUDGET),
    },
    review: {
      host: env.REVIEW_HOST || "127.0.0.1",
      port: num(env.REVIEW_PORT, 8091),
      password: env.REVIEW_PASSWORD,
    },
    makeImageDelivery: env.MAKE_IMAGE_DELIVERY || "auto", // auto | url | base64
  };
}

export function requireConfig(...pairs) {
  const missing = pairs.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
}
