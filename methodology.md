# AIJOBSBOOM x402 API — Methodology

Publishing weekly since July 30, 2026.

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
12. **Sep 13: scrub expanded (desk/sales/intern/retail patterns, mojibake repair, loader/PLC exceptions); row re-processed pre-publication.**
13. **Sep 20: trade-token guard + new desk patterns; row re-processed pre-publication.** A title containing a core trade token (electrician, lineman, welder, pipefitter, mechanic, technician, operator, driver, millwright, boilermaker, ironworker, plumber) is no longer removed by the desk/sales/HR rule or the tech/desk rule -- except intern/co-op titles, which are still removed, and IT-support/help-desk titles, which the guard never protects. New removals: finance/accounts-payable/tax/treasury, clinical/behavior-analyst/medical-assistant, cook/custodian/janitorial, cyber and cloud-security, equity research, real estate asset manager, communications/content titles. Procurement, analyst and coordinator titles are deliberately left alone. Effect on the 2026-09-20 row: 4 rows restored, 65 removed (5,890 -> 5,829). The row had not been served when it was re-processed; the first draft is kept in the archive.
14. **Sep 27: new desk, IT, compliance, property and clinical patterns; two engineering exceptions; row re-processed pre-publication.** Newly removed: named executive officers (chief information/technology/financial/operating... officer, chief of staff -- Chief Metallurgist, Chief Pilot, crew and battalion chiefs stay); titles containing the abbreviation IT (an IT field or service technician stays under the trade-token guard); networking/network-architecture/cloud-platform titles; trade compliance, KYC and privacy; account representatives, customer service, consumer lending, merchandising, manager-in-training, interpreters; FP&A, compensation, benefits/leave, insurance, billing, company secretary, personal and administrative assistants; data science, application development, ERP; community affairs/relations, tribal engagement, economic partnerships, appraisal, workforce development, office furniture/space planning; title agents and land acquisition (landman titles stay); property managers; teaching, education, physical therapy, CT technologists and PRN clinical postings. Newly kept: power, gas and battery-storage systems engineers, and a critical-facilities electrical SME titled "consultant". Effect on the 2026-09-27 row: 5,749 -> 5,655. The same evening, still before publication, the double-encoding repair (rule 0) was extended to strings that mix double-encoded and correct characters, and the row was re-processed once more: one title repaired (`scrub_mojibake_repair` 0 -> 1), no other column changed. The row had not been served when it was re-processed; both drafts are kept in the archive.
15. **Oct 4: board-only changes; row re-processed pre-publication.** The site board now drops an aggregator copy of a listing when the same title + employer + city also appears on a link that is provably the employer's own (an applicant-tracking system, a host carrying the employer's name, or a listed alias); links on unclassified hosts never merge. The board's jobs.js is also written compactly. Neither change touches the per-pull counts. The 2026-10-04 row was first processed with the merge in dry-run mode and re-processed once it was ruled: `board_rows_rolling` 9,091 -> 9,079, and the two grid-demand readings moved by a few MW because EIA was re-fetched; no other column changed. The row had not been served when it was re-processed; the first draft is kept in the archive. The same evening, still before publication, Adzuna had returned HTTP 503 on six queries (journeyman lineman, apprentice lineman, substation technician, substation electrician, protection and controls technician, winch truck driver oilfield); the pipeline does not retry Adzuna errors, so those queries had contributed no Adzuna rows. All six were re-run against Adzuna, 212 new unique rows were merged into the raw pull, and the row was re-processed: `rows_in` 6,495 -> 6,707, lineman 56 -> 119, electrician 245 -> 275, mechanic 174 -> 191, `board_rows_rolling` 9,079 -> 9,172. The row had not been served; every draft is kept in the archive.
16. **Oct 4: HVAC +68 vs Sep 27 is sampling, not a rule change** -- the prior week moved -71 the same way (Adzuna returned more HVAC rows across many employers). No rule touched the HVAC pattern.
17. **Oct 4: entry-tier titles excluded from the wage sample.** A posting whose title contains helper, apprentice, trainee, intern or entry-level (whole words), or ends in " I" (the level-one suffix -- "Technician I"; "II"/"III" are kept), no longer sets a wage floor or moves a median. Those postings still count in every trade count. On the 2026-10-04 pull this changed one number: the electrician floor, which had been set by an apprentice posting ($56,160, n=63 -> $57,200, n=61).
18. **Oct 4: new column `wage_median_by_trade`.** Median employer-posted annualized wage per trade, computed from exactly the same sample as `wage_floor_by_trade` (employer-posted, numeric display, no estimates, no percentage pay, no engineer or entry-tier titles). Same JSON shape and the same n >= 5 rule (median null below it). Appended at the end of the schema; earlier rows read null. Served in every API row; not yet listed in the 402 outputSchema, which stays byte-identical.
19. **Oct 4: first correction row (rule 3).** The 2026-10-04 row was served at 19:15 CT, then the items 17-18 rules were ruled the same evening. A served row is never rewritten: a correction row for 2026-10-04 was APPENDED, identical to the served row except `wage_floor_by_trade` (recomputed under item 17), `wage_median_by_trade` (added) and `corrected_from` (what it supersedes). It was computed from the archived pull snapshot, after confirming that snapshot reproduces the served floors exactly. The API serves the correction in place of the row it supersedes; both rows stay in stats.csv. (The Sep 9 fix to the 9/8 wage cell was an in-place edit under a one-time waiver; this is the append mechanism rule 3 prescribes.)
20. **Oct 4: failed queries are re-run before processing, every Sunday.** Standing step from the 2026-10-11 pull on (first done by hand on 2026-10-04, item 15): any query that failed on the first pull -- JSearch timeouts left failing after the puller's own retries, and every Adzuna HTTP error, which the puller does not retry -- is re-run against the same feed before the row is processed, and recovered rows are merged with the puller's own de-duplication. A query that fails again is named as a feed note.
21. **Oct 5: two scrub rules, first applied to the 2026-10-11 pull.** (a) Mine-name towns: a row filed under mining only because its city carries a mining company's name (Coeur d'Alene, Idaho; Creve Coeur, Missouri) is removed, unless the employer or the title is itself mining -- Hecla Mining in Coeur d'Alene stays. (b) A pay display of "$0k-0k/yr (est)" carries no number and is replaced with "See listing" (pay 0); the row stays. Both are counted in the pipeline's run report rather than as new stats.csv columns, so the schema is unchanged; rule (a) shows up only through `rows_final` and the trade counts. Together with items 17 and 18 and the Oct 4 percentage-pay rule, these are the Week 18 scrub rules.
22. **Oct 11: four rulings; row re-processed pre-publication.** (a) Desk-tech: hyphenated "full-stack", "DevSecOps", "user interface engineer" and "UI engineer" titles are removed (the trade-token guard still applies). (b) Workday placeholder locations -- a location starting "DNU-" or "DO NOT USE", or carrying a "-MX-" country code -- are foreign/invalid: the row is dropped (counted under `scrub_foreign`) and archived. (c) A title naming three or more trades ("Carpenter, Electrician, Welder, Construction") stays on the board and in the trade counts but, like entry-tier titles, never sets a wage floor or moves a median; HVAC and sheet metal count as modifiers, not separate trades. (d) A recruiter's applicant-tracking host is classified as staffing and never merges in the site's de-duplication. Effect on the 2026-10-11 row: `rows_final` 5,898 -> 5,893, `scrub_foreign` 96 -> 98, `scrub_tech_desk` 87 -> 90, `six_figure_posted` 39 -> 38, electrician floor $38,480 n=22 -> $54,080 n=21 and median $99,320 -> $101,920, welder n 4 -> 3, `board_rows_rolling` 9,377 -> 9,371; `grid_demand_miso` moved slightly because EIA was re-fetched. The row had not been served when it was re-processed; every draft is kept in the archive.
23. **Oct 11 feed note: three Adzuna queries lost.** Adzuna returned HTTP 503 on four queries in the 2026-10-11 pull. All four were re-run against Adzuna twice before processing (methodology item 20). EOG Resources North Dakota went through on the first re-run and returned no rows. Ensign US Drilling Permian, EOG Resources Midland Texas and Coastal Chemical Permian returned 503 on every attempt, so they contributed no Adzuna rows to the 2026-10-11 row; their JSearch rows are included. All three are oilfield employer queries.
24. **Oct 11: Monday post rules (site/social only -- no API column changes).** The weekly post (`pipeline.py weekly-post`) lists employer-direct jobs with a real posted number from one pull, North Dakota first, then Montana/Wyoming, then everywhere else, one line per employer, cap 20. As of Oct 11: a row whose pay carries no number ("Not posted", "DOE") never makes the numbered list -- hiring-event rows go to one footer line, the rest are logged as exclusions; titles lose "at <employer>", trailing ellipses and ", Oil & Gas" / ", Oilfield"; the header count is this row's `rows_final`, the same per-pull total the Dispatch uses; ANISTAR Technologies is classed as staffing; the Spanish block translates titles and pay wording with numbers untouched; LLC/Inc/trademark marks come off the displayed employer name only, never off the search link.
   Same day, second pass: Innovar Group, FootBridge and Signature IT World are classed as staffing, and "KODIAK Construction Recruiting & Staffing" by its exact name only (Kodiak Gas Services is a real employer). The catch says "rotation" only when the listing names a days-on/days-off schedule; a listing that says rotating shifts reads "rotating shifts" (detected at pull time from the next pull on), and rotation wording with no schedule reads "rotating schedule, no days-on/off posted".
   Third pass: Rinvio is classed as staffing. An employer named exactly "Kodiak" is treated as the staffing Kodiak under its short name, unless the title carries compression, recip, overhaul or oil-and-gas wording or the row is an oilfield or pipeline/gas row (Kodiak Gas Services stays an employer). The numbered list still fills to the cap of 20 when a row drops out.
