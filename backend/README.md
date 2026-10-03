# Backend

Node.js code for the post writer, the reviewed AI image pipeline and a small API server for both.
Not deployed yet — the live posting runs in Make.com (see ../make). Run it on your computer.

```
src/
  server.js            HTTP API (bearer auth): /healthz, /v1/image-jobs (POST create · GET list), /v1/image-jobs/action
  content/             post writer: postGenerator.js + cli.js (npm run content)
  openai/client.js     shared OpenAI client (SDK retries off; retry.js owns policy)
  openai/content.js    structured Responses API call
  storage/cloudinary.js unsigned upload → public URL (optional, for Make)
  retry.js · logger.js · config.js
  imaging/             reviewed AI image pipeline (see ../IMAGE_AUTOMATION.md):
    pipeline.js          createImageJob() / runAction() — orchestration + review actions
    decision.js          content → visual type (scored, explained) → Image Creative Brief
    categories.js        the visual styles (add new ones here)
    promptBuilder.js     brief → 16-section image prompt (picture only, text drawn by us)
    infographicPrompt.js brief → Canva-style prompt for a whole AI-drawn infographic with exact Bangla lines
    textCheck.js         reads AI-drawn Bangla back (vision model) and compares it letter by letter
    overlay/             Bangla text rendering (sharp + bundled Hind Siliguri), layouts and icons
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
```

Docker (from the repository root): `docker build -f backend/Dockerfile -t dr-halima-backend .`
