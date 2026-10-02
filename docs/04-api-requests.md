# 4. API request examples

All OpenAI calls use `Authorization: Bearer $OPENAI_API_KEY` and `Content-Type: application/json`.

## 4.1 ChatGPT content generation — Responses API

**Endpoint:** `POST https://api.openai.com/v1/responses`

```bash
curl https://api.openai.com/v1/responses \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'JSON'
{
  "model": "gpt-6.1-sol",
  "instructions": "<contents of prompts/system.prompt.md, JSON-escaped>",
  "input": "<rendered prompts/user.prompt.template.md, JSON-escaped>",
  "text": {
    "format": <contents of prompts/daily_batch.schema.json>
  },
  "max_output_tokens": 32000,
  "store": false,
  "metadata": { "app": "dr-halima-content-os", "run_id": "20261002-060001" }
}
JSON
```

`prompts/daily_batch.schema.json` already contains `{"type":"json_schema","name":"daily_batch","strict":true,"schema":{…}}`,
so it can be pasted as the value of `text.format` unchanged.

**Successful response (shape):**

```json
{
  "id": "resp_…",
  "object": "response",
  "status": "completed",
  "model": "gpt-6.1-sol",
  "output": [
    { "type": "reasoning", "id": "rs_…", "summary": [] },
    {
      "type": "message",
      "role": "assistant",
      "status": "completed",
      "content": [ { "type": "output_text", "text": "{\"daily_batch\":[ … 5 posts … ]}", "annotations": [] } ]
    }
  ],
  "usage": { "input_tokens": 0, "input_tokens_details": { "cached_tokens": 0 }, "output_tokens": 0, "total_tokens": 0 }
}
```

**Parsing rules (backend `openai/content.js`; Make modules 8–9):**

1. HTTP 200 and `status === "completed"`. If `status === "incomplete"`, read `incomplete_details.reason`
   (`max_output_tokens` → raise the limit and retry; content filter → alert).
2. Take the output item with `type === "message"` (in Make: `last(output)`).
3. In its `content`, a `type === "refusal"` item means the model declined → alert, do not retry blindly.
4. Otherwise `JSON.parse(content[type=output_text].text)` → `{ daily_batch: [...] }`.
5. Run batch validation (§2.4) and compliance (§2.5) before storing anything.

HTTP errors: 429 / 500 / 502 / 503 / timeouts → retry with backoff (3 attempts); 400 → fix the request
(schema/model) and alert; 401/403 → alert (key/permissions).

## 4.2 Image generation — gpt-image-1 → public URL

**Endpoint:** `POST https://api.openai.com/v1/images/generations`

```bash
curl https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-1",
    "prompt": "<visual_prompt>\n\nStyle guard: clean medical aesthetic, soft natural light, minimal, modern, female-focused, modestly dressed women. Strictly no text, anatomy, blood, medical instruments, nudity or logos.",
    "size": "1024x1536",
    "quality": "high",
    "output_format": "jpeg",
    "output_compression": 85,
    "n": 1
  }'
```

Response: `{ "created": 1759370000, "data": [ { "b64_json": "<base64 JPEG>" } ], "usage": { … } }`
GPT image models return base64 only — there is no hosted URL, so the image is uploaded to get one.

Sizes: reel cover / carousel `1024x1536`, single image `1024x1024`.
Model fallback: on HTTP 400/404 mentioning the model (e.g. after the **23 Oct 2026 gpt-image-1 shutdown**),
repeat the same request with `"model": "gpt-image-2"`.

**Upload to Cloudinary (unsigned preset) → URL:**

```bash
curl https://api.cloudinary.com/v1_1/$CLOUDINARY_CLOUD/image/upload \
  -F "file=data:image/jpeg;base64,$B64" \
  -F "upload_preset=$CLOUDINARY_PRESET" \
  -F "folder=dr-halima/2026-10-02" \
  -F "public_id=2026-10-02-1-cover"
# → { "secure_url": "https://res.cloudinary.com/<cloud>/image/upload/v…/dr-halima/2026-10-02/2026-10-02-1-cover.jpg", … }
```

`secure_url` is what goes into `Content.image_urls` and to Instagram/Facebook.
(S3/R2 alternative: `PutObject` with `ContentType: image/jpeg` to a public bucket/CDN path.)

## 4.3 Compliance review — Responses API (second call)

```json
{
  "model": "gpt-6.1-sol",
  "instructions": "<prompts/compliance.prompt.md, JSON-escaped>",
  "input": "<the daily_batch JSON text, JSON-escaped>",
  "text": { "format": <prompts/compliance.schema.json> },
  "max_output_tokens": 8000,
  "store": false
}
```

Returns `{ "reviews": [ { "id", "verdict": "pass|fix|block", "issues": [], "suggested_fix": { "caption", "script", "carousel_slides_text": [] } } ] }`.

## 4.4 Meta Graph API (engagement sync)

Use the current Graph API version (`GRAPH_API_VERSION`, e.g. `v23.0`) and a long-lived Page token.

```bash
# Instagram post insights (feed photo / carousel / reel)
curl "https://graph.facebook.com/$GRAPH_API_VERSION/$IG_MEDIA_ID/insights?metric=likes,comments,shares,saved,reach&access_token=$PAGE_TOKEN"
# → { "data": [ { "name": "likes", "period": "lifetime", "values": [ { "value": 412 } ] }, … ] }

# Facebook Page post stats
curl "https://graph.facebook.com/$GRAPH_API_VERSION/$FB_POST_ID?fields=shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)&access_token=$PAGE_TOKEN"
# → { "shares": { "count": 12 }, "reactions": { "summary": { "total_count": 230 } }, "comments": { "summary": { "total_count": 18 } }, "id": "…" }
```

Facebook does not expose saves; FB reach requires Page insights (`post_impressions_unique`), which the
backend requests when the token has `read_insights`.

## 4.5 Backend endpoints (Mode B)

All require `Authorization: Bearer $BACKEND_API_KEY`.

| Method & path | Body | Response |
|---|---|---|
| `POST /v1/daily-run` | `{ "date": "2026-10-02", "force": false }` | `202 { "run_id", "status": "accepted" }` — async: sync → learn → generate → comply → images → Sheets |
| `POST /v1/generate` | `{ "date": "2026-10-02" }` | `200 { "daily_batch": [...], "plan": [...], "compliance": {...} }` (no images, no storage) |
| `POST /v1/images` | `{ "id": "2026-10-02-1", "post_type": "carousel", "prompt": "…" }` | `200 { "url": "https://…", "model": "gpt-image-1" }` |
| `POST /v1/compliance` | `{ "posts": [ … ] }` | `200 { "results": [ { "id", "verdict", "issues", "post" } ] }` |
| `POST /v1/sync` | `{}` | `200 { "updated": 12 }` |
| `GET /v1/insights` | — | `200 { "insights": {…}, "plan": [...] }` |
| `GET /healthz` | — | `200 { "ok": true }` |

```bash
curl -X POST "$BACKEND_URL/v1/daily-run" \
  -H "Authorization: Bearer $BACKEND_API_KEY" -H "Content-Type: application/json" \
  -d '{"date":"2026-10-02"}'
```
