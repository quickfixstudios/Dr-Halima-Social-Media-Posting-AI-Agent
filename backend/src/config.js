import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const list = (v, d) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
const bool = (v, d = false) => (v === undefined || v === "" ? d : v === "true");
const num = (v, d = null) => (v === undefined || v === "" ? d : Number(v));

/** Repository root (one level above backend/). brands/, posts/ and assets/ live there. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const config = {
  port: Number(process.env.PORT ?? 8080),
  apiKey: process.env.BACKEND_API_KEY,
  openai: {
    textModel: process.env.TEXT_MODEL ?? "gpt-6.1-sol",
    imageModel: process.env.IMAGE_MODEL ?? "gpt-image-1",
    imageModelFallback: process.env.IMAGE_MODEL_FALLBACK ?? "gpt-image-2",
    imageQuality: process.env.IMAGE_QUALITY ?? "high",
    carouselSlideImages: bool(process.env.CAROUSEL_SLIDE_IMAGES),
  },
  cloudinary: {
    cloud: process.env.CLOUDINARY_CLOUD_NAME,
    preset: process.env.CLOUDINARY_UPLOAD_PRESET,
  },
  sheets: {
    spreadsheetId: process.env.SPREADSHEET_ID,
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  },
  meta: {
    graphVersion: process.env.GRAPH_API_VERSION ?? "v23.0",
    pageToken: process.env.META_PAGE_ACCESS_TOKEN,
  },
  schedule: {
    timezone: process.env.TIMEZONE ?? "Asia/Dhaka",
    slotTimes: list(process.env.SLOT_TIMES, "10:00,13:00,16:00,19:00,22:00"),
    reelSlots: list(process.env.REEL_SLOTS, "slot2,slot4"),
  },
  reelsMode: process.env.REELS_MODE ?? "await_video",
  approvalRequired: bool(process.env.APPROVAL_REQUIRED),
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
  logLevel: process.env.LOG_LEVEL ?? "info",

  // Image automation (backend/src/imaging, IMAGE_AUTOMATION.md). Read lazily via imagingConfig() so tests can change env.
  get imaging() {
    return imagingConfig();
  },
};

export function imagingConfig(env = process.env) {
  return {
    textModel: env.OPENAI_TEXT_MODEL || env.TEXT_MODEL || "gpt-6.1-sol",
    // Deliberately NOT falling back to the old IMAGE_MODEL (that one belongs to the legacy image step).
    imageModel: env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst",
    // Newer GPT image models accept any WIDTHxHEIGHT divisible by 16; older ones only the 3 standard sizes.
    arbitrarySizes: bool(env.IMAGE_MODEL_ARBITRARY_SIZES, true),
    quality: env.IMAGE_QUALITY || "high",
    timeoutMs: num(env.IMAGE_TIMEOUT_MS, 180_000),
    retries: num(env.IMAGE_RETRIES, 3),
    dryRun: bool(env.IMAGE_GENERATION_DRY_RUN),
    pipelineVersion: env.IMAGE_PIPELINE === "v2" ? "v2" : "v1", // v2 = new reviewed pipeline inside the daily run
    textMode: env.IMAGE_TEXT_MODE === "model" ? "model" : "overlay", // "overlay" = Pipeline A (default), "model" = Pipeline B (experimental)
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
