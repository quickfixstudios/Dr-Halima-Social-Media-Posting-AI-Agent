# 2. Content engine (ChatGPT prompt system) and compliance engine

## 2.1 Prompt files (final, ready to use)

| File | Purpose | Used as |
|---|---|---|
| [`prompts/system.prompt.md`](../prompts/system.prompt.md) | Brand, audience, compliance rules, 4-step decision system, field rules | `instructions` |
| [`prompts/user.prompt.template.md`](../prompts/user.prompt.template.md) | Daily plan + learning context, with `{{placeholders}}` | `input` |
| [`prompts/daily_batch.schema.json`](../prompts/daily_batch.schema.json) | Strict JSON schema (paste as `text.format`) | `text.format` |
| [`prompts/compliance.prompt.md`](../prompts/compliance.prompt.md) | Compliance reviewer instructions | `instructions` (2nd call) |
| [`prompts/compliance.schema.json`](../prompts/compliance.schema.json) | Strict schema for review verdicts | `text.format` (2nd call) |

Why this split:
- **Static system prompt** → identical bytes every day → benefits from OpenAI prompt caching (cheaper input).
- **Dynamic user prompt** → only the day-specific plan and learning context change.
- **Structured Outputs (`strict: true`)** → the API guarantees schema-valid JSON; enums lock post types,
  slots, pillars, hook patterns and goals so they can't drift.

## 2.2 Output contract

The schema returns the requested structure plus three fields the learning system needs:

```json
{
  "daily_batch": [
    {
      "id": "", "scheduled_slot": "", "post_type": "reel | image | carousel", "content_pillar": "",
      "topic": "", "hook_pattern": "", "content_goal": "",
      "hook_english": "", "hook_bangla_short": "", "script": "", "video_storyboard": [],
      "caption": "", "visual_prompt": "", "carousel_slides": [], "hashtags": [], "cta": ""
    }
  ]
}
```

- `topic` — short label used for repetition control and performance grouping.
- `hook_pattern` — Curiosity | Relatability | Myth-breaking | Gentle warning | Reassurance.
- `content_goal` — save-worthy | share-worthy | authority-building.

`video_storyboard[]`: `{ start_s, end_s, section (Hook|Explanation|Insight|CTA), visual, voiceover, on_screen_text }`
`carousel_slides[]`: `{ slide_number, headline, body, visual_direction }` (image posts carry exactly one entry: the overlay text).

## 2.3 Decision system

| Step | Decided by | Logic |
|---|---|---|
| 1 Pillar | **Learning system** (Insights sheet / backend `planDay`) | weight = smoothed pillar score × (1 + 0.15 × min(days since last used, 7)); top 5 (Mode A) or weighted sampling (Mode B) |
| 1b Format | Learning system + fixed rules | Reels fixed at slot2 & slot4; slot1/3/5 carousel vs image by format score (≥ 1 carousel) |
| 2 Topic | **ChatGPT** | High-demand global topic for the pillar; Topic_Bank ideas offered; recent + low-performing topics forbidden |
| 3 Hook | ChatGPT within rules | Each hook pattern exactly once per day; pillar affinities; winning hook *structures* shown; recent hooks forbidden |
| 4 Goal | ChatGPT within rules | All three goals present daily; pillar affinity defaults |

Placement rules: Emotional Support → slot5 (22:00, reflective evening audience); the two highest-weight
non-Emotional-Support pillars take the reel slots (reels get the most reach).

## 2.4 Validation (after generation, before anything is stored)

| Check | Failure action |
|---|---|
| JSON parses; `status = completed`; no `refusal` content item | retry (max 3) |
| exactly 5 posts; slots slot1…slot5 unique | regenerate once with the error list |
| exactly 2 reels, at REEL_SLOTS | regenerate once |
| pillars, topics, hook patterns unique; all 3 goals present | regenerate once |
| reel: 20 ≤ duration ≤ 40, first beat ends ≤ 3 s, script present | regenerate once |
| carousel: 5–7 slides; image: exactly 1 slide | regenerate once |
| topic not in RECENT TOPICS (case-insensitive containment) | regenerate once |
| still failing | status `needs_review` + alert; the day keeps the posts that passed |

