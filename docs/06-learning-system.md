# 6. Agentic learning system

## 6.1 Loop

```
publish ──► measure (day 1, 3, 7) ──► score ──► group & smooth ──► winners / losers / cooldowns
   ▲                                                                        │
   └──── ChatGPT batch ◄── prompt context ◄── pillar & format plan ◄────────┘
```

## 6.2 Signals and score

Collected per post (Instagram + Facebook summed): likes, comments, shares, saves, reach.

```
weighted         = likes×1 + comments×3 + shares×4 + saves×4
engagement_score = weighted / reach × 1000        (raw weighted sum when reach = 0)
relative perf    = engagement_score / median(engagement_score over the last 60 days)   → 1.0 = typical post
```

Shares and saves carry the most weight because they are the brand's two growth goals (reach and
save-worthiness); normalising by reach makes a post shown to 2,000 people comparable to one shown to 20,000.
The **day-7 snapshot** is the score of record; day-1 and day-3 snapshots are kept in `Performance` for
trend analysis.

## 6.3 What is learned

| Dimension | Field | Used for |
|---|---|---|
| Content pillar | `content_pillar` | pillar weights (STEP 1) |
| Format | `post_type` | carousel vs image choice |
| Hook pattern | `hook_pattern` | winning hook structures shown to ChatGPT |
| Content goal | `content_goal` | goal mix monitoring |
| Topic | `topic` | top performers (expand) / low performers (avoid) |
| Hook text | `hook_english` | winning examples (structure only) + cooldown |
| Slot | `scheduled_slot` | reporting (optional slot re-ordering) |

Group score with Bayesian smoothing (k = 3) so one viral post cannot dominate:

```
smoothed(group) = (Σ relative_perf + k) / (n + k)          # pulls small samples toward 1.0
```

## 6.4 Decision policy

| Step | Rule |
|---|---|
| Pillar weights | `weight = smoothed(pillar) × (1 + 0.15 × min(days since last used, 7))` |
| Pillar selection | Mode A (Sheets): top 5 by weight — the recency bonus guarantees rotation. Mode B (backend): weighted sampling without replacement, `P ∝ weight^1.5`, seeded by date (reproducible, still explores) |
| Reels | slot2 and slot4 get the two highest-weight pillars except Emotional Support |
| Emotional Support | slot5 when selected |
| Carousel vs image | `P(carousel) = smoothed(carousel) / (smoothed(carousel) + smoothed(image))`, clamped to 0.34–0.85, at least one carousel |
| Winners | relative perf ≥ 1.3 → "TOP PERFORMERS" (new angle on the theme) and "WINNING HOOK STRUCTURES" |
| Losers | relative perf ≤ 0.6 → "AVOID" list in the prompt and removed from topic suggestions |
| Cooldowns | topics 45 days, hooks 21 days — listed in the prompt and re-checked after generation |

## 6.5 Feedback into ChatGPT

The learning context is injected into the user prompt (template placeholders):

| Placeholder | Source |
|---|---|
| `{{daily_plan}}` | pillar plan + slot/format rules |
| `{{top_performers}}` | top 6 topics ≥ 1.3× median, with multiplier |
| `{{top_hooks}}` | top 5 hooks ≥ 1.3× median, with their pattern |
| `{{low_performers}}` | bottom 6 topics ≤ 0.6× median |
| `{{recent_topics}}` | all topics, last 45 days |
| `{{recent_hooks}}` | all hooks, last 21 days |
| `{{format_performance}}` | e.g. `carousel ×1.24, reel ×1.05, image ×0.81` |

The system prompt tells the model to create *fresh angles* on winning themes ("generate more content like
top performers") and never to repeat or paraphrase recent or low-performing topics.

## 6.6 Cold start and safeguards

- Day 1–7: no scores → all groups 1.0 → rotation-only plan; content quality comes from the prompt rules.
- Insights use at least 5 scored posts before the winners/losers lists appear (thresholds relative to the median).
- Learning never overrides compliance: a high-performing topic that later fails review is still blocked.
- Weekly human review: look at `Insights` and adjust `Topic_Bank` priorities; change thresholds in `Config`.

## 6.7 Where it runs

| | Mode A | Mode B |
|---|---|---|
| Score | S3 Make module (Set variables) | backend `learning.js › engagementScore` |
| Insights | `Insights` tab formulas ([sheets/Insights.formulas.md](../sheets/Insights.formulas.md)) | backend `computeInsights` |
| Plan | `Insights!B17/B44` | backend `planDay` |
| Prompt injection | `Insights!B1/B2` | backend `buildUserPrompt` |
