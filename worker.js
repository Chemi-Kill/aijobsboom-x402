// AIJOBSBOOM x402 data API.
//
// Serves rollup statistics from the aijobsboom.com pipeline (see
// ../pipeline.py and ../BUILD_BRIEF.md) — never raw job listings. See
// methodology.md for the full column dictionary and scrub-rule writeup.
//
// GET /methodology — free, plain text.
// GET /health      — free, {latest_row_date, board_rows} freshness probe.
// GET /snapshot     — latest pipeline-run row as JSON. $0.01 USDC.
// GET /series?weeks=N — last N rows as JSON array, oldest -> newest. $0.10 USDC.
//
// Payment rails (v1.1.0): Solana via the PayAI facilitator is PRIMARY and
// unchanged; Base via Coinbase's CDP facilitator is an additive second rail
// that also gets the routes indexed in the x402 Bazaar. v1.3.0 (Bazaar
// listing): buyer-facing route descriptions, Base payTo moved to
// aijobsboom's own wallet, and this Worker's own CDP key ("aijobsboom-x402",
// separate from offersignal-api's) switched on as secrets. Both are advertised
// on every paid route by the multi-rail dispatcher ported from
// offersignal-api v0.4.0 (see multiRailPayment below).
//
// x402-hono's paymentMiddleware is built per-request (not at module scope)
// because Cloudflare Workers only expose `env` (wallet address, prices,
// facilitator URL) inside the fetch handler, not at import time.

import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import { createFacilitatorConfig } from "@coinbase/x402";
import statsCsvText from "./data/stats.csv";
import { createMonitor } from "./src/monitor.js";

const VERSION = "1.5.0";

const app = new Hono();

// RFC-4180-style CSV parser (hand-rolled state machine, no dependency --
// this runs in a Cloudflare Worker). Some columns (e.g. wage_floor_by_trade,
// top_employers) are JSON strings, which Python's csv module quotes because
// they contain commas and double-quotes; a naive line.split(",") would
// misparse them and shift every column after. Handles quoted fields,
// embedded commas, doubled-quote escaping ("" -> "), and quoted newlines.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; }
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\r") { /* skip -- CRLF normalizes on the \n */ }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else { cur += ch; }
  }
  if (cur !== "" || row.length > 0) { row.push(cur); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function parseCsv(text) {
  const rows = parseCsvRows(text.trim());
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0];
  const parsed = rows.slice(1).map((cells) => {
    const row = {};
    headers.forEach((h, i) => {
      const raw = cells[i] ?? "";
      if (raw === "") {
        row[h] = null;
      } else if (h === "date") {
        row[h] = raw;
      } else {
        const num = Number(raw);
        row[h] = Number.isNaN(num) ? raw : num;
      }
    });
    return row;
  });
  return { headers, rows: parsed };
}

// Columns in stats.csv that are NOT part of the API (9/27/26, Pepper's
// rolling-board ruling): board_rows_rolling counts the SITE's 14-day rolling
// board, not the pull, and the API stays strictly per-pull. Dropping it here
// also keeps ROW_SCHEMA -- and so both 402 bodies and the Bazaar listing --
// byte-identical.
const API_EXCLUDED_COLUMNS = new Set(["board_rows_rolling"]);
const PARSED = parseCsv(statsCsvText);
const COLUMNS = PARSED.headers.filter((h) => !API_EXCLUDED_COLUMNS.has(h));
// 10/4/26 (CLAUDE.md rule 3): a served row is never rewritten; a correction
// is APPENDED as a new row for the same date with corrected_from set. The
// API hides ONLY the row a correction supersedes (the nearest earlier row of
// that date without corrected_from), so /snapshot and /series return the
// correction and the original stays in stats.csv. Same-date rows WITHOUT a
// correction (the Aug 16/19/20 development runs) are served as always.
const SUPERSEDED = new Set();
PARSED.rows.forEach((r, i) => {
  if (r.corrected_from == null) return;
  for (let j = i - 1; j >= 0; j--) {
    const o = PARSED.rows[j];
    if (o.date === r.date && o.corrected_from == null && !SUPERSEDED.has(j)) { SUPERSEDED.add(j); break; }
  }
});
const ROWS = PARSED.rows
  .filter((r, i) => !SUPERSEDED.has(i))
  .map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !API_EXCLUDED_COLUMNS.has(k))));

