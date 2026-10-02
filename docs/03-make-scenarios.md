# 3. Make.com scenario design

Module names below match the apps available in your Make organization (Instagram for Business,
Facebook Pages, Google Sheets, HTTP, JSON, Flow Control, Tools, Email/Slack).
Make formulas use Make syntax: arguments separated by `;`, text arguments unquoted, arrays 1-indexed.

## 3.0 One-time setup

1. **Timezone.** Organization settings → Time zone = `Asia/Dhaka` (scheduling uses it). Profile → Time zone =
   `Asia/Dhaka` (display). Spreadsheet → File → Settings → Time zone = `(GMT+06:00) Dhaka`.
2. **Google Sheet** "Dr Halima – Content OS" with tabs `Content`, `Performance`, `Insights`, `Config`,
   `Topic_Bank`, `Logs`. Paste headers from [`sheets/*.csv`](../sheets) into row 1. Build `Insights` from
   [`sheets/Insights.formulas.md`](../sheets/Insights.formulas.md). Format `Content!B:B` as Date.
3. **Connections:** Google Sheets (OAuth), Instagram for Business + Facebook Pages (same Facebook login,
   Page with linked IG Business account), Email or Slack (alerts).
4. **Keys in modules, not Sheets:** OpenAI key → HTTP header `Authorization: Bearer sk-...`;
   Cloudinary unsigned upload preset name; Facebook Page token (sync only) → HTTP query `access_token`.
5. Scenario settings for every scenario: **Allow storing of incomplete executions = ON** (required for
   Break-directive retries), **Sequential processing = ON** (no overlapping runs), Max number of cycles = 1.

---

## 3.1 Scenario S1 — Daily Generator

**Schedule:** Every day at **06:00** (Asia/Dhaka).
**Purpose:** learning context → ChatGPT batch → compliance → images → Content rows.

