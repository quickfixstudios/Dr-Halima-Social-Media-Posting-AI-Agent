# Dr. Halima — Agentic Social Media System

Daily women's-health content engine for a global audience: **learned slot plan → Claude → compliance gate → gpt-image-1 → Buffer**, with an engagement feedback loop.

**Full deliverable (single JSON):** [`deliverables/2026-10-02.json`](deliverables/2026-10-02.json) → `{ daily_batch, automation_system, learning_system }`
**Today's batch:** [`content/2026-10-02.json`](content/2026-10-02.json)

```
06:15  computeInsights ─► planDay (STEP 1 pillar · 3 hook · 4 goal) ─► generateContent (Claude, STEP 2 topic + copy)
                                                                        │ schema + compliance self-revision
       needs_review + alert ◄── compliance gate ◄───────────────────────┘
                                    │ pass
                                    ▼
       generateImage (gpt-image-1 → PNG → public URL) ─► data/db.json ─► postToBuffer (queued per slot)
10:02 13:02 16:02 19:02 22:02  publishDueSlot watchdogs: publish now if not queued, alert if empty
23:30  syncEngagement ─► performance { post_id, likes, comments, shares, saves, engagement_score } ─► next plan
```

## Setup

```bash
npm install
cp .env.example .env          # Claude, OpenAI, Cloudinary, Buffer, ALERT_WEBHOOK_URL
node src/index.js profiles    # find BUFFER_PROFILE_IDS
npm test
node src/index.js import content/2026-10-02.json --dry-run
npm start                     # all crons (generate, 5 slot watchdogs, nightly sync)
```

Other commands: `run [--date=] [--dry-run] [--skip-images]`, `attach-video <postId> <url>`, `publish-slot <slotN>`, `sync`, `performance`, `insights`, `deliverable [--date=]`.

## Notes

- **Reels** need a real video file. `REELS_MODE=await_video` (default) holds them as `awaiting_video` until `attach-video`; `cover_image` posts the cover as a teaser.
- **Compliance:** posts that fail the safety rules (diagnosis, dosing, absolute claims, fear language, sensitive visuals, missing reel disclaimer) are `needs_review`, trigger an alert, and are never auto-published.
- **Buffer API:** `src/buffer.js` targets Buffer's v1 REST API. If your account only has access to Buffer's newer API, re-implement `postToBuffer`, `getUpdateStats` and `listProfiles` there — nothing else depends on Buffer.
- **Learning loop:** see `learning_system` in the deliverable; tunables live in `LEARNING` (`src/engagement.js`).