// Columns served in every row but NOT advertised in ROW_SCHEMA (10/4/26):
// the outputSchema is embedded in both 402 bodies and the Bazaar listing,
// which must stay byte-identical. The schema sets no additionalProperties,
// so rows carrying these fields still validate. Documented in /methodology.
const SCHEMA_UNADVERTISED_COLUMNS = new Set(["wage_median_by_trade", "corrected_from"]);

// Columns whose cells are JSON-encoded strings (quoted in the CSV), not
// numbers. Everything else besides `date` is numeric or null.
const JSON_STRING_COLUMNS = new Set(["top_employers", "wage_floor_by_trade", "new_location_velocity",
  "wage_median_by_trade", "buildout_projects"]);

// JSON schema for one stats row, built from the bundled CSV header so it
// tracks new pipeline columns automatically. This is what the x402 Bazaar
// indexes (via outputSchema in the 402), same shape offersignal-api serves.
const ROW_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    COLUMNS.filter((col) => !SCHEMA_UNADVERTISED_COLUMNS.has(col)).map((col) => {
      if (col === "date") return [col, { type: "string", description: "Pipeline-run date, YYYY-MM-DD" }];
      if (JSON_STRING_COLUMNS.has(col)) return [col, { type: ["string", "null"], description: "JSON-encoded string" }];
      return [col, { type: ["number", "null"] }];
    }),
  ),
};

