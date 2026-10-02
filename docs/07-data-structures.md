# 7. Data structures

## 7.1 Content JSON (ChatGPT output, one item of `daily_batch`)

Defined by [`prompts/daily_batch.schema.json`](../prompts/daily_batch.schema.json) (strict).

| Field | Type | Rules |
|---|---|---|
| `id` | string | `<YYYY-MM-DD>-<1..5>` (backend overwrites it to be safe) |
| `scheduled_slot` | enum | `slot1` … `slot5` |
| `post_type` | enum | `reel` \| `image` \| `carousel` |
| `content_pillar` | enum | Education, Myth vs Fact, Warning/Awareness, Pregnancy, Hormonal Health, Emotional Support, Preventive Tips |
| `topic` | string | short label; unique per day; not in cooldown |
| `hook_pattern` | enum | Curiosity, Relatability, Myth-breaking, Gentle warning, Reassurance — each once per day |
| `content_goal` | enum | save-worthy, share-worthy, authority-building — all present daily |
| `hook_english` | string | ≤ 12 words |
| `hook_bangla_short` | string | ≤ 6 words, Bengali script |
| `script` | string | reels: full voiceover; else `""` |
| `video_storyboard` | array | reels: 5–8 beats `{start_s, end_s, section, visual, voiceover, on_screen_text}`; else `[]` |
| `caption` | string | ends with the disclaimer; ≤ 1,800 chars |
| `visual_prompt` | string | image-model prompt with aspect ratio and exclusions |
| `carousel_slides` | array | carousel: 5–7 `{slide_number, headline, body, visual_direction}`; image: exactly 1; reel: `[]` |
| `hashtags` | string[] | 6–10, includes `#DrHalima` |
| `cta` | string | soft CTA |

## 7.2 Performance JSON

Defined by [`schemas/performance.schema.json`](../schemas/performance.schema.json).

```json
{
  "post_id": "2026-10-02-3",
  "captured_at": "2026-10-09T06:00:12+06:00",
  "likes": 0,
  "comments": 0,
  "shares": 0,
  "saves": 0,
  "reach": 0,
  "engagement_score": 0,
  "platforms": {
    "instagram": { "media_id": "", "likes": 0, "comments": 0, "shares": 0, "saves": 0, "reach": 0 },
    "facebook":  { "media_id": "", "likes": 0, "comments": 0, "shares": 0, "saves": 0, "reach": 0 }
  }
}
```

## 7.3 Google Sheets schema

### `Content` (one row per post — system of record) — header in [`sheets/Content.csv`](../sheets/Content.csv)

| Col | Field | Col | Field | Col | Field |
|---|---|---|---|---|---|
| A | id | M | hashtags (space-separated) | Y | fb_post_id |
| B | date (Date) | N | cta | Z | published_at |
| C | scheduled_slot | O | script | AA | likes |
| D | scheduled_at (ISO +06:00) | P | video_storyboard_json | AB | comments |
| E | post_type | Q | carousel_slides_json | AC | shares |
| F | content_pillar | R | visual_prompt | AD | saves |
| G | topic | S | image_urls (comma-separated) | AE | reach |
| H | hook_pattern | T | video_url | AF | engagement_score |
| I | content_goal | U | status | AG | metrics_updated_at |
| J | hook_english | V | compliance_status | AH | retry_count |
| K | hook_bangla_short | W | compliance_notes | AI | last_error |
| L | caption | X | ig_media_id | AJ | run_id |

`status` ∈ generated, ready, awaiting_video, needs_review, publishing, published, failed, skipped.
Data validation (dropdown) on `U`, `E`, `F`, `H`, `I` prevents typos when editors change rows.

### `Performance` (append-only snapshots) — `post_id, captured_at, platform, likes, comments, shares, saves, reach, engagement_score`

### `Insights` — formulas only ([sheets/Insights.formulas.md](../sheets/Insights.formulas.md))

### `Config` — key/value settings and escaped prompts ([sheets/Config.csv](../sheets/Config.csv))

### `Topic_Bank` — `content_pillar, topic, priority` ([sheets/Topic_Bank.csv](../sheets/Topic_Bank.csv))

### `Logs` — `timestamp, scenario, module, level, post_id, message, execution_id`

## 7.4 Database schema (when outgrowing Sheets)

PostgreSQL equivalent; the backend's storage layer is the only code that changes.

```sql
CREATE TYPE post_status AS ENUM ('generated','ready','awaiting_video','needs_review','publishing','published','failed','skipped');

CREATE TABLE posts (
  id                 text PRIMARY KEY,               -- 2026-10-02-3
  run_date           date NOT NULL,
  scheduled_slot     text NOT NULL CHECK (scheduled_slot ~ '^slot[1-5]$'),
  scheduled_at       timestamptz NOT NULL,
  post_type          text NOT NULL CHECK (post_type IN ('reel','image','carousel')),
  content_pillar     text NOT NULL,
  topic              text NOT NULL,
  hook_pattern       text NOT NULL,
  content_goal       text NOT NULL,
  content            jsonb NOT NULL,                 -- the full daily_batch item
  image_urls         text[] NOT NULL DEFAULT '{}',
  video_url          text,
  status             post_status NOT NULL DEFAULT 'generated',
  compliance_status  text,
  compliance_notes   text,
  ig_media_id        text,
  fb_post_id         text,
  published_at       timestamptz,
  retry_count        int NOT NULL DEFAULT 0,
  last_error         text,
  run_id             text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_date, scheduled_slot)
);
CREATE INDEX posts_due_idx ON posts (status, scheduled_at);
CREATE INDEX posts_topic_idx ON posts (run_date, topic);

CREATE TABLE performance_snapshots (
  post_id          text REFERENCES posts(id),
  captured_at      timestamptz NOT NULL,
  platform         text NOT NULL CHECK (platform IN ('instagram','facebook','total')),
  likes int, comments int, shares int, saves int, reach int,
  engagement_score numeric(10,2),
  PRIMARY KEY (post_id, captured_at, platform)
);

CREATE TABLE run_log (
  id bigserial PRIMARY KEY, at timestamptz DEFAULT now(), scenario text, step text,
  level text, post_id text, message text, details jsonb
);
```
