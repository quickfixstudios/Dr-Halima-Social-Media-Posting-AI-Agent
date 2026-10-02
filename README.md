# Dr. Halima — Agentic Social Media System

Fully automated content system for a global women's health education brand (Gynaecology & Obstetrics):
**ChatGPT (Responses API) → compliance engine → gpt-image-1 → Google Sheets → Make.com → Instagram + Facebook**,
with an engagement-driven learning loop. 5 posts/day (2 reels + 3 image/carousel) at 10:00, 13:00, 16:00,
19:00 and 22:00 Asia/Dhaka.

## Deliverables

| # | Deliverable | Where |
|---|---|---|
| 0 | **Start here:** simple working Version 1 (ChatGPT → image → Sheet → Facebook, 2 Make scenarios) | [docs/00-quick-start-v1.md](docs/00-quick-start-v1.md) |
| 1 | Full system architecture | [docs/01-architecture.md](docs/01-architecture.md) |
| 2 | ChatGPT prompt system (final, ready to use) | [docs/02-content-engine.md](docs/02-content-engine.md) · [prompts/](prompts) |
| 3 | Make.com scenarios, module by module | [docs/03-make-scenarios.md](docs/03-make-scenarios.md) |
| 4 | API request examples (content, image, compliance, Meta, backend) | [docs/04-api-requests.md](docs/04-api-requests.md) |
| 5 | Scheduling logic | [docs/05-scheduling.md](docs/05-scheduling.md) |
| 6 | Learning system design | [docs/06-learning-system.md](docs/06-learning-system.md) · [sheets/Insights.formulas.md](sheets/Insights.formulas.md) |
| 7 | Data structures (Content JSON, Performance JSON, Sheets + SQL schema) | [docs/07-data-structures.md](docs/07-data-structures.md) · [schemas/](schemas) · [sheets/](sheets) |
| — | Error handling, alerts, runbook, deployment checklist | [docs/08-error-handling-and-operations.md](docs/08-error-handling-and-operations.md) |
| — | Node.js orchestration backend (optional Mode B) | [backend/](backend) |

## Two ways to run it

- **Mode A — Make-only:** Make calls OpenAI directly; learning runs as Google Sheets formulas.
  ≈ 4,650–5,700 Make operations/month → needs the Make Core plan or higher.
- **Mode B — Make + Node backend (recommended):** Make triggers the backend once a day and publishes;
  the backend does generation, strict validation, compliance, images, engagement sync and learning.
  ≈ 960 operations/month → fits the Make Free plan (2 active scenarios, 1,000 operations).

## Folder structure

```
.
├── README.md
├── docs/
│   ├── 00-quick-start-v1.md
│   ├── 01-architecture.md
│   ├── 02-content-engine.md
│   ├── 03-make-scenarios.md
│   ├── 04-api-requests.md
│   ├── 05-scheduling.md
│   ├── 06-learning-system.md
│   ├── 07-data-structures.md
│   └── 08-error-handling-and-operations.md
├── prompts/                         # shared by Make (Mode A) and the backend
│   ├── system.prompt.md             # content generator instructions
│   ├── user.prompt.template.md      # daily plan + learning context placeholders
│   ├── daily_batch.schema.json      # strict Structured Outputs schema (text.format)
│   ├── compliance.prompt.md         # compliance reviewer instructions
│   └── compliance.schema.json
├── schemas/
│   ├── performance.schema.json      # Performance JSON
│   └── content-record.schema.json   # stored Content row
├── sheets/                          # Google Sheets tabs (headers + config + formulas)
│   ├── Content.csv · Performance.csv · Logs.csv · Config.csv · Topic_Bank.csv
│   └── Insights.formulas.md
└── backend/                         # optional Node.js orchestration layer (Mode B)
    ├── package.json · .env.example · Dockerfile · README.md
    ├── src/ (server, pipeline, openai/, storage/, compliance, validate, learning, sync, meta, …)
    └── test/
```

## Important dates and limits

- **OpenAI retires `gpt-image-1` on 23 October 2026.** The model is a single setting (`IMAGE_MODEL`) with
  automatic fallback to `gpt-image-2`; switch the setting before that date.
- Reels need a real video file: the system writes the script, timed storyboard and cover image and holds
  the reel as `awaiting_video` until an editor (or an optional video renderer) supplies `video_url`.
- Make's Sleep module waits at most 5 minutes, so slots are hit by a publisher scenario that runs at the slot
  times — not by long delays.
