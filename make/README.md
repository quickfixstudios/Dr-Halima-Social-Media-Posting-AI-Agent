# Live Make.com scenario — "Dr Halima – Daily plan (3 posts/day)"

`daily-plan.scenario.json` is the blueprint + schedule of Make scenario **6486322** (team "My Team").

How it works (one scenario, no storage needed — fits the Make Free plan):

| Step | Module | What it does |
|---|---|---|
| 1 | Tools › Set variables | Slot from the Dhaka hour (10→1, 16→2, 22→3) and rotation number `n = day_of_year × 3 + slot` |
| 2 | OpenAI › Generate a completion (`gpt-6-luna`) | Writes one **pure-Bangla** post with the shared prompt [`../prompts/facebook_post.system.md`](../prompts/facebook_post.system.md) (+ verified WHO facts). Content type = `(n + floor(n/7)) mod 7` over the 7 types (Pain → Solution, Myth vs Fact, Educational Carousel, Emotional Story, Data/Statistics, Call-to-Action, Doctor Trust); pillar = `n mod 7`, topic = `floor(n/7) mod 10` (Make has no `mod`, so `x − floor(x/7)×7`) |
| 2b | JSON › Parse JSON (data structure "Dr Halima post") | `content_type`, `topic`, `hook`, `caption`, `hashtags`, `overlay_main/sub`, `image_prompt` |
| 3 | OpenAI › Generate images (`gpt-image-2.5-sunburst`, fixed size 1024×1280 = 4:5) | The **whole finished image incl. Bangla text**. Only the post's `image_prompt` field is sent: a 40–80 word scene description + "Text to render exactly in Bengali: Headline: … \| Bullet 1: … \| Brand line: …" + one safety line. Size is hardcoded in the module, never taken from AI output. The writer picks one visual post type: **Authority** (realistic photo-style symbolic doctor in a clinic, labelled "প্রতীকী ছবি"), **Educational** (minimal premium lifestyle photo), **Relatable Problem** (realistic Bangladeshi woman at home) or **Infographic** (only for 3–5 points, myths, steps, a verified number). Headline + 3–5 short bullets, brand colours, brand line "ডা. হালিমা · গাইনি ও প্রসূতি" |
| 4 | OpenAI › Analyze images (`gpt-6-luna`) | **Bangla text + safety check**: every requested line spelled exactly, no other/English text or names, nothing garbled, no anatomy/fetus (also not on wall posters), a shown doctor carries "প্রতীকী ছবি" → `VERDICT: PASS` / `FAIL` |
| 5 | Router | **PASS** → Facebook post with the infographic · **FAIL** → a text-free brand illustration is generated instead and posted (a misspelled image never goes out) |
| 6 | Facebook Pages › Create a Post with Photos | Caption + Bangla signature + 0–3 hashtags |

Every OpenAI and Facebook step has a Retry error handler (3 attempts, 2 minutes apart).

**Schedule:** every 6 hours, only between 10:00 and 22:10 (Asia/Dhaka) → 10:00, 16:00, 22:00 (3 posts/day since 4 Oct 2026).
(The window must start at exactly 10:00: Make restarts the timer at the window start each day.) The 3 daily posts always get 3 different content types and pillars. Visual post type rotates by `n mod 10` over A,E,A,R,A,E,I,A,E,R → 40% Authority, 30% Educational, 20% Relatable Problem, 10% Infographic.

**Operations:** 6 per run (7 when the text check fails) × 3 runs ≈ 18–21/day ≈ 540–650/month (Free plan: 1,000).

**Not included yet:** real reels (slots 2 and 4 post quick-tip image posts), Instagram, engagement learning.

**Status:** live since 2 Oct 2026. AI-drawn Bangla infographics with the text check start with the 10:00 run on
4 Oct 2026. Facebook connection "Dr. Halima" expires 1 Dec 2026 — reauthorize before then.

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
