# `Insights` tab — the learning layer in Google Sheets (Mode A)

The `Insights` tab recalculates whenever the `Content` tab changes. Make reads **one cell** (`Insights!B2`,
the JSON-escaped user prompt) — so the entire learning context costs a single operation.

## Prerequisites

- Spreadsheet time zone: `(GMT+06:00) Dhaka` (File → Settings) so `TODAY()` is the Dhaka date.
- `Content!B:B` formatted as Date. `Content!AF:AF` (engagement_score) numeric.
- Named ranges (Data → Named ranges), pointing at the `Config` values:

| Name | Range | Default |
|---|---|---|
| `WINDOW_DAYS` | `Config!B9` | 60 |
| `TOPIC_COOLDOWN` | `Config!B10` | 45 |
| `HOOK_COOLDOWN` | `Config!B11` | 21 |
| `K_SMOOTH` | `Config!B12` | 3 |
| `WIN_X` | `Config!B13` | 1.3 |
| `LOSE_X` | `Config!B14` | 0.6 |
| `RECENCY_BONUS` | `Config!B15` | 0.15 |

Content column map used below: `B` date · `E` post_type · `F` content_pillar · `G` topic · `H` hook_pattern ·
`I` content_goal · `J` hook_english · `AF` engagement_score.

## Layout and formulas

### Header cells

| Cell | Label (col A) | Formula (col B) |
|---|---|---|
| B1 | USER_PROMPT | *(see "Rendered prompt" below)* |
| B2 | USER_PROMPT_ESCAPED | `=SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(SUBSTITUTE(B1,"\","\\"),"""","\"""),CHAR(13),""),CHAR(10),"\n")` |
| B3 | run_date | `=TEXT(TODAY(),"yyyy-mm-dd")` |
| B4 | median_score | `=IFERROR(MEDIAN(FILTER(Content!AF2:AF,Content!AF2:AF<>"",Content!B2:B>=TODAY()-WINDOW_DAYS)),0)` |
| B5 | scored_posts | `=COUNTIFS(Content!AF2:AF,"<>",Content!B2:B,">="&TODAY()-WINDOW_DAYS)` |

### Group performance blocks (Bayesian-smoothed relative score; 1.00 = a typical post)

**Pillars** — header row 8 (`pillar | n | sum_score | smoothed | days_since_used | weight`), rows 9–15 with
A9:A15 = `Education`, `Myth vs Fact`, `Warning/Awareness`, `Pregnancy`, `Hormonal Health`, `Emotional Support`, `Preventive Tips`.

| Col | Row 9 formula (fill down to 15) |
|---|---|
| B (n) | `=COUNTIFS(Content!$F$2:$F,$A9,Content!$AF$2:$AF,"<>",Content!$B$2:$B,">="&TODAY()-WINDOW_DAYS)` |
| C (sum) | `=SUMIFS(Content!$AF$2:$AF,Content!$F$2:$F,$A9,Content!$B$2:$B,">="&TODAY()-WINDOW_DAYS)` |
| D (smoothed) | `=IF($B$4=0,1,ROUND((C9/$B$4+K_SMOOTH)/(B9+K_SMOOTH),2))` |
| E (days since used) | `=LET(last,MAXIFS(Content!$B$2:$B,Content!$F$2:$F,$A9),IF(last=0,7,MIN(7,TODAY()-last)))` |
| F (weight) | `=ROUND(D9*(1+RECENCY_BONUS*E9),3)` |

B17 (pillars today, highest weight first): `=TEXTJOIN(", ",TRUE,SORTN(A9:A15,5,0,F9:F15,FALSE))`

**Formats** — header row 19, rows 20–22 = `reel`, `image`, `carousel`; same B/C/D formulas with
`Content!$E$2:$E` instead of `$F`. B23: `=TEXTJOIN(", ",TRUE,SORTN(A20:A22&" ×"&TEXT(D20:D22,"0.00"),3,0,D20:D22,FALSE))`

**Hook patterns** — header row 25, rows 26–30 = `Curiosity`, `Relatability`, `Myth-breaking`, `Gentle warning`,
`Reassurance`; B/C/D formulas over `Content!$H$2:$H`.

**Goals** — header row 32, rows 33–35 = `save-worthy`, `share-worthy`, `authority-building`; over `Content!$I$2:$I`.

### Learning lists (rows 38–44)