25. **Oct 17: Week 20 rulings, first applied to the 2026-10-17 pull.** (a) Employer-anchored mining queries were added for JDS Energy & Mining, Northern Star Pogo, Coeur Kensington, Hecla Greens Creek, Teck Red Dog and Kiewit Mining Group in Alaska; the mine-name queries alone had missed JDS entirely. (b) Rows the feeds file under "Craft Recruiting" whose link is on allcraftjobs.com/Kiewit_Craft/ are Kiewit's own craft hiring site: the employer is recorded as Kiewit and the link counts as employer-direct. "Craft Recruiting" on any other link stays staffing. (c) New post-pull step, run after the failed-query re-runs and before processing: for those named mining employers, a row that arrived with no number ("See listing"; never an estimate) and whose link is the employer's own posting (its careers domain or its own applicant-tracking tenant) has its pay read off that page. The page must state exactly one pay figure or range with an hourly or annual unit; bonuses, per diem, stipends and allowances are ignored, and anything ambiguous is reported, not set. The row records the pay as posted, the page URL (`pay_source_url`) and the date read, and the page is archived with its sha256. Aggregator, staffing and unknown hosts are never read this way. These rows count as employer-posted pay in the wage floors and medians. (d) An RV park, campground, lodge or hotel employer is never mining, wherever it is located: such a row filed under mining is removed, counted in the run report like item 21(a). (e) The Spanish title glossary used by the weekly and state posts gained Underground, Mine, Heavy Equipment, Jumbo, Blast Hole, Drill and Geotechnician, plus the whole phrases those words arrive in. (f) Oct 17, puller pay parse: a pay written with cents in a listing's description ("$43.50/hr", "$43.50-$88.49/hr") now parses -- it was missed before -- and feed salary fields keep their cents in the display. The hourly ceiling is $150/hr for all trades (it was $75/hr): an hourly figure whose top is above $150 still drops as suspect ("See listing", no number). The same ceiling applies to (c). Hourly pay between $75 and $150 now counts toward the wage floors, medians and the employer-posted six-figure count, so part of any week-over-week move in those on the 2026-10-17 row is this rule (on that row: 11 of the 24-row gain in employer-posted six-figure came from the $150 ceiling, most of the rest from cents now parsing). (g) Oct 17, wage sample: a trade row paying under $18/hr ($37,440 a year) is apprentice-tier whatever its title says and leaves the floor and median sample (a $15.42/hr "High-Voltage Electrician" had set the electrician floor). (h) Oct 17, trade matching honors negation: a title saying "No CDL", "Non-CDL" or "CDL not required" is not counted as CDL and never enters the CDL wage sample, even though it says driver. (i) Oct 17, scrub and posts: a clinic, hospital, health, medical or dental employer is never mining or oilfield (removed, counted in the run report); Uptalent and Hays (the recruiter, by exact name) are staffing; the weekly and state posts leave out titles containing "engineer" unless the word before it is field, operating, stationary or plant; employer-page pay (c) also covers rows carried on the board from the previous pull, applied to the board copy only through an append-only ledger -- archived pull snapshots and the stats basis are never edited. No stats.csv scrub columns were added; (b) and (d) are report counts.
26. **Oct 17: new column `buildout_projects`.** A JSON list in the weekly row of that week's verified public buildout announcements (data centers, the power plants and grid work feeding them, and the mines supplying them). Each item has place, project, owner, dollars, MW, construction jobs, permanent jobs, first-power year, status and source_url. Facts only, from public sources only (owner and utility announcements, regulatory and government filings, reputable news); a number no source published is null, never an estimate. The list is assembled and checked by hand before the pull is processed (buildout/buildout_projects_<date>.json); with no file the column is null. Appended at the end of the schema, so earlier rows read null. Same day, second pass: every entry also carries `source_kind`, saying what kind of page `source_url` is -- `primary` (the owner, utility or government itself), `trade press`, `trade press citing filing` (an industry outlet reporting a public filing it names), or `news` -- so a reader can weigh the source without opening it; and `planned_mw`, planned capacity kept apart from `mw` so the two are never added together. A project that is partly built states its parts in `status` ("unit 1 operating, 2 units planned"), with the operating part in `mw` and the planned part in `planned_mw`. A dollar figure seen only in a search-result snippet, never on the page itself, is not recorded. Third pass, same day: `mw` is operating capacity only. A project not yet operating (announced, permitting, approved, under construction, paused) carries its megawatts in `planned_mw` and has `mw` null.
27. **Oct 17: the site board is the union of the last two pulls.** Until now the public board on aijobsboom.com carried every listing seen in a pull within the last 14 calendar days. Because pulls do not always fall on a Sunday, an off-day pull could fold in a third pull: the Saturday 2026-10-17 pull's 14-day window reached back to 2026-10-04 and the board would have held 12,091 rows. From the 2026-10-17 run the board is this pull plus the one before it, deduplicated by listing, with carried rows re-scrubbed under the current rules. This changes only the site board and `board_rows_rolling`, which the API does not serve; every stats column stays strictly per-pull.
28. **Oct 17: row re-processed pre-publication.** The 2026-10-17 row was first processed at 21:45 CT and had not been served (the API's latest row was 2026-10-11). After the evening rulings (items 25(g)-(i) and 27) it was re-processed in place from the same raw pull, twice: the first re-run left the PJM grid-demand pull timed out, and EIA answered on the second. Effect on the row versus the first draft: `rows_final` 5,750 -> 5,741 (health-employer scrub), electrician floor $32,073 n=38 -> $57,200 n=37 (median $92,560 -> $93,600), CDL floor $43,680 n=13 -> $47,840 n=12 (median $58,240 -> $60,320), `board_rows_rolling` 12,091 -> 8,794 (two-pull board), and `grid_demand_pjm`, `grid_demand_miso`, `henry_hub_price` and `crude_prod_tx`, null in the first draft, now filled. Employer-posted six-figure stays 62. Every draft is kept in the archive.

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
| `six_figure_posted` | Rows with an employer-posted (not estimated) annualized pay ≥ $100,000. **Oct 4, 2026:** rows flagged percentage pay (`pay_basis` = percentage, e.g. percentage-of-load water haulers quoting average monthly earnings) are excluded — an "averaging" claim is not a posted salary. |
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
| `wage_floor_by_trade` | Lowest **employer-posted** (non-estimated) wage seen this run, per trade, with the qualifying sample size. **JSON string** — `{"electrician":{"floor":39520,"n":19},"lineman":{"floor":null,"n":1},...}` — one key per trade in the same set as the trade-count columns. `floor` is null when fewer than **5** rows qualify (`n` is always published). Qualifying rows have a numeric employer-posted display pay: aggregator estimates (`(est`) and non-numeric displays such as "See listing" are excluded, as are engineer titles. **Sep 9, 2026:** wage_floor now requires n≥5 and excludes non-numeric-display pay; the 9/8 row was recomputed under this rule. 9/8 wage_floor cell corrected in place; original row preserved in archive/ (2026-09-09T1855). **Oct 4, 2026:** rows flagged percentage pay (`pay_basis` = percentage, e.g. percentage-of-load water haulers quoting average monthly earnings) are excluded — an "averaging" claim is not a posted salary. **Oct 4, 2026:** entry-tier titles (helper, apprentice, trainee, intern, entry-level, trailing " I") excluded from the sample. |
| `wage_median_by_trade` | Median **employer-posted** annualized wage per trade, same sample and rules as `wage_floor_by_trade`. **JSON string** -- `{"electrician":{"median":104000,"n":61},...}`; `median` null when n < 5. Added Oct 4, 2026 (null on earlier rows). |
| `corrected_from` | Set only on a correction row: the served row it supersedes and what changed. Null on every ordinary row. Added Oct 4, 2026. |
| `buildout_projects` | Verified public buildout announcements for the week. **JSON string** -- `[{"place":"City, ST","project":"...","owner":"...","dollars":<int|null>,"mw":<number|null>,"planned_mw":<number|null>,"construction_jobs":<int|null>,"permanent_jobs":<int|null>,"first_power_year":<int|null>,"status":"announced|permitting|approved|under_construction|operating|paused|cancelled","source_url":"https://...","source_kind":"primary|trade press|trade press citing filing|news"},...]`; `mw` is operating capacity only and `planned_mw` is planned capacity, never added together; any number not published by a public source is null. Methodology item 26. Added Oct 17, 2026 (null on earlier rows). |
| `new_location_velocity` | Count of distinct `loc` (city, state) values in this run's rows that were **not present in the immediately previous pipeline run's rows**. This is a run-over-run diff, deliberately narrower than the report's "new locations ever seen" anomaly check, which unions every prior snapshot. **Source:** derived, comparing this run's rows against the single most recent `archive/jobs/jobs_*.js` snapshot. **Cadence:** every pipeline run. **Null-on-failure:** null on the very first pipeline run ever (no prior snapshot to diff against — an undefined baseline, not a `0`), or if computing it raised an unexpected error. |
| `fair_chance_pct` | Fair-chance rows (`fairchance: true`) as a percentage of this run's final row count, to one decimal place. **Source:** derived from this run's own rows (`fairchance` count ÷ `rows_final` × 100). **Cadence:** every pipeline run. **Null-on-failure:** null only if computing it raised an unexpected error. |
| `agg_share` | Feed-health indicator: rows in the raw pull published by the big-five aggregators (LinkedIn + ZipRecruiter + CareerBuilder + Glassdoor + Monster, as relayed by JSearch) as a percentage of `rows_in`, to one decimal place. Week-over-week deltas are unreliable when `agg_share` moves more than ~10 points. **Source:** derived from this run's own raw pull, before the scrub. **Cadence:** every pipeline run. **Null-on-failure:** null for runs before 2026-08-30 (no archived raw pull to compute it from); backfilled 2026-09-20 for every run whose raw pull was archived. |

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

**Feed-health indicator (`agg_share`, added 2026-09-20).** The share of each raw pull that comes from the big-five aggregators swings independently of the job market: it sat at 8-11% on every archived pull except 2026-09-13, when it was 44.4% and `rows_in` jumped from 6,126 to 9,038; on 2026-09-20 it was back to 8.3% and `rows_in` fell to 6,651. Neither move was the market. Week-over-week deltas are unreliable when `agg_share` moves more than ~10 points -- compare rows with similar `agg_share` instead. Samples are never patched: a thin pull is published as pulled.

**Site board vs. this data (2026-09-27).** From the 2026-09-27 run the public job board on aijobsboom.com is a 14-day rolling union: a listing stays on the site while it was seen in any pull in the last 14 days (deduplicated by listing, newest sighting wins, carried-over listings re-checked against the current scrub rules, older listings dropped). This dataset does not change: `rows_final` and every other column still count this run's pull only, exactly as before, so no row changes meaning and the series stays comparable across the switch. Where this document says "on the board", read "in this run's scrubbed pull". stats.csv also records `board_rows_rolling` -- the number of listings the site served that week -- so both numbers are on record; it describes the site, not the pull, and is not served by this API.

## Operations log

**Owner sale alerts and weekly digest (2026-10-08, Worker v1.4.0).** Nothing a buyer sees changed: both 402 responses, prices and the data are as before. The Worker now emails the owner through Cloudflare Email Routing (no third-party mail service): one plain-text email for every settled payment (time in UTC and Central, route, rail, amount, payer, transaction, running count of settles this month; a payer with more than 5 settles is marked "repeat buyer"), and a digest every Monday at 13:00 UTC with the previous two weeks' sales by rail and by payer, revenue, and 402s served (a minimum, because the monitor stops counting at 100 a day). Settles also update a monthly record in the monitor's KV store (one extra read and one extra write per settle). The /monitor balance tile now shows an explicit error instead of $0.00 when the on-chain lookup fails.
