# AIJOBSBOOM x402 API — Methodology

## What this data is

Rollup statistics from the [aijobsboom.com](https://aijobsboom.com) skilled-trades
job board pipeline — **counts, not listings**. Every pipeline run appends one row
to `stats.csv`: how many jobs came in, how many survived the scrub, how many
were removed by each scrub rule, per-trade counts, and perk-flag counts (fair
chance, will train, per diem, sign-on bonus, etc). This API and the underlying
CSV never contain job titles, employer names, posting URLs, or descriptions —
see [ToS constraint](#tos-constraint) below for why.

## How it's collected

The board is built by a one-command pipeline (`pipeline.py`) that a human runs
and reviews before ever deploying:

1. **Pull** — jobs are pulled from JSearch (RapidAPI) and Adzuna.
2. **Scrub** — bad rows are removed or corrected by nine rules, in order (see
   below). Counts of what each rule caught are recorded.
3. **HOT picks** — remaining rows are scored (similar-postings count, +5 for
   North Dakota/Montana, +3 for pay ≥ $120k) and the top scorers up to 450 are
   marked "hot" demand.
4. **Manual merge** — hand-verified local finds (e.g. an employer's Facebook
   post) are merged in, unscrubbed, since a human already checked them.
5. **Trade counts** — the final row set is counted by trade using
   word-boundary regex matching (see [Column dictionary](#column-dictionary)).
6. **Archive** — one row is appended to `stats.csv` per run.

A human reviews the run's report and deploys the live site manually — the
pipeline itself never publishes anything. Because of that human-in-the-loop
step, **rows are appended per pipeline run, not strictly one per calendar
week**: a day can have several identical-looking rows if the pipeline ran more
than once before the owner deployed. "Latest snapshot" means the most recent
run, not necessarily "this week's numbers."

## The scrub rules, in plain language

These rules exist because specific bad rows actually reached the live board.
Order matters — a row that matches an earlier rule never reaches a later one.

1. **Foreign rows removed** — corporate Workday feeds sometimes leak
   worldwide postings (Congo, Brazil, Australia...) tagged with a
   non-`US` location code. Those rows are dropped entirely.
2. **Workday locations normalized** — Workday-style codes like
   `US-TX-HOUSTON-...` are rewritten to a readable `Houston, Texas` (not a
   removal — this counts rows that got their location cleaned up).
3. **Office/desk roles removed** — plain-text roles like "Executive
   Assistant," "Payroll," "Bookkeeper," "Social Media" etc. are dropped; the
   board is for trades, not office work.
4. **Medical/academic roles removed** — nurses, physicians, professors,
   researchers, etc. are dropped using *word-boundary* matching, deliberately,
   because a plain substring match once deleted a real "Plant Operator at
   Occidental Petroleum" row (the word "dental" is inside "Occidental").
5. **Executive/garbage rows removed** — VP/Director/C-suite titles are
   dropped, along with literal placeholder rows like "Test 1" (one such row
   once reached the board priced at $212–292K). "Well Testing Operator" and
   "Rig Manager" are deliberately preserved.
6. **IT/admin-desk roles removed** — anything with "Administrator" in the
   title (e.g. "F5 Network Administrator") — no real trade title uses that
   word.
7. **Lease-purchase pay corrected** — trucking "lease purchase" listings post
   a big dollar figure that's actually gross truck revenue, not a wage. That
   figure is zeroed out and replaced with "See listing" so it can't pollute
   pay-based sorting or the six-figure count.
8. **Long titles trimmed** — titles 48+ characters get trimmed at a word
   boundary with an ellipsis appended, so they display cleanly.
9. **Tech/desk roles removed** — software/data/IT-flavored titles (e.g.
   "Software Engineering," "Data Analytics," a bare "Systems Engineer" outside
   an industrial-controls context) are dropped even though they weren't
   caught by rule 6. "Control Systems Engineer" and similar PLC/SCADA/
   instrumentation/automation titles are preserved as plant-floor trades work.

## Column dictionary

| Column | Meaning |
|---|---|
| `date` | Date of the pipeline run (`YYYY-MM-DD`). Multiple rows can share a date. |
| `rows_in` | Total rows pulled from JSearch + Adzuna before scrubbing. |
| `rows_final` | Rows remaining on the board after scrubbing and merge. |
| `scrub_foreign` | Rows removed — non-US location code (rule 1). |
| `scrub_workday_loc` | Rows whose Workday-style location was normalized (rule 2, not a removal). |
| `scrub_office_desk` | Rows removed — office/desk role (rule 3). |
| `scrub_medical_academic` | Rows removed — medical/academic role (rule 4). |
| `scrub_exec_garbage` | Rows removed — executive title or placeholder "Test N" row (rule 5). |
| `scrub_it_admin` | Rows removed — "Administrator" in title (rule 6). |
| `scrub_lease_purchase` | Rows whose lease-purchase pay figure was zeroed (rule 7, not a removal). |
| `scrub_title_trim` | Rows whose title was trimmed for length (rule 8, not a removal). |
| `scrub_tech_desk` | Rows removed — software/IT/data-desk role (rule 9). |
| `electrician` | Rows matching `\belectricians?\b` (excluding "engineer"/"engineering"). |
| `hvac` | Rows matching `\b(hvac\|chiller\|refrigeration)\b`. |
| `lineman` | Rows matching `\b(linemen\|lineman\|line worker\|lineworker)\b`. |
| `welder` | Rows matching `\b(welders?\|welding\|boilermakers?)\b`. |
| `mechanic` | Rows matching `\bmechanics?\b`. |
| `cdl` | Rows matching `\b(cdl\|drivers?\|haulers?)\b`. |
| `fairchance` | Rows flagged fair-chance (open to applicants with a record). |
| `will_train` | Rows flagged as offering training / no experience required. |
| `per_diem` | Rows offering a per-diem or lodging allowance. |
| `day1_benefits` | Rows offering benefits starting day one. |
| `sign_on` | Rows offering a sign-on/hiring bonus. |
| `travel_paid` | Rows offering paid travel, flights, or FIFO/mobilization coverage. |
| `six_figure_posted` | Rows with an employer-posted (not estimated) annualized pay ≥ $100,000. |
| `hot` | Rows marked "hot" demand (top HOT-score rows, capped at 450). |
| `north_dakota` | Rows located in North Dakota. |
| `montana` | Rows located in Montana. |

All trade-count columns exclude any row matching `\b(engineer|engineering)\b`
— that carve-out keeps "Software Engineer" out of every trade bucket.

## ToS constraint

**This API and its underlying CSV expose only derived, aggregate statistics —
never raw job listings.** No titles, employer names, posting URLs, or
descriptions are served anywhere in this dataset. That's a deliberate
boundary, not an oversight: aijobsboom's job data comes from JSearch
(RapidAPI) and Adzuna, and redistributing their raw listing data is outside
what those providers' terms allow. Aggregate counts computed from that data —
"273 HVAC jobs were on the board this week" — are a different thing, and are
what this API sells.

## Pricing

| Endpoint | Price | Network |
|---|---|---|
| `GET /snapshot` | $0.01 USDC | Base |
| `GET /series?weeks=N` | $0.10 USDC | Base |
| `GET /methodology` | free | — |

Payment is enforced via [x402](https://x402.org), Coinbase's open HTTP 402
payment protocol — no accounts, API keys, or subscriptions required.