| # | Module | Configuration |
|---|---|---|
| 1 | **Schedule** (scenario trigger) | Every day, 06:00 |
| 2 | **Tools › Set multiple variables** | `run_date` = `{{formatDate(now; YYYY-MM-DD; Asia/Dhaka)}}` · `run_id` = `{{formatDate(now; YYYYMMDD-HHmmss; Asia/Dhaka)}}` |
| 3 | **Google Sheets › Search Rows** (idempotency guard) | Sheet `Content`, filter `date` = `{{run_date}}`, limit 1 |
| 4 | **Filter** (between 3 → 5) | Continue only if `{{3.__IMTLENGTH__}}` = 0 (no batch for today yet). Re-runs never double-generate. |
| 5 | **Google Sheets › Get a Cell** | `Insights!B2` → JSON-escaped user prompt (see Insights formulas) |
| 6 | **Google Sheets › Get a Cell** | `Config!B18` → JSON-escaped system prompt (`SYSTEM_PROMPT_ESCAPED`) |
| 7 | **HTTP › Make a request** — *Generate batch* | POST `https://api.openai.com/v1/responses`; headers `Authorization: Bearer {{OPENAI_KEY}}`, `Content-Type: application/json`; body type Raw / JSON; body = [§4.1 request](04-api-requests.md#41-chatgpt-content-generation--responses-api) with `{{6.value}}` as `instructions` and `{{5.value}}` as `input`; **Parse response = Yes**; timeout 300 s. **Error handler → Break** (3 attempts, 60 s interval). |
| 8 | **Filter** | `{{7.statusCode}}` = 200 AND `{{7.data.status}}` = `completed` — else route to alert (error route) |
| 9 | **JSON › Parse JSON** | JSON string = `{{get(get(get(last(7.data.output); content); 1); text)}}` (the last output item is the assistant message; reasoning items come first). Data structure: generated from `prompts/daily_batch.schema.json` sample. |
| 10a | **JSON › Create JSON** | Data structure `text_wrapper` = `{ input: Text }`; `input` = the raw batch JSON text from module 9's input (`{{get(get(get(last(7.data.output); content); 1); text)}}`). Output is the batch safely escaped as a JSON string. |
| 10 | **HTTP › Make a request** — *Compliance review* | POST `https://api.openai.com/v1/responses`; raw JSON body = §4.3 with `"instructions": "{{Config!B20}}"` and `"input": {{replace(10a.json; /^\{"input":|\}$/g; emptystring)}}` (strips the wrapper, leaving a quoted, escaped string). **Break**: 3 attempts, 60 s. |
| 11 | **JSON › Parse JSON** | `reviews[]` from the compliance response (same `get(last(...))` path) |
| 12 | **Flow Control › Iterator** | Array = `{{9.daily_batch}}` (5 bundles) |
| 13 | **Tools › Set multiple variables** | `slot_time` = `{{switch(12.scheduled_slot; slot1; 10:00; slot2; 13:00; slot3; 16:00; slot4; 19:00; slot5; 22:00)}}` · `scheduled_at` = `{{2.run_date}}T{{slot_time}}:00+06:00` (Asia/Dhaka is UTC+6 all year, so plain text is exact) · `verdict` = `{{first(map(11.reviews; verdict; id; 12.id))}}` · `issues` = `{{join(flatten(map(11.reviews; issues; id; 12.id)); "; ")}}` · `fix_caption` = `{{get(first(map(11.reviews; suggested_fix; id; 12.id)); caption)}}` · `caption_final` = `{{if(verdict = fix and fix_caption != emptystring; fix_caption; 12.caption)}}` · `copy` = hook + script + `caption_final` + CTA · `rule_hit` = `{{length(copy) != length(replace(copy; /<Stage-1 regex>/gi; emptystring))}}` (Make's `replace()` accepts regex, so no extra module is needed) · `blocked` = `{{verdict = block or rule_hit}}` · `hashtags_text` = `{{join(12.hashtags; " ")}}` |
| 14 | **Router** | 4 routes. Route D has filter `blocked = true`; routes A/B/C each require `blocked = false` plus their post-type filter |

**Route D — Blocked / needs review** (filter: `blocked` = `true`)

| # | Module | Configuration |
|---|---|---|
| D1 | Google Sheets › Add a Row | Content: all text columns, `status` = `needs_review`, `compliance_status` = `block`, `compliance_notes` = `{{issues}}` (+ "rule scan hit" when `rule_hit`) |
| D2 | Email › Send an email / Slack › Create a message | "Post {{12.id}} held for compliance review: {{issues}}" |

**Route A — Reel** (filter: `12.post_type` = `reel`)

| # | Module | Configuration |
|---|---|---|
| A1 | JSON › Create JSON | Data structure `image_request` → `{model: IMAGE_MODEL, prompt: 12.visual_prompt, size: 1024x1536, quality: high, output_format: jpeg, output_compression: 85, n: 1}` |
| A2 | HTTP › Make a request — *gpt-image* | POST `https://api.openai.com/v1/images/generations`, body `{{A1.json}}`, parse response; **Break** 3 attempts / 120 s; error route with fallback model (see §3.5) |
| A3 | HTTP › Make a request — *Cloudinary upload* | POST `https://api.cloudinary.com/v1_1/<cloud>/image/upload`, multipart: `file` = `data:image/jpeg;base64,{{A2.data.data[1].b64_json}}`, `upload_preset`, `folder` = `dr-halima/{{run_date}}`, `public_id` = `{{12.id}}-cover`; Break 3 attempts |
| A4 | Google Sheets › Add a Row | Content row: all fields + `image_urls` = `{{A3.data.secure_url}}`, `video_storyboard_json` = `{{toString(12.video_storyboard)}}`* , `status` = `{{if(REELS_MODE = cover_only; ready; awaiting_video)}}` |
| A5 | Email/Slack | "Reel {{12.id}} for {{slot_time}} needs a video: storyboard in row; upload MP4 and paste video_url" |

\*Use a JSON › Create JSON module with an "Any" array structure, or map the array into a Text aggregator, to
serialise arrays to text for Sheets.

**Route B — Single image** (filter: `12.post_type` = `image`)
B1 Create JSON (size `1024x1024`) → B2 HTTP gpt-image → B3 HTTP Cloudinary → B4 Sheets Add a Row
(`status` = `ready`, `carousel_slides_json` = the one overlay slide).

**Route C — Carousel** (filter: `12.post_type` = `carousel`)

| # | Module | Configuration |
|---|---|---|
| C1 | Flow Control › Iterator | Array = `{{12.carousel_slides}}` |
| C2 | JSON › Create JSON | prompt = slide 1: `12.visual_prompt`; slides ≥ 2: "Instagram carousel slide, 4:5, soft pastel women's-health brand… Headline: {{C1.headline}} Body: {{C1.body}} Design: {{C1.visual_direction}}" — via `{{if(C1.slide_number = 1; 12.visual_prompt; …)}}`; size `1024x1536` |
| C3 | HTTP — gpt-image | as A2 |
| C4 | HTTP — Cloudinary | `public_id` = `{{12.id}}-s{{C1.slide_number}}` |
| C5 | Flow Control › Array aggregator | Source module = C1; aggregated field = `C4.data.secure_url` |
| C6 | Google Sheets › Add a Row | `image_urls` = `{{join(map(C5.array; secure_url); ",")}}`, `status` = `ready` |

> **Operations saver:** set `CAROUSEL_SLIDE_IMAGES = false` (Config) and add a filter after C1 that only
> lets `slide_number = 1` through — the cover is generated, other slides are designed from
> `carousel_slides_json` in a template tool (Canva/Placid) or rendered later.

**After the routes**

| # | Module | Configuration |
|---|---|---|
| 16 | Google Sheets › Add a Row (Logs) | `S1`, `generator`, `info`, "batch {{run_id}} stored", execution ID |
| E | **Error route on 7/10** (after Break retries exhausted) | Sheets Logs row (`error`) + Email/Slack alert "Daily generation failed: {{error.message}}" |

---

## 3.2 Scenario S2 — Publisher

**Schedule:** At regular intervals, **every 180 minutes**, start **10:00** (first day), Advanced scheduling →
time window **09:55–22:10** every day ⇒ runs at 10:00, 13:00, 16:00, 19:00, 22:00.

| # | Module | Configuration |
|---|---|---|
| 1 | Schedule | as above |
| 2 | Google Sheets › Search Rows | `Content`: `status` = `ready` AND `date` = `{{formatDate(now; YYYY-MM-DD; Asia/Dhaka)}}`; sort by `scheduled_at` asc; limit 5 |
| 3 | **Filter** "due now" | `{{parseDate(2.scheduled_at; YYYY-MM-DDTHH:mm:ssZ)}}` ≤ `{{addMinutes(now; 10)}}` |
| 4 | Router (late check) | Route "too late": `scheduled_at` < `addMinutes(now; -150)` → Sheets Update Row `status = skipped` + alert. Route "publish": otherwise |
| 5 | Google Sheets › Update a Row | `status` = `publishing` (row number `{{2.__ROW_NUMBER__}}`) — prevents double posting if a run overlaps |
| 6 | Tools › Set multiple variables | `caption_full` = `{{2.hook_english}}{{newline}}{{newline}}{{2.caption}}{{newline}}{{newline}}{{2.hashtags}}` (max 2,200 chars: `{{substring(...; 0; 2200)}}`) · `images` = `{{split(2.image_urls; ",")}}` |
| 7 | Router by `post_type` | 3 routes |

| Route | Instagram module | Facebook module |
|---|---|---|
| **reel** (filter `video_url` not empty) | Instagram for Business › **Create a reel post** — Video URL `{{2.video_url}}`, Caption `{{caption_full}}`, Share to feed = Yes | Facebook Pages › **Publish a Reel** — video URL, description `{{caption_full}}` |
| **image** | Instagram for Business › **Create a photo post** — Photo URL `{{first(images)}}`, Caption | Facebook Pages › **Create a Post with Photos** — photo URL, message |
| **carousel** | Instagram for Business › **Create a carousel post** — Media: map `images` (2–10 items, type IMAGE) | Facebook Pages › **Create a Post with Photos** — multiple photos |

Between the IG and FB modules: **Tools › Sleep 10 s** (spreads API calls). Each publish module:
**Error handler → Break, 3 attempts, 5-minute interval**.

| # | Module | Configuration |
|---|---|---|
| 8 | Google Sheets › Update a Row | `ig_media_id`, `fb_post_id`, `published_at` = `{{formatDate(now; YYYY-MM-DDTHH:mm:ssZ; Asia/Dhaka)}}`, `status` = `published` |
| 9 | Sheets › Add a Row (Logs) | info |
| E | Error route (retries exhausted) | Update Row `status = failed`, `retry_count + 1`, `last_error`; Slack/Email alert "Slot {{2.scheduled_slot}} failed: …" |

Notes:
- Facebook "Upload a Video" rejects descriptions containing numbers; use **Publish a Reel** for reels.
- Instagram requires public, directly downloadable URLs (Cloudinary/S3 — not Google Drive).
- If the Page requires Page Publishing Authorization, Instagram publishing fails until it is completed.

---

## 3.3 Scenario S3 — Engagement Sync

**Schedule:** every day **23:30**. (Free plan: put these modules at the start of S1 instead, before module 2.)

| # | Module | Configuration |
|---|---|---|
| 1 | Schedule | 23:30 |
| 2 | Google Sheets › Search Rows | `status` = `published`; limit 50 |
| 3 | Filter "sync window" | `{{formatDate(2.published_at; YYYY-MM-DD; Asia/Dhaka)}}` equals `{{formatDate(addDays(now; -1); YYYY-MM-DD; Asia/Dhaka)}}` **or** the same with `-3` **or** `-7` — three snapshots per post (day 1, 3, 7) keep operations low; day 7 is the score used for learning |
| 4 | Instagram for Business › **Get post insights** | Post ID `{{2.ig_media_id}}`; metrics `likes, comments, shares, saved, reach` (returns one bundle per metric) |
| 5 | Flow Control › Array aggregator | source 4 → array of `{name, values}` |
| 6 | HTTP › Make a request — FB stats | GET `https://graph.facebook.com/<GRAPH_VERSION>/{{2.fb_post_id}}?fields=shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)&access_token=<PAGE_TOKEN>`; Break 3 attempts |
| 7 | Tools › Set multiple variables | `ig_likes` = `{{get(get(first(map(5.array; values; name; likes)); 1); value)}}` (same for comments, shares, saved, reach) · `fb_likes` = `{{6.data.reactions.summary.total_count}}` · `fb_comments` = `{{6.data.comments.summary.total_count}}` · `fb_shares` = `{{ifempty(6.data.shares.count; 0)}}` · totals · `engagement_score` = `{{round((likes + 3*comments + 4*shares + 4*saves) / max(reach; 1) * 1000; 2)}}` (if reach = 0 use the raw weighted sum) |
| 8 | Google Sheets › Update a Row | Content: `likes`, `comments`, `shares`, `saves`, `reach`, `engagement_score`, `metrics_updated_at` |
| 9 | Google Sheets › Add a Row | Performance: post_id, captured_at, platform `total`, metrics, score |
| E | Error route | Logs + alert (sync errors never block generation) |

The `Insights` tab recalculates automatically from `Content`, so the next S1 run reads updated learning context.

---

## 3.4 Mode B (Node backend) scenarios — fits the Free plan

**S1-B Daily trigger** (06:00): Schedule → HTTP › Make a request `POST {{BACKEND_URL}}/v1/daily-run`
(header `Authorization: Bearer <BACKEND_API_KEY>`, body `{"date":"{{formatDate(now; YYYY-MM-DD; Asia/Dhaka)}}"}`)
→ filter `statusCode = 202` → else alert. The backend syncs engagement, computes insights, generates,
validates, runs compliance, renders images, writes Content rows and alerts on its own (≈ 2 operations/day).

**S2 Publisher**: identical to §3.2.

---

## 3.5 Retry, fallback and error-handler map

| Where | Handler | Behaviour |
|---|---|---|
| OpenAI content / compliance HTTP | Break | 3 attempts, 60 s apart; incomplete execution stored; then error route → alert |
| gpt-image HTTP | Break → on final failure, error route runs a duplicate HTTP module with `model = IMAGE_MODEL_FALLBACK` (Resume directive feeds its output back into the route) | survives the gpt-image-1 shutdown and transient 5xx |
| Cloudinary upload | Break | 3 attempts, 30 s |
| Instagram / Facebook publish | Break | 3 attempts, 5 min (Meta rate limits recover slowly) |
| Sheets writes | Break | 3 attempts, 30 s |
| Any route exhausting retries | Error route | Logs row + Slack/Email alert with scenario, module, post id, error message |
| Insights / sync failures | Ignore after logging | never block content generation or publishing |

Make's `Break` handler needs "Allow storing of incomplete executions" (scenario settings); failed runs
also appear under *Incomplete executions* where they can be resolved manually.

---

## 3.6 Operations budget (per month, 30 days)

| Scenario | Mode A | Mode B |
|---|---|---|
| S1 generator | ≈ 35/day with cover-only carousels (≈ 70 with per-slide images) → 1,050–2,100 | 2/day → 60 |
| S2 publisher | 5 runs × ≈ 6 → 30/day → 900 | 900 |
| S3 sync | 5 posts × 3 snapshots × ≈ 6 ops → ≈ 90/day → 2,700 | 0 (backend) |
| **Total** | **≈ 4,650–5,700 → Make Core plan or higher** | **≈ 960 → fits Free (1,000)** |

Data transfer: base64 images pass through Make in Mode A (≈ 0.4 MB each as JPEG q85, counted in and out) —
≈ 0.5–1 GB/month, above the Free plan's 512 MB; Mode B keeps images off Make entirely.
