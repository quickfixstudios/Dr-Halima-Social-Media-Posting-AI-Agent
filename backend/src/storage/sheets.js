import { GoogleAuth } from "google-auth-library";
import { config, requireConfig } from "../config.js";
import { withRetry } from "../retry.js";

/** Column order of the Content tab — must match sheets/Content.csv (A … AJ). */
export const CONTENT_COLUMNS = [
  "id", "date", "scheduled_slot", "scheduled_at", "post_type", "content_pillar", "topic", "hook_pattern", "content_goal",
  "hook_english", "hook_bangla_short", "caption", "hashtags", "cta", "script", "video_storyboard_json", "carousel_slides_json",
  "visual_prompt", "image_urls", "video_url", "status", "compliance_status", "compliance_notes", "ig_media_id", "fb_post_id",
  "published_at", "likes", "comments", "shares", "saves", "reach", "engagement_score", "metrics_updated_at", "retry_count",
  "last_error", "run_id",
];
export const PERFORMANCE_COLUMNS = ["post_id", "captured_at", "platform", "likes", "comments", "shares", "saves", "reach", "engagement_score"];
export const LOG_COLUMNS = ["timestamp", "scenario", "module", "level", "post_id", "message", "execution_id"];
const NUMERIC = new Set(["likes", "comments", "shares", "saves", "reach", "engagement_score", "retry_count"]);
const LAST_COL = "AJ";

let auth;
async function request(method, path, data) {
  const { spreadsheetId, serviceAccountJson } = config.sheets;
  requireConfig(["SPREADSHEET_ID", spreadsheetId], ["GOOGLE_SERVICE_ACCOUNT_JSON", serviceAccountJson]);
  auth ??= new GoogleAuth({ credentials: JSON.parse(serviceAccountJson), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  const client = await auth.getClient();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/${path}`;
  return withRetry(
    async () => {
      try {
        return (await client.request({ url, method, data })).data;
      } catch (err) {
        throw Object.assign(err, { status: err.response?.status ?? err.status });
      }
    },
    { label: `sheets ${method} ${path.split("?")[0]}` },
  );
}

/** Google Sheets date serial → YYYY-MM-DD (serial 0 = 1899-12-30). */
export function serialToIsoDate(v) {
  if (typeof v !== "number") return v;
  return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
}

/**
 * Value written with USER_ENTERED: the date column stays parseable as a Date; other strings get a leading
 * apostrophe so Sheets never reinterprets them (formulas, dates, numbers inside ids/timestamps).
 */
export function toCell(key, value) {
  if (value === undefined || value === null) return "";
  if (NUMERIC.has(key)) return value === "" ? "" : Number(value);
  if (key === "date") return String(value);
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s === "" ? "" : `'${s}`;
}

export function rowToPost(row, rowNumber) {
  const post = { _row: rowNumber };
  CONTENT_COLUMNS.forEach((key, i) => {
    let v = row[i] ?? "";
    if (key === "date") v = serialToIsoDate(v);
    else if (NUMERIC.has(key)) v = v === "" ? null : Number(v);
    post[key] = v;
  });
  return post;
}

/** Flatten a generated post + runtime fields into a Content row. */
export function postToRow(post) {
  const flat = {
    ...post,
    hashtags: Array.isArray(post.hashtags) ? post.hashtags.join(" ") : post.hashtags,
    video_storyboard_json: post.video_storyboard_json ?? JSON.stringify(post.video_storyboard ?? []),
    carousel_slides_json: post.carousel_slides_json ?? JSON.stringify(post.carousel_slides ?? []),
    image_urls: Array.isArray(post.image_urls) ? post.image_urls.join(",") : post.image_urls,
  };
  return CONTENT_COLUMNS.map((key) => toCell(key, flat[key]));
}

export async function readContent() {
  const data = await request("GET", `values/Content!A2:${LAST_COL}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`);
  return (data.values ?? []).map((row, i) => rowToPost(row, i + 2)).filter((p) => p.id);
}

export async function appendContent(posts) {
  return request("POST", `values/Content!A1:${LAST_COL}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, { values: posts.map(postToRow) });
}

/** Update selected columns of one Content row (by sheet row number). */
export async function updateContent(rowNumber, patch) {
  const data = Object.entries(patch).map(([key, value]) => {
    const col = CONTENT_COLUMNS.indexOf(key);
    if (col < 0) throw new Error(`Unknown Content column ${key}`);
    return { range: `Content!${columnLetter(col)}${rowNumber}`, values: [[toCell(key, value)]] };
  });
  return request("POST", "values:batchUpdate", { valueInputOption: "USER_ENTERED", data });
}

export async function appendPerformance(records) {
  const values = records.map((r) => PERFORMANCE_COLUMNS.map((k) => (["post_id", "captured_at", "platform"].includes(k) ? `'${r[k]}` : r[k])));
  return request("POST", "values/Performance!A1:I:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", { values });
}

export async function appendLog({ module, level = "info", post_id = "", message, execution_id = "" }) {
  const row = [new Date().toISOString(), "backend", module, level, post_id, message, execution_id].map((v) => `'${v}`);
  return request("POST", "values/Logs!A1:G:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", { values: [row] });
}

export async function readTopicBank() {
  const data = await request("GET", "values/Topic_Bank!A2:C?valueRenderOption=UNFORMATTED_VALUE");
  return (data.values ?? []).filter((r) => r[0] && r[1]).map(([content_pillar, topic, priority]) => ({ content_pillar, topic, priority }));
}

export function columnLetter(index) {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
