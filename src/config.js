import "dotenv/config";
import path from "node:path";

function list(value, fallback) {
  return (value ?? fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");

export const config = {
  claude: {
    model: process.env.CLAUDE_MODEL ?? "claude-opus-5-5",
    effort: process.env.CLAUDE_EFFORT ?? "high",
  },
  openai: {
    imageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
    quality: process.env.OPENAI_IMAGE_QUALITY ?? "high",
    carouselSlideImages: process.env.CAROUSEL_SLIDE_IMAGES === "true",
  },
  media: {
    host: process.env.MEDIA_HOST ?? "cloudinary",
    cloudinaryCloud: process.env.CLOUDINARY_CLOUD_NAME,
    cloudinaryPreset: process.env.CLOUDINARY_UPLOAD_PRESET,
    publicBaseUrl: process.env.PUBLIC_MEDIA_BASE_URL,
  },
  buffer: {
    accessToken: process.env.BUFFER_ACCESS_TOKEN,
    profileIds: list(process.env.BUFFER_PROFILE_IDS, ""),
    apiBase: process.env.BUFFER_API_BASE ?? "https://api.bufferapp.com/1",
    reelsMode: process.env.REELS_MODE ?? "await_video",
  },
  schedule: {
    timezone: process.env.TIMEZONE ?? "Asia/Dhaka",
    postTimes: list(process.env.POST_TIMES, "10:00,13:00,16:00,19:00,22:00"),
    generateCron: process.env.GENERATE_CRON ?? "15 6 * * *",
    engagementCron: process.env.ENGAGEMENT_CRON ?? "30 23 * * *",
  },
  paths: {
    dataDir,
    db: path.join(dataDir, "db.json"),
    media: path.join(dataDir, "media"),
    content: path.resolve("./content"),
  },
  logLevel: process.env.LOG_LEVEL ?? "info",
};

export function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}