| Cell | Name | Formula |
|---|---|---|
| B38 | top_performers | `=IF($B$5<5,"(fewer than 5 scored posts — no winners yet)",LET(r,IFERROR(QUERY(Content!A2:AJ,"select F, G, AF where AF is not null and B >= date '"&TEXT(TODAY()-WINDOW_DAYS,"yyyy-mm-dd")&"' and AF >= "&$B$4*WIN_X&" order by AF desc limit 6",0),""),IF(INDEX(r,1,1)="","(none above threshold yet)",TEXTJOIN(CHAR(10),TRUE,ARRAYFORMULA("- ["&INDEX(r,,1)&"] "&INDEX(r,,2)&" (×"&ROUND(INDEX(r,,3)/$B$4,1)&")")))))` |
| B39 | top_hooks | same pattern, `select H, J, AF … limit 5` → `"- ("&INDEX(r,,1)&") "&INDEX(r,,2)` |
| B40 | low_performers | same pattern (same `$B$5<5` guard), `… and AF <= "&$B$4*LOSE_X&" order by AF asc limit 6` → `"- ["&pillar&"] "&topic` |
| B41 | recent_topics | `=IFERROR(TEXTJOIN(CHAR(10),TRUE,ARRAYFORMULA("- "&FILTER(Content!G2:G,Content!G2:G<>"",Content!B2:B>=TODAY()-TOPIC_COOLDOWN))),"(none)")` |
| B42 | recent_hooks | `=IFERROR(TEXTJOIN(CHAR(10),TRUE,ARRAYFORMULA("- "&FILTER(Content!J2:J,Content!J2:J<>"",Content!B2:B>=TODAY()-HOOK_COOLDOWN))),"(none)")` |
| B43 | format_performance | `=IF($B$5<5,"(not enough data yet)",B23)` |
| B44 | daily_plan | see below |

**B44 — daily plan:**

```
="- Pillars today (highest weight first): "&B17&CHAR(10)&
 "- slot2 (13:00) and slot4 (19:00) are reels: give them the two highest-weight pillars that are not Emotional Support."&CHAR(10)&
 "- Emotional Support, if listed, goes in slot5 (22:00)."&CHAR(10)&
 "- slot1 (10:00), slot3 (16:00), slot5 (22:00) are image or carousel; at least one carousel; prefer the better-performing format."&CHAR(10)&
 "- Use each hook pattern exactly once and include all three content goals."
```

### Rendered prompt (B1)

Mirrors `prompts/user.prompt.template.md`:

```
="Create Dr. Halima's daily batch."&CHAR(10)&CHAR(10)&
 "RUN DATE: "&B3&CHAR(10)&"TIMEZONE: Asia/Dhaka"&CHAR(10)&CHAR(10)&
 "DAILY PLAN (follow exactly):"&CHAR(10)&B44&CHAR(10)&CHAR(10)&
 "TOP PERFORMERS (last "&WINDOW_DAYS&" days — create fresh angles on these themes, never the same topic):"&CHAR(10)&B38&CHAR(10)&CHAR(10)&
 "WINNING HOOK STRUCTURES (reuse the structure, never the wording):"&CHAR(10)&B39&CHAR(10)&CHAR(10)&
 "AVOID (low performers — do not repeat these topics or close variants):"&CHAR(10)&B40&CHAR(10)&CHAR(10)&
 "RECENT TOPICS (last "&TOPIC_COOLDOWN&" days — do not repeat):"&CHAR(10)&B41&CHAR(10)&CHAR(10)&
 "RECENT HOOKS (last "&HOOK_COOLDOWN&" days — new hooks must not resemble these):"&CHAR(10)&B42&CHAR(10)&CHAR(10)&
 "FORMAT PERFORMANCE (best first): "&B43&CHAR(10)&CHAR(10)&
 "Return only the JSON object."
```

Optional: append Topic_Bank ideas for today's pillars —
`"TOPIC IDEAS: "&TEXTJOIN("; ",TRUE,FILTER(Topic_Bank!B2:B,ISNUMBER(SEARCH(Topic_Bank!A2:A,B17)),ISNA(MATCH(Topic_Bank!B2:B,FILTER(Content!G2:G,Content!B2:B>=TODAY()-TOPIC_COOLDOWN),0))))`.

## Sanity checks

- With an empty Content tab: every smoothed score = 1.00, `days_since_used` = 7 → pillars ranked by sheet order
  for day 1, then rotation takes over (recently used pillars lose their bonus).
- Cell size limit is 50,000 characters; the rendered prompt is typically < 6,000.