const METHODOLOGY_TEXT = `AIJOBSBOOM DATA API — METHODOLOGY

Publishing weekly since July 30, 2026.

WHAT THIS IS
Rollup statistics from the aijobsboom.com skilled-trades job board pipeline:
counts, not listings. Every pipeline run appends one row to stats.csv --
total rows pulled, rows removed per scrub rule, per-trade counts
(electrician/HVAC/lineman/welder/mechanic/CDL), and perk-flag counts
(fair-chance, will-train, per diem, day-1 benefits, sign-on bonus,
travel paid, employer-posted six-figure, HOT count, North Dakota count,
Montana count). No job titles, employers, URLs, or descriptions are
included in this data. See /methodology for the full writeup or
methodology.md in this repo for the column-by-column dictionary.
Oct 4, 2026: rows flagged percentage pay (e.g. percentage-of-load water
haulers quoting average monthly earnings) never count as employer-posted
six-figure and never feed the wage floors.
Oct 4, 2026: entry-tier titles (helper, apprentice, trainee, intern,
entry-level, or a title ending in " I") no longer set wage floors; they
still count in the trade counts. New column wage_median_by_trade (JSON
string, {"trade":{"median":N,"n":N}}, median null when n < 5): the median
employer-posted annualized wage, same sample as the floor.
Oct 4, 2026: CORRECTIONS. A row already served is never rewritten. A
correction is appended as a new row for the same date with corrected_from
describing what it supersedes; the API serves the correction in place of
the row it supersedes. The
2026-10-04 row was served, then corrected the same evening (electrician
floor $56,160 n=63 -> $57,200 n=61; medians added); the original row is
kept in stats.csv.
Oct 4, 2026: STANDING STEP. Every Sunday, queries that failed on the first
pull (JSearch after its retries; every Adzuna HTTP error, which the puller
does not retry) are re-run against the same feed before the row is
processed. A query that fails again is named as a feed note.
Oct 5, 2026 (first applied Oct 11): mining rows filed only because the
town carries a mining company's name (Coeur d'Alene ID, Creve Coeur MO)
are removed unless the employer or title is mining; a "$0k-0k/yr (est)"
pay display is replaced with "See listing" (row kept). Counted in the
run report, not as new columns -- the schema is unchanged.
Oct 11, 2026: full-stack, DevSecOps and UI-engineer titles removed;
Workday placeholder locations ("DNU-", "DO NOT USE", "-MX-") dropped
as foreign; titles naming three or more trades stay in the counts but
never set a wage floor or median. The Oct 11 row was re-processed
before publication (rows_final 5,898 -> 5,893).

HOW IT'S COLLECTED
Jobs are pulled from JSearch (RapidAPI) and Adzuna, then run through an
11-rule scrub (foreign-location removal, Workday location normalization,
office/desk role removal, medical/academic role removal, exec/garbage
role removal, IT/admin-desk removal, lease-purchase pay correction,
long-title trimming, tech/desk role removal, plus two rules added Sep
2026: desk-title additions -- sales/HR/back-office titles such as
"Client Executive", "Business Process & Systems", "People Systems",
"Workday Architect", "Internal Audit", and machine-learning-sense
"Transformers"/"Multimodal" titles are dropped while electrical
transformer and substation jobs are preserved; and "N Locations"
placeholder locations are nulled -- the row and its state region stay,
but "18 Locations" is not a place and never counts as a new location;
Sep 13: scrub expanded -- desk/sales/intern/retail patterns, mojibake
repair, loader/PLC exceptions -- and that row was re-processed
pre-publication;
Sep 20: trade-token guard -- a title with a core trade token
(electrician, lineman, welder, pipefitter, mechanic, technician,
operator, driver, millwright, boilermaker, ironworker, plumber) is not
removed by the desk or tech rules, except intern/co-op and
IT-support/help-desk titles -- plus new desk patterns (finance/AP/tax/
treasury, clinical/behavior/medical assistant, cook/custodian, cyber/
cloud security, equity research, real estate asset manager,
communications/content); that row was re-processed pre-publication,
5,890 -> 5,829;
Sep 27: new patterns -- executive officers, IT-abbreviation titles (field
IT technicians kept), networking/cloud-platform, trade compliance/KYC,
account reps/customer service/retail, FP&A/benefits/insurance/admin
assistants, data science/ERP, community affairs, title agents and land
acquisition (landman kept), property managers, teaching and PRN clinical
postings; power/gas/battery-storage systems engineers kept; that row was
re-processed pre-publication, 5,749 -> 5,655, then once more for a
mixed double-encoded title -- mojibake repair 0 -> 1, nothing else moved), then HOT-scored, then counted by trade using word-boundary regex
matching. A human reviews the report before any deploy -- the pipeline
itself never publishes.

SAMPLING
Aggregator feeds (via JSearch) return overlapping but non-identical
samples run-to-run; week-over-week deltas reflect both market movement
and sampling variance.

FEED-HEALTH INDICATOR (agg_share, added Sep 20 2026)
agg_share = big-five aggregator rows (LinkedIn + ZipRecruiter +
CareerBuilder + Glassdoor + Monster) / rows_in x 100, per pull. It sat
at 8-11% on every archived pull except Sep 13 (44.4%, rows_in 9,038);
on Sep 20 it was back to 8.3% (rows_in 6,651). Neither move was the
market. Week-over-week deltas are unreliable when agg_share moves more
than ~10 points -- compare rows with similar agg_share. Null before
Aug 30 2026 (no archived raw pull). Samples are never patched.

SITE BOARD VS. THIS DATA (added Sep 27 2026)
From the Sep 27 run the public job board on aijobsboom.com is a 14-day
rolling union of pulls (deduplicated by listing, carried-over listings
re-checked against current scrub rules). This API does not change:
rows_final and every other column still count this run's pull only, so
no row changes meaning. The site's own count (board_rows_rolling) is kept
in the pipeline's records but is not part of this API.
Oct 17 2026: the site board is now the union of the last two pulls (this
pull and the one before), not 14 calendar days, so an off-day pull can
never fold in a third. API columns are unaffected.

BUILDOUT PROJECTS (column buildout_projects, added Oct 17 2026)
JSON string: a list of that week's verified PUBLIC buildout announcements
(data centers, the power and grid work feeding them, the mines supplying
them). Each item: place, project, owner, dollars, mw, planned_mw,
construction_jobs, permanent_jobs, first_power_year, status, source_url,
source_kind (primary | trade press | trade press citing filing | news).
mw is OPERATING capacity only; planned capacity is planned_mw, never added
to mw. A part-built project states its parts in status ("unit 1 operating,
2 units planned"). Any number no public source published is null, never an
estimate; a figure seen only in a search snippet is not recorded. These
are public announcements, not job listings: the owners and source URLs
are the announcers' own, nothing from the listing feeds. Null before
Oct 17 2026.

OCT 17 2026 RULES (first applied to the 2026-10-17 row)
Hourly pay is kept up to $150/hr for every trade (was $75; above $150 it
still drops as suspect), and a pay written with cents in a listing now
parses -- 11 of the 24-row rise in employer-posted six-figure on that row
came from the ceiling, most of the rest from cents. A trade row under
$18/hr is apprentice-tier and leaves the wage-floor/median sample. "No
CDL", "Non-CDL" and "CDL not required" titles are not CDL. For named
mining employers, a listing with no number whose link is the employer's
own posting page has its pay read off that page (aggregator copies never).

CADENCE
Rows are appended per pipeline run, not strictly one per calendar week --
a single day can have multiple rows if the pipeline ran more than once
before the owner deployed. "Latest row" means the most recent run, not
necessarily "this week."

ToS CONSTRAINT
This API exposes only derived, aggregate statistics computed from the
job board -- never raw listings, titles, employer names, or posting
URLs. That is intentional, not a limitation: it keeps this dataset
outside the redistribution terms that JSearch (RapidAPI) and Adzuna
place on the underlying listing data aijobsboom pulls from.

PRICING
GET /snapshot -- $0.01 USDC (Solana or Base)
GET /series?weeks=N -- $0.10 USDC (Solana or Base)
GET /methodology -- free
GET /health -- free ({latest_row_date, board_rows, networks}: check freshness before you spend)

Payment via x402 (v1). Every paid route's 402 lists one "accepts" entry per
network; pay whichever matches your wallet. USDC only.
`;

