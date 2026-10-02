# 5. Scheduling logic

## 5.1 Slot map

| Slot | Local time (Asia/Dhaka) | UTC | Default format | `scheduled_at` |
|---|---|---|---|---|
| slot1 | 10:00 | 04:00 | image / carousel | `<date>T10:00:00+06:00` |
| slot2 | 13:00 | 07:00 | **reel** | `<date>T13:00:00+06:00` |
| slot3 | 16:00 | 10:00 | image / carousel | `<date>T16:00:00+06:00` |
| slot4 | 19:00 | 13:00 | **reel** | `<date>T19:00:00+06:00` |
| slot5 | 22:00 | 16:00 | image / carousel (Emotional Support) | `<date>T22:00:00+06:00` |

Asia/Dhaka is **UTC+6 all year with no daylight saving**, so `scheduled_at` is built by string
concatenation with a fixed `+06:00` offset — no date arithmetic, no DST edge cases. Always store the
offset; never store naive local times.

```
scheduled_at = run_date + "T" + SLOT_TIMES[slot_index] + ":00+06:00"
run_date     = formatDate(now; YYYY-MM-DD; Asia/Dhaka)        # Make
             = DateTime.now().setZone("Asia/Dhaka").toISODate() # backend (luxon)
```

## 5.2 Daily timeline

| Local time | What runs |
|---|---|
| 06:00 | S1 generator (Free plan / Mode B: engagement sync first) |
| ~06:10 | Content rows `ready` / `awaiting_video` / `needs_review`; editor alerted about reels and held posts |
| 06:10–12:30 | Editor window: record reels, fix `needs_review` rows, set `status = ready` |
| 10:00 · 13:00 · 16:00 · 19:00 · 22:00 | S2 publisher posts due rows |
| 23:30 | S3 engagement sync (paid plans) |

## 5.3 Why Make "Sleep" is not used to wait for slots

Make's Sleep module waits at most **300 seconds**, and a scenario run is capped at **5 minutes on the Free plan**
(40 minutes on paid plans). A generator that slept until 22:00 would be killed. Instead:

- **S1** stores each post with its `scheduled_at` and finishes in minutes.
- **S2** is scheduled at exactly the slot times and publishes rows whose time has come.
- Sleep is used only for short spacing (10 s between the Instagram and Facebook calls).

## 5.4 Publisher selection rule

A row is published by the run at time `now` when:

```
status = "ready"
AND date = today (Asia/Dhaka)
AND scheduled_at <= now + 10 minutes          # run may start a few seconds early/late
AND scheduled_at >= now - 150 minutes         # catch-up for a missed run within the same slot gap
```

Rows older than 150 minutes are marked `skipped` and alerted (posting a 10:00 post at 16:00 would
crowd the 16:00 post). A reel that only becomes `ready` after its slot is published by the next run within
the 150-minute window; later than that, the editor can change its `scheduled_at` to a later slot today.

## 5.5 Make schedule settings

| Scenario | Schedule type | Settings |
|---|---|---|
| S1 Generator | Every day | 06:00 |
| S2 Publisher | At regular intervals | every 180 min, start 10:00 on the first day; Advanced scheduling: time window 09:55–22:10, all days → 10:00, 13:00, 16:00, 19:00, 22:00 |
| S3 Sync | Every day | 23:30 |

Organization time zone must be Asia/Dhaka (Make schedules use it). If it cannot be changed, use the UTC
column above.

## 5.6 Idempotency and duplicates

- S1 aborts if Content already has rows for `run_date` (re-runs and manual triggers are safe).
- Row ids are deterministic (`<date>-<slot number>`).
- S2 flips `ready → publishing` before calling Meta, so overlapping runs cannot post twice; a run that crashes
  mid-publish leaves `publishing`, which alerts and needs a manual check (did it post?) before resetting.
