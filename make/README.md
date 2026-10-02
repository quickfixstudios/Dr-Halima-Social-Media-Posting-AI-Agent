# Live Make.com scenario — "Dr Halima – Daily plan (5 posts/day)"

`daily-plan.scenario.json` is the blueprint + schedule of Make scenario **6486322** (team "My Team").

How it works (one scenario, no storage needed — fits the Make Free plan):

| Step | Module | What it does |
|---|---|---|
| 1 | Tools › Set variables | Works out the slot from the current Dhaka hour (10→1, 13→2, 16→3, 19→4, 22→5) and a rotation number `n = day_of_year × 5 + slot` |
| 2 | OpenAI › Generate a completion (`gpt-6.1-sol`) | Writes one post: pillar = `n mod 7`, topic = `floor(n / 7) mod 10` from a 70-topic bank, style quick-tip in slots 2 and 4. Returns `{topic, caption, image_prompt}` |
| 3 | OpenAI › Generate images (`gpt-image-2.5-sunburst`) | Creates a square JPEG from `image_prompt` |
| 4 | Facebook Pages › Create a Post with Photos | Posts caption + image to **Dr. Halima (Dubai)** |

Each of steps 2–4 has a Retry error handler (3 attempts, 2 minutes apart).

**Schedule:** every 3 hours from 10:00 on 3 Oct 2026, only between 09:55 and 22:10 (Asia/Dhaka)
→ 10:00, 13:00, 16:00, 19:00, 22:00. The 5 slots always get 5 different pillars on the same day.

**Operations:** ≈ 4 per run × 5 runs ≈ 20/day ≈ 600/month (Free plan: 1,000).

**Not included yet:** real reels (slots 2 and 4 post quick-tip image posts), Instagram, engagement learning.