## 2.5 Compliance engine (two stages)

**Stage 1 — deterministic rules** (backend `compliance.js`; Make Mode A: Text parser "Match pattern" on the
concatenated copy). Scanned text = hook + script + storyboard voiceover/on-screen text + slides + caption + CTA.

| Rule | Pattern (case-insensitive) |
|---|---|
| Dosage / prescription | `\b\d+(\.\d+)?\s?(mg\|mcg\|µg\|iu\|ml\|tablets?\|capsules?)\b` |
| Medication instruction | `\b(take\|start\|stop\|use)\s+(this\|these\|your)?\s*(tablet\|pill\|medicine\|medication\|supplement\|antibiotic)s?\b` |
| Diagnosis | `\b(you (definitely \|probably \|certainly )?have (pcos\|endometriosis\|cancer\|an infection\|a tumou?r\|fibroids\|diabetes)\|this means you have\|you are suffering from\|you've got)\b` |
| Absolute claim | `\b(cures?\|cured\|guaranteed?\|100% (safe\|effective)\|miracle\|always works\|never fails\|proven to)\b` |
| Fear language | `\b(deadly\|kill you\|you could die\|terrifying\|horrifying\|dangerous for your baby\|scary truth)\b` |
| Sensitive visual (visual_prompt) | `\b(blood\|graphic\|surgery\|surgical\|nud(e\|ity)\|naked\|anatomy\|speculum\|needle\|syringe\|ultrasound probe)\b` (allowed only inside the trailing "No … anatomy, no medical instruments" clause) |
| Disclaimer | caption must end with the exact disclaimer → auto-appended if missing |
| Reel disclaimer | last storyboard beat on_screen_text contains "Educational only" → auto-fixed |
| Save/share CTA | caption contains "Save this" and "share" → auto-appended |

**Stage 2 — LLM review** (second Responses call with `compliance.prompt.md` + `compliance.schema.json`)
catches semantic issues regexes miss (implied diagnosis, inaccurate facts, cultural insensitivity).

| Verdict | Action |
|---|---|
| `pass` | continue |
| `fix` | apply `suggested_fix` (caption / script / slide bodies), re-run Stage 1, mark `compliance_status = fix_applied` |
| `block` | `status = needs_review`, `compliance_notes` = issues, alert; never auto-published |
| review call failed | rule scan only → `status = needs_review` (conservative) |

Anything a human edits in `needs_review` rows is re-checked by Stage 1 when the publisher picks it up
(Mode B: the backend `/v1/compliance` endpoint; Mode A: the same regex filter in S2).

## 2.6 Model settings

| Call | Model | Key settings |
|---|---|---|
| Content | `gpt-6.1-sol` (switch to `gpt-6-astra` for maximum quality) | Responses API, `text.format` = strict schema, `max_output_tokens` 32000, `store: false` |
| Compliance | `gpt-6.1-sol` | strict review schema, `max_output_tokens` 8000 |
| Images | `gpt-image-1` → fallback `gpt-image-2` | `output_format: jpeg`, `output_compression: 85`, sizes below |

| Post type | Size | Aspect target |
|---|---|---|
| reel cover | 1024x1536 | 9:16 cover (cropped from 2:3) |
| carousel | 1024x1536 | 4:5 feed (centre-crop) |
| image | 1024x1024 | 1:1 |

> **Deadline:** OpenAI shuts down `gpt-image-1` on **23 October 2026**. Everything reads the model from
> `IMAGE_MODEL` (Config sheet / backend env) and falls back to `IMAGE_MODEL_FALLBACK` automatically, but
> switch `IMAGE_MODEL` to `gpt-image-2` before that date. gpt-image-2 also renders slide text far more reliably.
