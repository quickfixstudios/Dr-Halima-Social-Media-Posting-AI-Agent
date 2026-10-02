# Quick start — Version 1 (simple, working)

The simplest version of the robot that **actually runs on Make.com today**:

1. Every morning, ChatGPT writes 5 posts.
2. Each post gets an image.
3. Everything is saved in a Google Sheet.
4. At 10 AM, 1 PM, 4 PM, 7 PM and 10 PM, one post goes to Facebook.

Version 2 (Instagram, reels, learning, compliance review) is in the other docs. Start here.

---

## Why V1 uses two scenarios instead of a "Sleep" step

Make's **Sleep** module can wait **at most 5 minutes**, and on the Free plan a whole run is stopped after
**5 minutes**. So one scenario can't wait from 8 AM until 10 PM.

The fix is easy — two small scenarios:

| Scenario | When it runs | What it does |
|---|---|---|
| **A — Make the posts** | every day at 8:00 AM | ChatGPT → 5 posts → 5 images → saved to Google Sheet |
| **B — Post on time** | 10 AM, 1 PM, 4 PM, 7 PM, 10 PM | finds the post for this hour in the sheet → posts it to Facebook |

The Free plan allows exactly 2 active scenarios, so this fits.

---

## STEP 0 — Get ready (once)

