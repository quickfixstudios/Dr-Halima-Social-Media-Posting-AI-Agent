import { config, requireEnv } from "./config.js";
import { createLogger } from "./logger.js";
import { withRetry } from "./utils/retry.js";
import { DISCLAIMER } from "./safety.js";

const log = createLogger("buffer");
const INSTAGRAM_CAPTION_LIMIT = 2200;

/**
 * Thin client for Buffer's REST API (v1: https://api.bufferapp.com/1).
 * Endpoints used:
 *   POST /updates/create.json   – queue/schedule a post on one or more profiles
 *   GET  /updates/:id.json      – read a sent update incl. `statistics`
 *   GET  /profiles.json         – list connected channels (to find profile IDs)
 * If your Buffer account is on the newer GraphQL API, re-implement these three
 * functions; the rest of the system only depends on their return shapes.
 */
async function bufferRequest(method, endpoint, params = {}) {
  requireEnv("BUFFER_ACCESS_TOKEN");
  const url = new URL(`${config.buffer.apiBase}${endpoint}`);
  url.searchParams.set("access_token", config.buffer.accessToken);

  const init = { method, headers: { Accept: "application/json" } };
  if (method === "POST") {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined && v !== null) body.append(key, String(v));
    }
    init.body = body;
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  return withRetry(
    async () => {
      const res = await fetch(url, init);
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.success === false) {
        const err = new Error(`Buffer ${method} ${endpoint} failed (${res.status}): ${json.message ?? json.error ?? res.statusText}`);
        err.status = res.status;
        throw err;
      }
      return json;
    },
    { label: `buffer ${endpoint}` },
  );
}

export function buildPostText(post) {
  const tags = post.hashtags.join(" ");
  const full = `${post.hook_english}\n\n${post.caption}\n\n${tags}`;
  if (full.length <= INSTAGRAM_CAPTION_LIMIT) return full;
  // Drop the duplicated hook, then trim the body while keeping the disclaimer + hashtags at the end.
  const tail = `\n\n${DISCLAIMER}\n\n${tags}`;
  const body = post.caption.replace(DISCLAIMER, "").trim();
  return body.slice(0, INSTAGRAM_CAPTION_LIMIT - tail.length - 1) + "…" + tail;
}

/**
 * Schedule one post on all configured Buffer profiles.
 * @param {object} post      stored post record
 * @param {object} opts
 * @param {Date}   opts.scheduledAt  UTC publish time
 * @param {string[]} opts.mediaUrls  public URLs (first = cover)
 * @param {string} [opts.videoUrl]   public video URL for reels
 * @returns {Promise<{ profile_id: string, update_id: string }[]>}
 */
export async function postToBuffer(post, { scheduledAt, mediaUrls = [], videoUrl, now = false }) {
  const profileIds = config.buffer.profileIds;
  if (!profileIds.length) throw new Error("BUFFER_PROFILE_IDS is empty");

  const params = {
    "profile_ids[]": profileIds,
    text: buildPostText(post),
    shorten: "false",
    ...(now ? { now: "true" } : { scheduled_at: scheduledAt.toISOString() }),
  };
  if (videoUrl) {
    params["media[video]"] = videoUrl;
    if (mediaUrls[0]) params["media[thumbnail]"] = mediaUrls[0];
  } else if (mediaUrls[0]) {
    params["media[photo]"] = mediaUrls[0];
    params["media[thumbnail]"] = mediaUrls[0];
    // Additional carousel images.
    mediaUrls.slice(1).forEach((url, i) => {
      params[`extra_media[${i}][photo]`] = url;
      params[`extra_media[${i}][thumbnail]`] = url;
    });
  }

  const json = await bufferRequest("POST", "/updates/create.json", params);
  const updates = (json.updates ?? []).map((u) => ({ profile_id: u.profile_id, update_id: u.id }));
  log.info(now ? "Published via Buffer" : "Scheduled on Buffer", { postId: post.id, scheduledAt: scheduledAt?.toISOString(), updates });
  return updates;
}

/** Fetch engagement stats for a sent update, normalised across networks. */
export async function getUpdateStats(updateId) {
  const update = await bufferRequest("GET", `/updates/${updateId}.json`);
  const s = update.statistics ?? {};
  return {
    status: update.status,
    likes: s.likes ?? s.favorites ?? s.reactions ?? 0,
    comments: s.comments ?? s.replies ?? 0,
    shares: s.shares ?? s.retweets ?? s.reshares ?? 0,
    saves: s.saves ?? 0,
    clicks: s.clicks ?? 0,
    reach: s.reach ?? s.impressions ?? 0,
  };
}

export async function listProfiles() {
  return bufferRequest("GET", "/profiles.json");
}
