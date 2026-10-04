# Dr. Halima — Social Media System

Automated Bangla Facebook posts for Dr. Halima (Gynaecology & Obstetrics, Bangladesh):
**OpenAI → Make.com → Facebook Page**, 3 posts/day at 10:00, 16:00 and 22:00 Asia/Dhaka.

## What is where

| Part | What it does | Where |
|---|---|---|
| **Live Make.com scenario** | Posts to the Facebook Page today: writes one pure-Bangla post per slot, draws a text-free illustration, publishes. | [make/](make) |
| **Post writer** | Shared content prompt (7 content types), verified WHO facts, infographic examples. | [prompts/](prompts) · `npm run content` |
| **AI image pipeline** | Branded images and designed infographics with correct Bangla text, human review, hand-off to Make. Beginner guide. | [IMAGE_AUTOMATION.md](IMAGE_AUTOMATION.md) · [brands/](brands) · [posts/](posts) |
| **Backend** | Node.js code for the post writer, the image pipeline, the review screen and a small API. | [backend/](backend) |

## Folder structure

```
.
├── README.md · IMAGE_AUTOMATION.md
├── make/        live scenario mirror + "publish approved image posts" blueprint
├── prompts/     facebook_post.system.md · infographic_examples.md · verified_facts.json
├── brands/      business profiles, brand guidelines, Bangla font, logo/photo folder
├── posts/       post files (samples/, drafts/)
├── docs/images/ example renders
└── backend/     src/ (content/, imaging/, openai/, storage/, server.js) · test/
```

## Important dates and limits

- Make Free plan: 2 active scenarios, 1,000 operations/month.
- The Facebook connection in Make expires on 1 Dec 2026 — reauthorize it before then.
