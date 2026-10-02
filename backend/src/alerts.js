import { config } from "./config.js";
import { createLogger, errorMeta } from "./logger.js";

const log = createLogger("alerts");

/** Post an alert to ALERT_WEBHOOK_URL (Slack-compatible {text}). Never throws. */
export async function alert(title, details = {}, level = "error") {
  const lines = Object.entries(details).map(([k, v]) => `• ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const text = `${level === "error" ? "🚨" : "ℹ️"} Dr. Halima Content OS — ${title}\n${lines.join("\n")}`;
  log[level === "error" ? "error" : "info"](title, details);
  if (!config.alertWebhookUrl) return;
  try {
    const res = await fetch(config.alertWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) log.warn("alert webhook non-2xx", { status: res.status });
  } catch (err) {
    log.warn("alert webhook failed", errorMeta(err));
  }
}
