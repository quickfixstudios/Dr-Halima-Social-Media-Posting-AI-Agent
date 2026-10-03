# Backend (Mode B orchestration layer)

Stateless Node.js service that Make.com calls. It owns everything that is hard to do reliably inside Make:
strict validation, the compliance engine, image generation + hosting, engagement sync and learning.
Google Sheets stays the system of record, and Make still schedules and publishes.

```
src/
  server.js            HTTP API (bearer auth): /healthz, /v1/daily-run, /v1/generate, /v1/images, /v1/compliance, /v1/sync, /v1/insights,
                       /v1/image-jobs (POST create · GET list), /v1/image-jobs/action
  pipeline.js          dailyRun(): sync → insights → plan → generate → validate → comply → images → Sheets → alerts
  openai/client.js     shared OpenAI client (SDK retries off; retry.js owns policy)
  openai/content.js    Responses API structured calls, batch generation + revision round, compliance review
  openai/images.js     gpt-image-1 → fallback gpt-image-2 → Cloudinary URL
  compliance.js        rule scan, auto-fixes, verdict merge (pass / fix_applied / block / unreviewed)
  validate.js          zod schema + daily batch rules
  learning.js          engagement score, insights, pillar/format plan, topic ideas
  sync.js              Meta insights → Content metrics + Performance snapshots (day 1, 3, 7)
  meta.js              Graph API calls (Instagram insights, Facebook post stats)
  storage/sheets.js    Google Sheets REST (service account), Content row mapping
  storage/cloudinary.js unsigned upload → public URL
  prompts.js           loads ../prompts/* and renders the user prompt
  schedule.js          slot → scheduled_at (+06:00)
  retry.js · alerts.js · logger.js · config.js
  imaging/             reviewed AI image pipeline (see ../IMAGE_AUTOMATION.md):
    pipeline.js          createImageJob() / runAction() — orchestration + review actions
    decision.js          content → visual type (scored, explained) → Image Creative Brief
    categories.js        the 20 visual styles (add new ones here)
    promptBuilder.js     brief → 16-section image prompt
    overlay/             Bangla text rendering (sharp + bundled Hind Siliguri) and 10 layout templates
    safety.js            medical-content safety (approved text only, no invented numbers/titles)
    generator.js         OpenAI image call (retries, timeout, usage, request id)
    budget.js · assets.js · workflow.js · creativeReview.js · regenerate.js · make.js · shorten.js
    cli.js               npm run image -- …        reviewServer.js   npm run review (localhost:8091)
config/image-pricing.json  image prices for cost tracking (fill in from OpenAI's pricing page)
test/                  node:test unit tests (no network; OpenAI is faked)
```

Image pipeline quick start: `npm run image -- --post sample-02 --dry-run`, then `npm run image -- --post sample-02`
and `npm run review`. Full beginner guide: [../IMAGE_AUTOMATION.md](../IMAGE_AUTOMATION.md).

## Run

```bash
cd backend
npm install
cp .env.example .env     # fill in keys
npm test
npm start                # listens on $PORT
curl localhost:8080/healthz
curl -X POST localhost:8080/v1/generate -H "Authorization: Bearer $BACKEND_API_KEY" -H "Content-Type: application/json" -d '{"date":"2026-10-03"}'
```

Docker (from the repository root): `docker build -f backend/Dockerfile -t dr-halima-backend .`

Deploy anywhere that runs a long-lived Node process (Render, Railway, Fly.io, a VM). `/v1/daily-run`
finishes in the background after answering 202, so serverless platforms that freeze after the response
are not suitable unless you move the run to a queue/worker.
