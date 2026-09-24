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

const VERSION = "1.3.0";

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

const { headers: COLUMNS, rows: ROWS } = parseCsv(statsCsvText);

// Columns whose cells are JSON-encoded strings (quoted in the CSV), not
// numbers. Everything else besides `date` is numeric or null.
const JSON_STRING_COLUMNS = new Set(["top_employers", "wage_floor_by_trade", "new_location_velocity"]);

// JSON schema for one stats row, built from the bundled CSV header so it
// tracks new pipeline columns automatically. This is what the x402 Bazaar
// indexes (via outputSchema in the 402), same shape offersignal-api serves.
const ROW_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(
    COLUMNS.map((col) => {
      if (col === "date") return [col, { type: "string", description: "Pipeline-run date, YYYY-MM-DD" }];
      if (JSON_STRING_COLUMNS.has(col)) return [col, { type: ["string", "null"], description: "JSON-encoded string" }];
      return [col, { type: ["number", "null"] }];
    }),
  ),
};

const METHODOLOGY_TEXT = `AIJOBSBOOM DATA API — METHODOLOGY

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
5,890 -> 5,829), then HOT-scored, then counted by trade using word-boundary regex
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
// x402 monitor (v1.2.0). Observes outcomes on the two gated routes -- probe
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
        "Weekly US blue-collar job-market snapshot: oilfield, mining, data-center construction; trade counts, wage floors with sample sizes, per-diem/travel/sign-on flags, rig count, EIA prices, grid demand, aggregator share. Updated Sundays.",
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
        "Multi-week US blue-collar job-market series (last N weekly snapshots, oldest to newest, ?weeks=N, default 8): oilfield, mining, data-center construction; trade counts, wage floors with sample sizes, per-diem/travel/sign-on flags, rig count, EIA prices, grid demand, aggregator share. Updated Sundays.",
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

export default app;
