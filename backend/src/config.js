import "dotenv/config";

const list = (v, d) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
const bool = (v, d = false) => (v === undefined ? d : v === "true");

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
};

export function requireConfig(...pairs) {
  const missing = pairs.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Missing configuration: ${missing.join(", ")}`);
}
