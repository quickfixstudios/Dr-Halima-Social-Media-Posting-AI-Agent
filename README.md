# Dr. Halima — Social Media System

Automated Bangla Facebook posts for Dr. Halima (Gynaecology & Obstetrics, Bangladesh), run entirely in **Make.com**
with OpenAI: 3 posts a day at 10:00, 16:00 and 22:00 and a 6-slide carousel every Friday at 19:00 (Asia/Dhaka).

## What is where

```
.
├── make/        copies of the two live Make scenarios (daily posts, weekly carousel) + how they work
├── prompts/     facebook_post.system.md · carousel.system.md · verified_facts.json (the only numbers allowed)
├── brands/      guidelines/ — Dr. Halima brand guidelines (colours, tone)
└── tests/       checks that the prompts and the Make copies stay identical (npm test)
```

## Changing a prompt

1. Edit the file in `prompts/` (for the daily prompt, `{{VERIFIED_FACTS}}` stands for the facts in `verified_facts.json`).
2. Put the same text into the matching module in Make and into the copy in `make/`.
3. Run `npm test` (Node 20+, no install needed); it fails if the prompt and the Make copy differ.

## Important dates and limits

- Make Free plan: 2 active scenarios (both used), 1,000 operations/month (about 650–950 used).
- The Facebook connection in Make expires on 1 Dec 2026 — reauthorize it before then.
