# 1. System architecture

## 1.1 Goals and hard constraints

| Requirement | How the system meets it |
|---|---|
| 5 posts/day: 2 reels + 3 image/carousel | Enforced three times: prompt rules, strict JSON schema enums, and post-generation validation (backend `validateBatch`, Make filter in Mode A) |
| Slots 10:00 / 13:00 / 16:00 / 19:00 / 22:00 Asia/Dhaka | `slot → scheduled_at` mapping with explicit `+06:00` offset; publisher scenario runs exactly at those times |
| No diagnosis / prescription / fear; disclaimer | Two-stage compliance engine: deterministic rule scan + LLM compliance review; failing posts are never auto-published |
| Learning from engagement | Nightly/morning sync of likes, comments, shares, saves, reach → engagement score → insights fed into the next prompt |
| No repetition | Topic cooldown (45 days), hook cooldown (21 days), unique pillar/hook pattern per day |
| Production-ready | Idempotent runs keyed by `run_id`, per-row status machine, 3× retry with backoff, logs, alerts, manual-review lane |

## 1.2 Components

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│                                       MAKE.COM                                           │
│                                                                                          │
│  S1  Daily Generator  (06:00 Asia/Dhaka)                                                 │
│      Schedule → [sync engagement] → read learning context → ChatGPT content → compliance │
│      → Iterator(5) → Router(reel | image | carousel) → gpt-image → host → Google Sheets  │
│                                                                                          │
│  S2  Publisher  (10:00, 13:00, 16:00, 19:00, 22:00)                                       │
│      Schedule → Sheets "due & ready" → Router(type) → Instagram + Facebook → update row  │
│                                                                                          │
│  S3  Engagement Sync (23:30)  [merged into S1 on the Free plan]                          │
│      Sheets "published ≤ 7 days" → IG insights + FB post stats → score → Sheets          │
└───────────────┬───────────────────────────────┬──────────────────────────────┬───────────┘
                │ HTTPS                          │ Sheets API                    │ Graph API
                ▼                                ▼                               ▼
┌───────────────────────────┐   ┌───────────────────────────────┐   ┌─────────────────────────┐
│ OpenAI API                │   │ Google Sheets (system of record)│  │ Instagram Business +    │
│  /v1/responses  (content, │   │  Content · Performance ·        │  │ Facebook Page           │
│   compliance review)      │   │  Insights (formulas) · Config · │  └─────────────────────────┘
│  /v1/images/generations   │   │  Topic_Bank · Logs              │
└───────────────────────────┘   └───────────────────────────────┘
                ▲                                ▲
                │        (optional) Mode B       │
┌───────────────┴────────────────────────────────┴──────────────────────────────────────────┐
│ Node.js orchestration backend  (backend/)                                                 │
│  POST /v1/daily-run   sync → learn → plan → generate → validate → comply → images → Sheets │
│  POST /v1/generate    batch only (sync)          POST /v1/images   prompt → public URL     │
│  POST /v1/compliance  check posts                POST /v1/sync     refresh performance     │
│  GET  /v1/insights    learning context + plan    GET  /healthz                             │
└──────────────────────────────────────┬─────────────────────────────────────────────────────┘
                                       ▼
                     Cloudinary (or S3/R2) — public image URLs for Instagram
```

## 1.3 Two deployment modes

| | **Mode A — Make-only** | **Mode B — Make + Node backend (recommended)** |
|---|---|---|
| Content + images | Make HTTP modules call OpenAI directly | Backend calls OpenAI; Make calls the backend once |
| Validation | Make filters + LLM compliance call | Zod schema validation + rule engine + LLM review + auto-revision loop |
| Learning | Google Sheets formulas (`Insights` tab) | Backend `learning.js` (same maths) reading the Content sheet |
| Posting | Make (Instagram for Business, Facebook Pages) | Make (same) |
| Active scenarios | 3 (S1, S2, S3) — or 2 if S3 is merged into S1 | 2 (S1 trigger, S2 publisher) |
| Make operations / month | ≈ 4,500 (needs Core plan or higher) | ≈ 950 (fits the Free plan's 1,000) |
| Best for | No servers, quick start | Production: stricter validation, cheaper Make usage, easier testing |

Your Make organization is currently on the **Free plan** (2 active scenarios, 1,000 operations/month,
5-minute max execution, 15-minute minimum interval). Mode A needs an upgrade; Mode B fits as-is.

## 1.4 End-to-end data flow (one day)

1. **06:00 — S1 starts.** (Free plan: first runs the engagement sync for posts published 1–7 days ago.)
2. **Learning context.** Insights are computed from the Content sheet: median engagement, per-pillar /
   format / hook-pattern / goal scores (Bayesian-smoothed), top and bottom topics, recent topics and hooks,
   and today's pillar plan (performance × rotation bonus).
3. **Content generation.** One Responses API call with the system prompt, the rendered user prompt and the
   strict `daily_batch` JSON schema → 5 posts.
4. **Validation.** Exactly 5 posts, 2 reels at slot2/slot4, unique pillars/topics/hook patterns, all three goals.
   On failure: one targeted regeneration; then alert.
5. **Compliance.** Rule scan + LLM review. `pass` → continue; `fix` → apply the suggested fix and re-scan;
   `block` → status `needs_review`, alert, never posted.
6. **Iterator + Router.** For each post: compute `scheduled_at`; reels → cover image + `awaiting_video`;
   images → 1 image; carousels → cover (+ optional per-slide images).
7. **Images.** gpt-image-1 (auto-fallback to gpt-image-2) → JPEG → Cloudinary → public URL.
8. **Storage.** One Content row per post with status `ready` / `awaiting_video` / `needs_review`.
9. **10:00 … 22:00 — S2 publishes** rows that are due, routes by type to Instagram and Facebook, writes back
   media IDs, sets `published`.
10. **Next morning** the sync turns engagement into scores, and the loop repeats.

## 1.5 Post status machine

```
generated ─► ready ──────────► publishing ─► published
    │          ▲                    │
    │          │ editor adds        └─► failed (after 3 retries) ─► alert
    │   awaiting_video (reels)
    └─► needs_review (compliance block / validation failure) ─► human edits ─► ready
ready but slot missed by > 150 min ─► skipped ─► alert
```

## 1.6 Reels: what is and isn't automated

OpenAI's image models produce still images, not video. The system therefore generates, for each reel, a
complete script, a timed storyboard and a 9:16 cover image, and holds the row as `awaiting_video`.
Two ways to supply the video:

- **Human-in-the-loop (default, `REELS_MODE=await_video`):** an editor records/edits the reel from the
  storyboard, uploads the MP4 to Cloudinary (Google Drive links do not work with the Instagram API),
  pastes the URL into `video_url` and sets `status = ready`. The publisher posts it in its slot.
- **Automated rendering (optional):** plug a template video renderer (e.g. Creatomate, Shotstack, or a
  Remotion service) into the reel route: storyboard beats → scenes, cover/B-roll images, TTS voiceover →
  MP4 URL → `video_url`. Keep human review on for medical content.

## 1.7 Security

- API keys live in Make connections / HTTP module headers or backend environment variables — never in Sheets.
- Backend endpoints require `Authorization: Bearer <BACKEND_API_KEY>`; Make stores it in the HTTP module.
- Use a dedicated Google service account with edit access to the one spreadsheet only.
- Facebook/Instagram: use a long-lived Page access token from a System User (Business Manager) with
  `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_manage_posts`,
  `pages_read_engagement`, `pages_show_list`.
- `store: false` on OpenAI requests (no retention of prompts/outputs for later retrieval).
