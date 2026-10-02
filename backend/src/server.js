import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";
import { dailyRun, buildBatch } from "./pipeline.js";
import { syncEngagement } from "./sync.js";
import { readContent } from "./storage/sheets.js";
import { computeInsights, planDay } from "./learning.js";
import { reviewCompliance } from "./openai/content.js";
import { generateImage } from "./openai/images.js";
import { decide } from "./compliance.js";
import { todayLocal } from "./schedule.js";

const log = createLogger("server");
const running = new Set();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function authorized(req, apiKey = config.apiKey) {
  if (!apiKey) return false;
  const given = Buffer.from((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(apiKey);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function readJson(req, limit = 1_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

const dateOf = (body) => {
  const date = body.date ?? todayLocal();
  if (!DATE_RE.test(date)) throw new HttpError(400, "date must be YYYY-MM-DD");
  return date;
};

/** Route table. Handlers return [status, body]. */
export const routes = {
  "GET /healthz": async () => [200, { ok: true, textModel: config.openai.textModel, imageModel: config.openai.imageModel }],

  // Async: Make gets 202 immediately; the run continues in the background and alerts on its own.
  "POST /v1/daily-run": async (body) => {
    const date = dateOf(body);
    if (running.has(date)) return [409, { status: "already_running", date }];
    running.add(date);
    const runId = `${date}-${Date.now()}`;
    dailyRun({ date, force: Boolean(body.force), runId })
      .catch((err) => log.error("daily-run crashed", { runId, ...errorMeta(err) }))
      .finally(() => running.delete(date));
    return [202, { status: "accepted", date, run_id: runId }];
  },

  "POST /v1/generate": async (body) => {
    const date = dateOf(body);
    const { plan, decisions, validationProblems } = await buildBatch(date, await readContent());
    return [200, { date, plan, daily_batch: decisions.map((d) => d.post), compliance: decisions.map(({ post, verdict, issues }) => ({ id: post.id, verdict, issues })), validation_problems: validationProblems }];
  },

  "POST /v1/images": async (body) => {
    if (!body.prompt || !body.id) throw new HttpError(400, "id and prompt are required");
    const result = await generateImage({ prompt: body.prompt, postType: body.post_type ?? "image", publicId: `${body.id}-${body.suffix ?? "cover"}`, folder: `dr-halima/${body.id.slice(0, 10)}` });
    return [200, result];
  },

  "POST /v1/compliance": async (body) => {
    if (!Array.isArray(body.posts) || !body.posts.length) throw new HttpError(400, "posts[] required");
    const decisions = decide(body.posts, await reviewCompliance(body.posts));
    return [200, { results: decisions.map(({ post, verdict, issues }) => ({ id: post.id, verdict, issues, post })) }];
  },

  "POST /v1/sync": async () => [200, await syncEngagement()],

  "GET /v1/insights": async (_body, url) => {
    const date = url.searchParams.get("date") ?? todayLocal();
    const insights = computeInsights((await readContent()).filter((p) => p.date !== date));
    return [200, { date, insights, plan: planDay(insights, { date }) }];
  },
};

export function createServer({ apiKey = config.apiKey } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const key = `${req.method} ${url.pathname}`;
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const handler = routes[key];
      if (!handler) return send(404, { error: "Not found" });
      if (key !== "GET /healthz" && !authorized(req, apiKey)) return send(401, { error: "Unauthorized" });
      const body = req.method === "POST" ? await readJson(req) : {};
      const [status, payload] = await handler(body, url);
      send(status, payload);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      log.error("Request failed", { route: key, ...errorMeta(err) });
      send(status, { error: err.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!config.apiKey) throw new Error("BACKEND_API_KEY is required");
  createServer().listen(config.port, () => log.info("Listening", { port: config.port }));
}