1. **Make time zone:** Make → Organization → Time zone = **Asia/Dhaka**. (Otherwise "10 AM" means another country's 10 AM.)
2. **Google Sheet** called `Dr Halima Posts`, first row:

   `date | slot | time | post_type | topic | caption | image_url | reel_script | status`

3. **Cloudinary** (free account): Settings → Upload → Add upload preset → Signing mode **Unsigned**.
   Write down your **cloud name** and **preset name**.
   *Why:* OpenAI gives the image back as data, not as a link. Facebook needs a link. Cloudinary turns the
   image into a link.
4. **OpenAI API key** from platform.openai.com.

---

## Scenario A — Make the posts (8:00 AM)

### A1 — HTTP › Make a request (ChatGPT)

- Method: `POST`
- URL: `https://api.openai.com/v1/chat/completions`
- Headers: `Authorization` = `Bearer YOUR_OPENAI_API_KEY`, `Content-Type` = `application/json`
- Body type: **Raw**, content type **JSON (application/json)**
- **Parse response: Yes**
- Request content (copy exactly):

```json
{
  "model": "gpt-6.1-sol",
  "messages": [
    {
      "role": "system",
      "content": "You are the social media writer for Dr. Halima, a gynaecologist and global women's health educator. Audience: women 18-45 worldwide, pregnant women, women with period, hormone or fertility concerns. Write 5 posts in simple English. Slots 2 and 4 are reels; slots 1, 3 and 5 are images. Use 5 different topics from these pillars: Education, Myth vs Fact, Warning/Awareness, Pregnancy, Hormonal Health, Emotional Support, Preventive Tips. SAFETY RULES: never diagnose, never name medicines or doses, no absolute promises like cure or guaranteed, no scary or fear-based wording, calm and kind tone. Every caption: short paragraphs, one key takeaway, ask people to save and share, then end with exactly: This is for educational purposes only. Consult a qualified doctor for personal medical advice. Add 6-8 hashtags including #DrHalima at the end of the caption. visual_prompt: one sentence for a clean, soft-light, minimal, modern image of modestly dressed women, square, with no text, no body anatomy, no medical tools. For reels also write a 30-second reel_script (hook in the first 3 seconds, simple explanation, 2-3 tips, gentle call to action); for images reel_script is an empty string."
    },
    {
      "role": "user",
      "content": "Write today's 5 posts. Today is {{formatDate(now; YYYY-MM-DD; Asia/Dhaka)}}."
    }
  ],
  "response_format": {
    "type": "json_schema",
    "json_schema": {
      "name": "daily_posts",
      "strict": true,
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "required": ["posts"],
        "properties": {
          "posts": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["slot", "post_type", "topic", "caption", "visual_prompt", "reel_script"],
              "properties": {
                "slot": { "type": "integer", "enum": [1, 2, 3, 4, 5] },
                "post_type": { "type": "string", "enum": ["reel", "image"] },
                "topic": { "type": "string" },
                "caption": { "type": "string" },
                "visual_prompt": { "type": "string" },
                "reel_script": { "type": "string" }
              }
            }
          }
        }
      }
    }
  }
}
```

What changed from the first draft, and why:
- **`response_format` with a schema** — without it ChatGPT returns free text, and Make can't split it into 5 posts.
- **Real instructions in the system message** — the model can't follow "medical safety" or "JSON" rules it hasn't been given.
- **Model `gpt-6.1-sol`** — `gpt-4.1` is being retired by OpenAI in 2026.

**Error handling:** right-click the module → *Add error handler* → **Break**, 3 attempts, 1 minute apart.
Scenario settings → turn on **Allow storing of incomplete executions** (needed for Break).

### A2 — JSON › Parse JSON

- JSON string: `{{1.data.choices[1].message.content}}`
  (ChatGPT's answer is text that *looks* like JSON; this turns it into real data.)
- Data structure: click **Add** → **Generate** → paste a small sample like
  `{"posts":[{"slot":1,"post_type":"image","topic":"t","caption":"c","visual_prompt":"v","reel_script":""}]}`

### A3 — Flow Control › Iterator

- Array: `{{2.posts}}` → now each post runs through the next steps on its own.

### A4 — JSON › Create JSON (image request)

Create a data structure with fields `model`, `prompt`, `size`, `quality`, `output_format`, `n`, then fill:

| Field | Value |
|---|---|
| model | `gpt-image-2` |
| prompt | `{{3.visual_prompt}}` |
| size | `1024x1024` |
| quality | `medium` |
| output_format | `jpeg` |
| n | `1` |

*Why not type `"prompt": "{{visual_prompt}}"` straight into the HTTP body?* If ChatGPT writes a quote mark
or a line break in the prompt, the JSON breaks and the step fails. Create JSON handles that safely.
*Why `gpt-image-2`?* OpenAI switches off `gpt-image-1` on **23 October 2026**.

### A5 — HTTP › Make a request (create the image)

- Method `POST`, URL `https://api.openai.com/v1/images/generations`
- Same two headers as A1
- Body type Raw, JSON, request content: `{{4.json}}`
- Parse response: **Yes** · Break handler: 3 attempts, 2 minutes apart

The image comes back in `data[1].b64_json` (data, not a link).

### A6 — HTTP › Make a request (upload to Cloudinary → get a link)

- Method `POST`, URL `https://api.cloudinary.com/v1_1/YOUR_CLOUD_NAME/image/upload`
- Body type: **Multipart/form-data**, fields:
  - `file` = `data:image/jpeg;base64,{{5.data.data[1].b64_json}}`
  - `upload_preset` = `YOUR_PRESET_NAME`
- Parse response: **Yes**
- The public link is `{{6.data.secure_url}}`.

### A7 — Google Sheets › Add a Row

| Column | Value |
|---|---|
| date | `{{formatDate(now; YYYY-MM-DD; Asia/Dhaka)}}` |
| slot | `{{3.slot}}` |
| time | `{{switch(3.slot; 1; 10:00; 2; 13:00; 3; 16:00; 4; 19:00; 5; 22:00)}}` |
| post_type | `{{3.post_type}}` |
| topic | `{{3.topic}}` |
| caption | `{{3.caption}}` |
| image_url | `{{6.data.secure_url}}` |
| reel_script | `{{3.reel_script}}` |
| status | `ready` |

**Schedule for Scenario A:** click the clock on module A1 → **Every day** → **08:00**.

---

## Scenario B — Post on time (10, 13, 16, 19, 22)

### B1 — Google Sheets › Search Rows

- Sheet: `Dr Halima Posts`
- Filter: `date` = `{{formatDate(now; YYYY-MM-DD; Asia/Dhaka)}}` **AND** `time` = `{{formatDate(now; HH:00; Asia/Dhaka)}}`
- Limit: 1

So the 1 PM run only ever finds the 1 PM post — no post goes out twice.

### B2 — Facebook Pages › Create a Post with Photos

- Page: your Facebook Page
- Photos → URL: `{{1.image_url}}`
- Message: `{{1.caption}}`
- Error handler: **Break**, 3 attempts, 5 minutes apart

**Schedule for Scenario B:** clock on B1 → **At regular intervals** → every **180 minutes**, first run at
**10:00** → (optional) *Advanced scheduling*: only between **09:55 and 22:10**.
That gives 10:00, 13:00, 16:00, 19:00, 22:00.

---

## STEP 8 — Test, then turn ON

1. In the Sheet, run **Scenario A → Run once**. You should get 5 rows with image links (open one in a browser).
2. Add a test row for today with `time` = the current hour (e.g. `15:00`) and run **Scenario B → Run once**.
   Check your Facebook Page, then delete the test post and row.
3. Turn both scenarios **ON**.

---

## What V1 does not do yet (honest list)

| Missing | Why | Where it's solved |
|---|---|---|
| Real reels | OpenAI makes images, not videos. V1 posts an image in the reel slots and saves the `reel_script` in the Sheet so you can record it. | [01-architecture.md §1.6](01-architecture.md#16-reels-what-is-and-isnt-automated) |
| Instagram | Needs a Business account linked to the Page; add "Instagram for Business › Create a photo post" after B2. | [03-make-scenarios.md §3.2](03-make-scenarios.md#32-scenario-s2--publisher) |
| No repeated topics | V1 doesn't remember yesterday's topics. | [06-learning-system.md](06-learning-system.md) |
| Second safety check | V1 relies on the system prompt only — read each day's posts in the Sheet before 10 AM for the first weeks. | [02-content-engine.md §2.5](02-content-engine.md#25-compliance-engine-two-stages) |
| Learning from likes/shares | Needs engagement tracking. | [06-learning-system.md](06-learning-system.md) |

**Make operations:** about 23 per day for Scenario A + 10 for Scenario B ≈ **1,000 per month** — right at the
Free plan's limit of 1,000. Upgrade to Make's Core plan if you add Instagram or anything else.
