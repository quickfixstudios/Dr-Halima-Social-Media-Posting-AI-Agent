import { createLogger, errorMeta } from "./logger.js";

const log = createLogger("alerts");

/**
 * Failure alerts. Posts a short message to ALERT_WEBHOOK_URL — works with Slack
 * incoming webhooks ({text}), Discord ({content}) and most generic receivers.
 * Never throws: alerting must not break the pipeline.
 */
export async function sendAlert(title, details = {}) {
  const text = `🚨 Dr. Halima agent: ${title}\n${Object.entries(details).map(([k, v]) => `• ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n")}`;
  log.error(title, details);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text.slice(0, 2000) }),
    });
    if (!res.ok) log.warn("Alert webhook returned non-2xx", { status: res.status });
  } catch (err) {
    log.warn("Alert webhook failed", errorMeta(err));
  }
}
