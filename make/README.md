# Live Make.com scenario — "Dr Halima – Daily plan (5 posts/day)"

`daily-plan.scenario.json` is the blueprint + schedule of Make scenario **6486322** (team "My Team").

How it works (one scenario, no storage needed — fits the Make Free plan):

| Step | Module | What it does |
|---|---|---|
| 1 | Tools › Set variables | Slot from the Dhaka hour (10→1 … 22→5) and rotation number `n = day_of_year × 5 + slot` |
| 2 | OpenAI › Generate a completion (`gpt-6.1-sol`) | Writes one **pure-Bangla** post with the shared prompt [`../prompts/facebook_post.system.md`](../prompts/facebook_post.system.md) (+ verified WHO facts). Content type = `(n + floor(n/7)) mod 7` over the 7 types (Pain → Solution, Myth vs Fact, Educational Carousel, Emotional Story, Data/Statistics, Call-to-Action, Doctor Trust); pillar = `n mod 7`, topic = `floor(n/7) mod 10` (Make has no `mod`, so `x − floor(x/7)×7`) |
| 2b | JSON › Parse JSON (data structure "Dr Halima post") | `content_type`, `topic`, `hook`, `caption`, `hashtags`, `overlay_main/sub`, `image_prompt` |
| 3 | OpenAI › Generate images (`gpt-image-2.5-sunburst`) | Square warm infographic-style **illustration in the brand palette, with no words** (AI-drawn Bangla is unreliable without review) |
| 4 | Facebook Pages › Create a Post with Photos | Caption + Bangla signature + 0–3 hashtags |

Each of steps 2–4 has a Retry error handler (3 attempts, 2 minutes apart).

**Schedule:** every 3 hours, only between 10:00 and 22:10 (Asia/Dhaka) → 10:00, 13:00, 16:00, 19:00, 22:00.
(The window must start at exactly 10:00: Make restarts the timer at the window start each day.) The 5 slots always get 5 different pillars on the same day.

**Operations:** ≈ 4 per run × 5 runs ≈ 20/day ≈ 600/month (Free plan: 1,000).

**Not included yet:** real reels (slots 2 and 4 post quick-tip image posts), Instagram, engagement learning.

**Status (2 Oct 2026):** live. Facebook connection "Dr. Halima" (expires 1 Dec 2026 — reauthorize before then). First test post published 23:38 Dhaka; scheduled runs start 3 Oct 2026 at 10:00.

---

# Publisher scenario (not created yet) — "Dr Halima – Publish approved image posts"

`publish-approved.blueprint.json` is an importable Make blueprint, checked with Make's own validator. It receives
posts approved in the image review screen (see [../IMAGE_AUTOMATION.md](../IMAGE_AUTOMATION.md) §9):

| Step | Module | What it does |
|---|---|---|
| 1 | Webhooks › Custom webhook | Receives the approved post payload from the backend |
| 2 | Router | Route A: images sent as links (Cloudinary, any number of photos) · Route B: one image sent inline (base64) |
| 3 | Facebook Pages › Create a Post with Photos | Posts caption + photo(s); `publish_at` → Facebook "Publish date" (native scheduling 10 min–30 days ahead, else immediate) |
| 4 | Webhooks › Webhook response | Replies `{ "fb_post_id": … }` so the post is marked PUBLISHED |

Import it via *Create a new scenario → ⋯ → Import Blueprint*, add a webhook on step 1, and put its address in
`backend/.env` as `MAKE_WEBHOOK_URL_DR_HALIMA`. Free plan: this would be the 2nd active scenario.
