# Dr. Halima — Social Media Posting AI Agent

Daily women's-health content engine: **Claude → gpt-image-1 → JSON store → Buffer**, with an engagement feedback loop.

```
cron 06:15 ─► computeInsights(history) ─► planPillars() ─► generateContent()  (Claude, JSON schema)
                                                              │  safety review + 1 self-revision
                                                              ▼
                       data/db.json ◄── upsertPosts ◄── generatePostImages() (gpt-image-1)
                              │                                │ publishMedia() (Cloudinary/static)
                              ▼                                ▼
cron 23:30 ─► syncEngagement() ◄── Buffer stats ◄── schedulePosts() ─► postToBuffer()
                                                     10:00 13:00 16:00 19:00 22:00
```

| File | Role |
|---|---|
| `content/YYYY-MM-DD.json` | The day's 5 posts (2 reels + 3 image/carousel) |
| `src/generateContent.js` | `generateContent()` — Claude structured output, schema + safety validation |
| `src/generateImage.js` | `generateImage()` / `generatePostImages()` — gpt-image-1 cover + optional slide images |
| `src/buffer.js` | `postToBuffer()`, `getUpdateStats()` |
| `src/schedulePosts.js` | `schedulePosts()` — slot mapping by `post_number`, reel handling, idempotent |
| `src/engagement.js` | `syncEngagement()`, `computeInsights()`, `planPillars()` — the learning loop |
| `src/safety.js` | Medical-safety rules, disclaimer enforcement |
| `src/pipeline.js` | `runDaily()` orchestration, `importContent()` |

## Setup

```bash
npm install
cp .env.example .env    # fill in keys
node src/index.js profiles             # find BUFFER_PROFILE_IDS
npm test
node src/index.js import content/2026-10-02.json --dry-run
npm start                               # daily cron (generate + engagement sync)
```

Commands: `run [--date=] [--dry-run] [--skip-images]`, `import <file>`, `attach-video <postId> <url>`, `sync`, `insights`, `profiles`, `cron`.

## Notes

- **Reels** need a real video. With `REELS_MODE=await_video` they are stored as `awaiting_video` with their slot; record/render the script, then `attach-video`. `REELS_MODE=cover_image` posts the cover image instead.
- **Buffer** media must be a public URL, so images are uploaded via Cloudinary (or served from `PUBLIC_MEDIA_BASE_URL`).
- Posts that fail the safety review are marked `needs_review` and never auto-published.
- **Learning loop:** score = (likes + 3·comments + 4·shares + 4·saves + 0.5·clicks) per 1k reach, normalised to the median. Topics ≥1.3× median are fed back as "create new angles on these"; ≤0.6× are banned; pillar choice blends smoothed performance with a rotation bonus; topics from the last 45 days and hooks from the last 21 days are never repeated.
