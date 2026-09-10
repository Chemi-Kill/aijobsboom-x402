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

10. **Desk-title additions (Sep 2026)** — sales/HR/back-office titles that slipped
    past rule 9 ("Client Executive," "Business Process & Systems," "People
    Systems," "Workday Architect," "Internal Audit") and machine-learning-sense
    "Transformers"/"Multimodal" titles are dropped; electrical transformer and
    substation jobs are deliberately preserved.
11. **"N Locations" placeholders nulled** — when a feed lists the location as
    "18 Locations," that value is cleared (the row and its state region stay);
    it isn't a place and must not count as a new location.

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
| `grid_demand_pjm` | Weekly average electricity demand for the PJM balancing authority. **Source:** EIA API v2, `electricity/rto/region-data` (EIA-930 hourly grid data), `type=D`, respondent `PJM`. **Unit:** MWh — an EIA-930 hourly reading is numerically the average MW drawn during that hour, so this is the mean of the trailing 168 hourly readings (7 days) as of the pipeline run. **Cadence:** recomputed every pipeline run. **Null-on-failure:** null if no `eia` key is configured in `keys.json`, or if the EIA API call fails or returns no data for that run — a failed pull never blocks the run. |
| `grid_demand_miso` | Same as `grid_demand_pjm`, for the MISO balancing authority. Same source, unit, cadence, and null-on-failure behavior. |
| `nd_rig_count` | Current active drilling rig count in North Dakota. **Source: North Dakota Department of Mineral Resources (ND DMR)**, Current Active Drilling Rig List, `dmr.nd.gov/oilgas/riglist.asp` — public-domain state government data, updated daily. This is a distinct data source from `grid_demand_pjm`/`grid_demand_miso` and unrelated to EIA. **Unit:** count of active rigs (one row on the ND DMR page per rig; the page publishes no rig-count total, so this pipeline counts data rows in the results table itself). **Cadence:** recomputed every pipeline run, reflecting whatever ND DMR had live at run time. **Null-on-failure:** the ND DMR page is plain HTML with no API, so this is parsed defensively — the pipeline finds the results table by a stable `summary` attribute (not by position), and returns null on ANY surprise: the table isn't found (e.g. the page was redesigned), zero rows parse, or the parsed count falls outside a sane range. It never guesses a number. |
| `wti_price` | Weekly average Cushing, OK WTI crude oil spot price. **Source:** EIA API v2, `petroleum/pri/spt`, series `RWTC` — confirmed against EIA's own live API (route, facet name, and series id). **Unit:** $/BBL (dollars per barrel). EIA publishes this route's `weekly` frequency as its own computed average — this pipeline does not average daily prices itself. **Cadence:** latest published week as of the pipeline run. **Null-on-failure:** null if no `eia` key is configured in `keys.json`, or the EIA call fails or returns no data. |
| `henry_hub_price` | Weekly average Henry Hub natural gas spot price. **Source:** EIA API v2, `natural-gas/pri/fut`, series `RNGWHHD` — confirmed against EIA's own live API. **Unit:** $/MMBTU (dollars per million British thermal units). Same native-weekly-average note as `wti_price`. **Cadence / null-on-failure:** same as `wti_price`. |
| `crude_prod_us` | Latest month's U.S. crude oil field production (EIA-914 survey). **Source:** EIA API v2, `petroleum/crd/crpdn`, `duoarea=NUS`, `product=EPC0` (Crude Oil), `process=FPF` (Field Production), pinned to series `MCRFPUS2` specifically — the same facet combination without a series id also matches a *different* series (`MCRFPUS1`, thousand barrels for the whole month, not a rate), so `series` is set explicitly to avoid pulling the wrong one. **Unit:** MBBL/D (thousand barrels per day). **Cadence:** EIA-914 is a monthly survey published with a lag — observed ~3 months behind the pipeline run date as of this writing (e.g. a run in early September saw June data). **Null-on-failure:** null if no `eia` key is configured, or the EIA call fails or returns no data. |
| `crude_prod_nd` | Same as `crude_prod_us`, for North Dakota (`duoarea=SND`, series `MCRFPND2`). Same source, unit, cadence, and null-on-failure behavior. |
| `crude_prod_tx` | Same as `crude_prod_us`, for Texas (`duoarea=STX`, series `MCRFPTX2`). Same source, unit, cadence, and null-on-failure behavior. **Note:** EIA's own route documentation states its Texas estimate is independently modeled and normally differs from production figures reported by the Texas Railroad Commission (RRC) — this pipeline does not pull anything from the RRC (evaluated and passed on; see project history), so there's no redundancy or reconciliation between the two to worry about. |
| `oilgas_support_employment` | Latest month's U.S. employment in Support Activities for Oil and Gas Operations (NAICS 213112). **Source:** BLS CES (Current Employment Statistics), series `CES1021311201` — confirmed directly against BLS's own official Series Report page (`data.bls.gov`; Super Sector: Mining and logging; Industry: Support activities for oil and gas operations; NAICS 213112), seasonally adjusted. **Unit:** thousands of employees, per BLS's own convention for this series. **Cadence:** latest published month as of the pipeline run; BLS publishes monthly with a short lag, and recent months are often marked preliminary and revised later. **Null-on-failure:** null if the BLS API call fails or returns an empty series. Same optional `bls` key behavior as `jolts_construction_openings`. |
| `jolts_construction_openings` | Latest month's Construction (NAICS 23) job openings. **Source:** BLS public API v2 (`api.bls.gov/publicAPI/v2/timeseries/data/`), series `JTS230000000000000JOL` (Job Openings Level, Construction, seasonally adjusted). **Unit:** thousands of openings, per BLS's own convention for this series (e.g. a value of `326` means 326,000 openings). **Cadence:** latest published month as of the pipeline run — BLS publishes this roughly monthly with a lag, so the same figure can repeat across several weekly pipeline runs until BLS's next release. **Null-on-failure:** null if the BLS API call fails or returns an empty series. An optional `bls` key in `keys.json` raises BLS's unauthenticated rate limit but isn't required — the series is public. |
| `top_employers` | Top 10 employers by listing count this run. **JSON string** — `[{"name":"Baker Hughes","count":56},{"name":"Chevron","count":21},...]`, most listings first, at most 10 entries. **Source:** derived from this run's own rows' `employer` field — populated by the puller (`aijobsboom_puller_v3.py`) from JSearch's `employer_name` field and Adzuna's equivalent (`company.display_name`) as of 9/1/26. Rows from direct-employer feeds or manual entry don't set `employer` (their real employer is already implicit in `company_type` or known by the person entering the row) and are excluded from this count. **This is a derived, aggregate count of employer names already present in each provider's own listing data — never raw listings, titles, URLs, or descriptions** — consistent with this API's [ToS constraint](#tos-constraint). **Cadence:** every pipeline run. **Null-on-failure:** null whenever no row this run has a non-empty `employer` — including, notably, **this column will read null for every pipeline run through 8/31/26** (`employer` capture was added 9/1/26, after that week's `jobs.js` was already pulled); it becomes real starting with the next Sunday pull. Also null if computing it raised an unexpected error. |
| `wage_floor_by_trade` | Lowest **employer-posted** (non-estimated) wage seen this run, per trade, with the qualifying sample size. **JSON string** — `{"electrician":{"floor":39520,"n":19},"lineman":{"floor":null,"n":1},...}` — one key per trade in the same set as the trade-count columns. `floor` is null when fewer than **5** rows qualify (`n` is always published). Qualifying rows have a numeric employer-posted display pay: aggregator estimates (`(est`) and non-numeric displays such as "See listing" are excluded, as are engineer titles. **Sep 9, 2026:** wage_floor now requires n≥5 and excludes non-numeric-display pay; the 9/8 row was recomputed under this rule. 9/8 wage_floor cell corrected in place; original row preserved in archive/ (2026-09-09T1855). |
| `new_location_velocity` | Count of distinct `loc` (city, state) values in this run's rows that were **not present in the immediately previous pipeline run's rows**. This is a run-over-run diff, deliberately narrower than the report's "new locations ever seen" anomaly check, which unions every prior snapshot. **Source:** derived, comparing this run's rows against the single most recent `archive/jobs/jobs_*.js` snapshot. **Cadence:** every pipeline run. **Null-on-failure:** null on the very first pipeline run ever (no prior snapshot to diff against — an undefined baseline, not a `0`), or if computing it raised an unexpected error. |
| `fair_chance_pct` | Fair-chance rows (`fairchance: true`) as a percentage of this run's final row count, to one decimal place. **Source:** derived from this run's own rows (`fairchance` count ÷ `rows_final` × 100). **Cadence:** every pipeline run. **Null-on-failure:** null only if computing it raised an unexpected error. |

All trade-count columns exclude any row matching `\b(engineer|engineering)\b`
— that carve-out keeps "Software Engineer" out of every trade bucket.

**A note on the JSON-string columns** (`wage_floor_by_trade`): its value
contains commas and double-quotes, so in `stats.csv` it is written as a
properly quoted CSV field (RFC 4180 style — wrapped in `"..."`, internal
quotes doubled). A naive `line.split(",")` CSV parser will misparse this
field and shift every column after it. Consumers of this CSV must use a
quote-aware CSV parser (or a real CSV library) once this column is present.

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
| `GET /snapshot` | $0.01 USDC | Solana |
| `GET /series?weeks=N` | $0.10 USDC | Solana |
| `GET /methodology` | free | — |

Payment is enforced via [x402](https://x402.org), Coinbase's open HTTP 402
payment protocol — no accounts, API keys, or subscriptions required.

## Sampling

Aggregator feeds (via JSearch) return overlapping but non-identical samples run-to-run; week-over-week deltas reflect both market movement and sampling variance.