app.get("/methodology", (c) => c.text(METHODOLOGY_TEXT));

// ---------------------------------------------------------------------------
// Payment rails.
//
// Solana (PayAI facilitator, X402_WALLET) is the primary rail and is
// configured exactly as before. Base (CDP facilitator, X402_BASE_WALLET)
// switches on only when that secret is set -- with it unset, this Worker
// serves Solana-only 402s exactly as v1.0 did.
// ---------------------------------------------------------------------------
function getSolanaFacilitator(env) {
  return { url: env.FACILITATOR_URL || "https://facilitator.payai.network" };
}

// Base goes through Coinbase's CDP facilitator when CDP_API_KEY_ID /
// CDP_API_KEY_SECRET are set (Worker secrets, never in this file or
// wrangler.toml) -- that is what gets the routes indexed in the x402
// Bazaar. Without them it falls back to the public x402.org facilitator so
// the rail still works, just without Bazaar discovery.
function getBaseFacilitator(env) {
  if (env.CDP_API_KEY_ID && env.CDP_API_KEY_SECRET) {
    return createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET);
  }
  return { url: env.BASE_FACILITATOR_URL || "https://x402.org/facilitator" };
}

function paymentRails(env) {
  const rails = [
    { network: env.X402_NETWORK || "solana", payTo: env.X402_WALLET, facilitator: getSolanaFacilitator(env) },
  ];
  if (env.X402_BASE_WALLET) {
    rails.push({
      network: env.X402_BASE_NETWORK || "base",
      payTo: env.X402_BASE_WALLET,
      facilitator: getBaseFacilitator(env),
    });
  }
  return rails;
}

// The v1 X-PAYMENT header is base64(JSON) with a top-level `network` field.
// We only need that one field to pick a rail; the rail's own middleware does
// the real decode + verify. Anything malformed -> null -> merged 402.
function paymentHeaderNetwork(header) {
  try {
    const payload = JSON.parse(atob(header));
    return typeof payload?.network === "string" ? payload.network : null;
  } catch {
    return null;
  }
}

// Log-safe reason for a rail that failed to build its 402 (v1.3.0). viem's
// invalid-address error quotes the payTo value verbatim, and on 2026-09-23 a
// secret pasted into the X402_BASE_WALLET slot landed in the Worker logs that
// way. Report only the value's shape, and blank out any long token-like run
// in other messages.
function safeRailError(e, rail) {
  const msg = String(e?.message || e);
  if (/Address .* is invalid/.test(msg)) {
    const v = String(rail.payTo ?? "");
    const hex40 = /^0x[0-9a-fA-F]{40}$/.test(v);
    return `invalid payTo (len=${v.length}, ${hex40 ? "0x+40 hex but bad checksum" : "not 0x + 40 hex"}) -- check the wallet secret`;
  }
  return msg.replace(/[A-Za-z0-9+/=_-]{40,}/g, (b) => `<redacted len=${b.length}>`).slice(0, 300);
}

