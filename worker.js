// AIJOBSBOOM x402 data API.
//
// Serves rollup statistics from the aijobsboom.com pipeline (see
// ../pipeline.py and ../BUILD_BRIEF.md) — never raw job listings. See
// methodology.md for the full column dictionary and scrub-rule writeup.
//
// GET /methodology — free, plain text.
// GET /snapshot     — latest pipeline-run row as JSON. $0.01 USDC on Base.
// GET /series?weeks=N — last N rows as JSON array, oldest -> newest. $0.10 USDC on Base.
//
// x402-hono's paymentMiddleware is built per-request (not at module scope)
// because Cloudflare Workers only expose `env` (wallet address, prices,
// facilitator URL) inside the fetch handler, not at import time.

import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import statsCsvText from "./data/stats.csv";

const app = new Hono();

function parseCsv(text) {
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).filter(Boolean).map((line) => {
    const cells = line.split(",");
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
}

const ROWS = parseCsv(statsCsvText);

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
Jobs are pulled from JSearch (RapidAPI) and Adzuna, then run through a
9-rule scrub (foreign-location removal, Workday location normalization,
office/desk role removal, medical/academic role removal, exec/garbage
role removal, IT/admin-desk removal, lease-purchase pay correction,
long-title trimming, tech/desk role removal), then HOT-scored, then
counted by trade using word-boundary regex matching. A human reviews the
report before any deploy -- the pipeline itself never publishes.

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
GET /snapshot -- $0.01 USDC on Base
GET /series?weeks=N -- $0.10 USDC on Base
GET /methodology -- free
`;

app.get("/methodology", (c) => c.text(METHODOLOGY_TEXT));

app.use("/snapshot", async (c, next) => {
  const mw = paymentMiddleware(
    c.env.X402_WALLET,
    { "/snapshot": { price: `$${c.env.SNAPSHOT_PRICE_USDC || "0.01"}`, network: c.env.X402_NETWORK || "base" } },
    { url: c.env.FACILITATOR_URL || "https://x402.org/facilitator" },
  );
  return mw(c, next);
});

app.get("/snapshot", (c) => {
  if (ROWS.length === 0) return c.json({ error: "no data" }, 404);
  return c.json(ROWS[ROWS.length - 1]);
});

app.use("/series", async (c, next) => {
  const mw = paymentMiddleware(
    c.env.X402_WALLET,
    { "/series": { price: `$${c.env.SERIES_PRICE_USDC || "0.10"}`, network: c.env.X402_NETWORK || "base" } },
    { url: c.env.FACILITATOR_URL || "https://x402.org/facilitator" },
  );
  return mw(c, next);
});

app.get("/series", (c) => {
  const requested = parseInt(c.req.query("weeks"), 10);
  const weeks = Number.isFinite(requested) && requested > 0 ? requested : 8;
  const n = Math.min(weeks, ROWS.length);
  return c.json(ROWS.slice(ROWS.length - n));
});

export default app;
