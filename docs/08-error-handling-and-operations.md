# 8. Error handling, logging, alerts and operations

## 8.1 Retry policy (3 attempts everywhere)

| Call | Retry on | Backoff | Do not retry |
|---|---|---|---|
| OpenAI `/v1/responses` | 408, 409, 429, 5xx, timeout, `incomplete` (max_output_tokens → +50% tokens) | 60 s × attempt (Make) / 2^n s + jitter (backend) | 400 (bad schema/model), 401/403, `refusal` |
| OpenAI `/v1/images/generations` | 429, 5xx, timeout | 120 s / 2^n s | 400 content-policy → regenerate prompt once with a softer visual description, then `needs_review`; 400/404 model → switch to fallback model |
| Cloudinary | 429, 5xx, network | 30 s | 4xx config errors |
| Instagram / Facebook publish | 4xx code 4/17/32/613 (rate limit), 5xx, "media not ready" | 5 min | 190 (token expired), 10/200 (permissions), 100 (invalid parameter) |
| Google Sheets | 429, 5xx | 30 s | 403 permissions |

Make implementation: **Break** error handler (3 attempts, interval as above) + scenario setting
**Allow storing of incomplete executions = ON**. Backend: `withRetry()` in `backend/src/retry.js`.

## 8.2 Logging

- **Make:** every scenario ends with a `Logs` row (`info`); every error route writes a `Logs` row (`error`)
  with scenario, module, post id, message and execution ID. Make's own execution history is kept 7 days on Free.
- **Backend:** structured JSON lines (`ts, level, scope, msg, …meta`) to stdout — ship to your host's log
  viewer (Render/Railway/Fly) or a log platform. Every run carries `run_id`.
- **OpenAI usage:** input/output/cached tokens logged per call for cost tracking.

## 8.3 Alerts

| Event | Severity | Channel |
|---|---|---|
| Daily generation failed after retries | critical | Slack/Email immediately |
| Post blocked by compliance (`needs_review`) | high | Slack/Email (editor) |
| Reel awaiting video (daily digest) | normal | Slack/Email (editor) at 06:10 |
| Publish failed after retries / slot skipped | high | Slack/Email |
| Token expiring / 190 errors | critical | Slack/Email |
| Engagement sync failed | low | Logs only (+ digest) |

Backend alerts go to `ALERT_WEBHOOK_URL` (Slack incoming webhook or any endpoint accepting `{text}`).

## 8.4 Runbook

| Symptom | Check | Fix |
|---|---|---|
| No rows for today at 06:15 | Make S1 history / backend logs for `run_id` | Re-run S1 (idempotent) or `POST /v1/daily-run` |
| Row stuck in `publishing` | Was it posted on IG/FB? | If posted: fill `ig_media_id`/`fb_post_id`, set `published`; if not: set `ready` |
| Instagram error "media URL" | Open `image_urls` in a private window | Fix Cloudinary preset to public delivery |
| `gpt-image-1` model errors | Date ≥ 2026-10-23? | Set `IMAGE_MODEL = gpt-image-2` |
| Repetitive topics | `Insights!B41` populated? | Check `Content!B` is a real Date column |
| Error 190 from Meta | Page token expired/revoked | Re-issue a System User token; update Make connection / backend env |

## 8.5 Deployment checklist

1. OpenAI: project + key, monthly budget limit, usage alerts.
2. Meta: Business Manager, Facebook Page ↔ Instagram Business account linked, System User with the
   permissions listed in §1.7, Page Publishing Authorization done if required.
3. Cloudinary: unsigned upload preset (folder `dr-halima`, allowed formats jpg/png/mp4).
4. Google: spreadsheet + tabs + named ranges; service account shared as Editor (Mode B).
5. Make: org time zone Asia/Dhaka; connections; build S1/S2(/S3); scenario settings (§3.0);
   run S1 once manually, check rows; run S2 manually with a test row; then activate.
6. Backend (Mode B): deploy `backend/` (Node ≥ 20) to Render/Railway/Fly; set env from `.env.example`;
   `GET /healthz`; `POST /v1/generate` dry run; point Make S1-B at `/v1/daily-run`.
7. First week: keep every post on manual approval (`APPROVAL_REQUIRED=true` → rows land as `needs_review`)
   until the medical reviewer is satisfied, then switch to automatic.

## 8.6 Cost envelope (per day, indicative)

| Item | Volume | Notes |
|---|---|---|
| Content + compliance calls | 2 Responses calls (~6k in / ~15k out tokens) | gpt-6.1-sol; system prompt cached daily |
| Images | 5–17 images | 5 with cover-only carousels; quality `high` |
| Make | ≈ 32 ops/day (Mode B) · ≈ 155–190 ops/day (Mode A) | see §3.6 |
| Cloudinary | ≈ 2–8 MB/day | free tier is sufficient |