// ---------------------------------------------------------------------------
// Multi-rail dispatcher (ported from offersignal-api v0.4.0).
//
// x402-hono v1 takes ONE `network` per route and ONE facilitator per
// middleware, so its 402 always carries exactly one `accepts` entry. To
// advertise Solana + Base on the same route without migrating to x402 v2
// (which changes the 402 wire format and would break every v1 buyer,
// including this repo's own MCP server), build one stock v1 middleware per
// rail and merge:
//
//   no X-PAYMENT        -> run every rail's middleware, collect each 402
//                          body, return ONE 402 whose `accepts` lists both
//                          rails. v1 clients (x402-fetch) already pick the
//                          entry matching their signer's network.
//   X-PAYMENT present   -> read the payload's `network`, hand the request
//                          to that rail's middleware, which verifies, runs
//                          the route, and settles through its own
//                          facilitator (PayAI for Solana, CDP for Base).
//   unknown network     -> merged 402 again, so the client sees the menu.
//
// A rail that throws while building its 402 is skipped, never fatal: the
// other rail keeps serving if one facilitator blips.
// ---------------------------------------------------------------------------
function multiRailPayment(routePath, routeConfigFor) {
  return async (c, next) => {
    const rails = paymentRails(c.env).map((rail) => ({
      network: rail.network,
      payTo: rail.payTo,
      mw: paymentMiddleware(
        rail.payTo,
        { [routePath]: { ...routeConfigFor(c.env), network: rail.network } },
        rail.facilitator,
      ),
    }));

    const payment = c.req.header("X-PAYMENT");
    if (payment) {
      const network = paymentHeaderNetwork(payment);
      const rail = rails.find((r) => r.network === network);
      if (rail) return rail.mw(c, next);
    }

    // Browser hit with no payment: x402-hono renders its paywall HTML, which
    // is an EVM wallet flow -- hand that to the Base rail when it exists.
    const accept = c.req.header("Accept") || "";
    const ua = c.req.header("User-Agent") || "";
    if (!payment && accept.includes("text/html") && ua.includes("Mozilla")) {
      const evmRail = rails.find((r) => r.network === "base") || rails[0];
      return evmRail.mw(c, next);
    }

    const accepts = [];
    let error = "X-PAYMENT header is required";
    for (const rail of rails) {
      try {
        const res = await rail.mw(c, next);
        if (!res || res.status !== 402) continue;
        const body = await res.json();
        if (Array.isArray(body.accepts)) accepts.push(...body.accepts);
        if (rail === rails[0] && body.error) error = body.error;
      } catch (e) {
        console.error(`x402 ${rail.network} rail failed to build its 402 for ${routePath}: ${safeRailError(e, rail)}`);
      }
    }
    if (accepts.length === 0) {
      return c.json({ error: "Payment rails unavailable, retry shortly" }, 503);
    }
    return c.json({ error, accepts, x402Version: 1 }, 402);
  };
}

// Free freshness probe (9/8/26): an agent can see which pipeline-run row
// /snapshot would serve, how many rows were on the board, and which payment
// networks are live, before paying.
app.get("/health", (c) => {
  if (ROWS.length === 0) return c.json({ error: "no data" }, 503);
  const latest = ROWS[ROWS.length - 1];
  return c.json({
    latest_row_date: latest.date,
    board_rows: latest.rows_final,
    version: VERSION,
    networks: paymentRails(c.env).map((r) => r.network),
  });
});

