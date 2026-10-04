# Live Make.com scenario — "Dr Halima – Daily plan (3 posts/day)"

`daily-plan.scenario.json` is the blueprint + schedule of Make scenario **6486322** (team "My Team").

How it works (one scenario, no storage needed — fits the Make Free plan):

| Step | Module | What it does |
|---|---|---|
| 1 | Tools › Set variables | Slot from the Dhaka hour (10→1, 16→2, 22→3) and rotation number `n = day_of_year × 3 + slot` |
| 2 | OpenAI › Generate a completion (`gpt-6-luna`) | Writes one Bangla post with the shared prompt [`../prompts/facebook_post.system.md`](../prompts/facebook_post.system.md) (+ verified WHO facts). Pillar = `n mod 7`, topic = `floor(n/7) mod 10` (Make has no `mod`, so `x − floor(x/7)×7`) |
| 2b | JSON › Parse JSON (data structure "Dr Halima post") | `content_type`, `topic`, `hook`, `caption`, `hashtags`, `overlay_main/sub`, `image_prompt` |
| 3 | OpenAI › Generate images (`gpt-image-2.5-sunburst`, fixed size 1024×1280 = 4:5) | The **whole finished image incl. Bangla text**. Only the post's `image_prompt` field is sent: a 40–80 word scene description + "Text to render exactly in Bengali: Headline: … \| Bullet 1: … \| Brand line: …" + one safety line. Size is hardcoded in the module, never taken from AI output. The writer picks one of **11 post types** (Authority with a symbolic doctor labelled "প্রতীকী ছবি", Educational, Relatable Problem, Warning, Pregnancy Tips, Condition Awareness, Myth vs Fact, Step-by-step, Timeline, Data, simple Infographic). Real people are realistic Bangladeshi photos, never cartoons. 6–10 word Bangla headline + short lines, brand colours, brand line "ডা. হালিমা · গাইনি ও প্রসূতি" |
| 4 | OpenAI › Analyze images (`gpt-6-luna`) | **Bangla text + safety check**: every requested line spelled exactly, no other/English text or names, nothing garbled, no anatomy/fetus (also not on wall posters), a shown doctor carries "প্রতীকী ছবি"; punctuation and spacing are ignored, letters must be exact → `VERDICT: PASS` / `FAIL` |
| 5 | Router | **PASS** → Facebook post with the image · **FAIL** → the same prompt is drawn **once more** and checked again; PASS → that image is posted · FAIL again → a **text-free realistic photo** is posted (for Relatable/Educational posts the post's own scene, otherwise a calm Bangladeshi woman at home). Never cartoons, floating icons or a fixed stock picture; a misspelled image never goes out |
| 6 | Facebook Pages › Create a Post with Photos | Caption + Bangla signature + 0–3 hashtags |

Every OpenAI and Facebook step has a Retry error handler (3 attempts, 2 minutes apart).

**Schedule:** every 6 hours, only between 10:00 and 22:10 (Asia/Dhaka) → 10:00, 16:00, 22:00 (3 posts/day since 4 Oct 2026).
(The window must start at exactly 10:00: Make restarts the timer at the window start each day.) The 3 daily posts always get 3 different pillars and post types. A suggested post type rotates by `n mod 13` (13 is coprime with the 3 daily slots and the 7 pillars, so every slot and pillar meets every type): Authority 3×, Warning 2×, Relatable Problem 2×, Educational, Myth vs Fact, Pregnancy Tips, Condition Awareness, Timeline, Step-by-step 1× each; the writer may switch to a better-fitting type (also Data or Infographic) and picks the matching writing angle itself. Captions are Bangla with at most 5 simple English words (e.g. Pregnancy test); all text on the image stays pure Bangla.

**Operations:** 6 per run when the first image passes, 8 when the second try passes, 9 when both fail → at most 27/day ≈ 810/month, usually 600–700 (Free plan: 1,000). Manual test runs also post to Facebook and count.

**Not included yet:** real reels (slots 2 and 4 post quick-tip image posts), Instagram, engagement learning.

**Status:** live since 2 Oct 2026. AI-drawn Bangla infographics with the text check start with the 10:00 run on
4 Oct 2026. Facebook connection "Dr. Halima" expires 1 Dec 2026 — reauthorize before then.

---

# Weekly carousel — "Dr Halima – Weekly carousel (Friday 19:00)"

`weekly-carousel.scenario.json` mirrors the second active scenario. Every **Friday at 19:00 (Asia/Dhaka)** it posts one
extra **6-slide carousel** (slide 1 hook, slides 2–5 one step each, slide 6 save/share/message) on a process topic.

| Step | Module | What it does |
|---|---|---|
| 1 | OpenAI › Generate a completion (`gpt-6-luna`) | Writes the carousel with [`../prompts/carousel.system.md`](../prompts/carousel.system.md): caption, hashtags and 6 slide image prompts sharing one style sentence. Topic = ISO week `mod 12` over 12 process topics (missed period, home pregnancy test, first check-up, …) |
| 2 | JSON › Parse JSON (data structure "Dr Halima carousel") | `topic`, `caption`, `hashtags`, `slides[].image_prompt` |
| 3 | Flow Control › Iterator | One bundle per slide |
| 4–7 | OpenAI › Generate images ×2 + Analyze images ×2 | Each slide is drawn twice (fixed 1024×1280, medium quality so the whole run stays under Make's time limit — high quality took over 10 minutes) and both drafts are checked with the same Bangla text + safety check as the daily posts |
| 8 | Array aggregator | Keeps the first draft that passed per slide, in slide order; a slide where both drafts failed is marked `FAILED` |
| 9 | Facebook Pages › Create a Post with Photos | Posts all 6 images as one multi-photo post — **only if all 6 slides passed**; otherwise nothing is posted that week (a carousel with a missing step is never published) |

**Operations:** 29 per carousel (tested: 6 slides × 4 + 5, run time about 5 minutes) ≈ 125/month. First run: Friday 9 Oct 2026, 19:00. Together with the daily posts this stays under 1,000.

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