// ---------------------------------------------------------------------------
// x402 monitor (v1.2.0; owner email alerts + Monday digest since v1.4.0). Observes outcomes on the two gated routes -- probe
// (unpaid 402), fail (payment attached, still 402), settle (X-PAYMENT-RESPONSE
// present) -- and writes them to the X402_EVENTS KV namespace via waitUntil.
// It never touches a response. It MUST be registered BEFORE the payment
// middleware so it wraps it. The routes are named one by one: there is no
// shared prefix, and a wildcard would also catch /monitor.
//
// /monitor and /monitor/api are token-gated (MONITOR_TOKEN secret; a wrong
// or missing token, or an unset secret, is a plain 404). They are NOT behind
// the payment middleware and carry no Bazaar discovery metadata.
//
// prices: keep in sync with SNAPSHOT_PRICE_USDC / SERIES_PRICE_USDC in
// wrangler.toml -- the settle header carries no amount, so the monitor takes
// it from this map. wallets: in THIS Worker X402_WALLET is the Solana address
// and X402_BASE_WALLET the Base one (offersignal-api is the other way round).
// ---------------------------------------------------------------------------
const monitor = createMonitor({
  name: "aijobsboom-x402",
  version: VERSION,
  prices: { "/snapshot": 0.01, "/series": 0.1 },
  wallets: { solana: (env) => env.X402_WALLET, base: (env) => env.X402_BASE_WALLET },
  dataAsOf: () => (ROWS.length ? ROWS[ROWS.length - 1].date : null),
  // v1.4.0: one email per settle + Monday 13:00 UTC digest, via the SEND_EMAIL binding to
  // the NOTIFY_TO var (set at deploy, kept by keep_vars; see src/monitor.js header).
  notify: { from: "x402@aijobsboom.com", fromName: "aijobsboom x402", sale: "x402 sale", week: "x402 week" },
});
app.use("/snapshot", monitor.observe);
app.use("/series", monitor.observe);
monitor.routes(app);

// ---------------------------------------------------------------------------
// /snapshot -- latest pipeline-run row. Route metadata (description,
// discoverable, outputSchema) is what the CDP facilitator indexes into the
// x402 Bazaar; mirrors the offersignal-api entries' shape.
// ---------------------------------------------------------------------------
app.use(
  "/snapshot",
  multiRailPayment("/snapshot", (env) => ({
    price: `$${env.SNAPSHOT_PRICE_USDC || "0.01"}`,
    config: {
      description:
        "Weekly US blue-collar job-market snapshot: oilfield, mining, data-center construction; trade counts, wage floors with sample sizes, per-diem/travel/sign-on flags, rig count, EIA prices, grid demand, aggregator share, verified buildout announcements. Updated Sundays.",
      mimeType: "application/json",
      discoverable: true,
      outputSchema: ROW_SCHEMA,
    },
  })),
);

app.get("/snapshot", (c) => {
  if (ROWS.length === 0) return c.json({ error: "no data" }, 404);
  return c.json(ROWS[ROWS.length - 1]);
});

// ---------------------------------------------------------------------------
// /series?weeks=N -- last N rows, oldest -> newest. The queryParams example
// lands in the 402's outputSchema.input, which is how v1 Bazaar entries
// document their inputs.
// ---------------------------------------------------------------------------
app.use(
  "/series",
  multiRailPayment("/series", (env) => ({
    price: `$${env.SERIES_PRICE_USDC || "0.10"}`,
    config: {
      description:
        "Multi-week US blue-collar job-market series (last N weekly snapshots, oldest to newest, ?weeks=N, default 8): oilfield, mining, data-center construction; trade counts, wage floors with sample sizes, per-diem/travel/sign-on flags, rig count, EIA prices, grid demand, aggregator share, verified buildout announcements. Updated Sundays.",
      mimeType: "application/json",
      discoverable: true,
      inputSchema: {
        queryParams: { weeks: "8" },
      },
      outputSchema: { type: "array", items: ROW_SCHEMA },
    },
  })),
);

app.get("/series", (c) => {
  const requested = parseInt(c.req.query("weeks"), 10);
  const weeks = Number.isFinite(requested) && requested > 0 ? requested : 8;
  const n = Math.min(weeks, ROWS.length);
  return c.json(ROWS.slice(ROWS.length - n));
});

// fetch = the Hono app; scheduled = the Monday digest (cron in wrangler.toml).
export default {
  fetch: app.fetch,
  scheduled: (event, env, ctx) => monitor.scheduled(event, env, ctx),
};
