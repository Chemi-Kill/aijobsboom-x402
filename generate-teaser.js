#!/usr/bin/env node
// Regenerates teaser.html from the latest row of data/stats.csv.
// Run after copying a fresh archive/stats.csv into data/ (see wrangler.toml).
//   node generate-teaser.js

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

const csvText = readFileSync(join(__dirname, "data", "stats.csv"), "utf-8");
const rows = parseCsv(csvText);
const latest = rows[rows.length - 1];

function n(v) {
  return v == null ? "0" : String(v);
}

function fmtDate(d) {
  const dt = new Date(`${d}T00:00:00Z`);
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const scrubTotal = ["scrub_foreign", "scrub_office_desk", "scrub_medical_academic",
  "scrub_exec_garbage", "scrub_it_admin", "scrub_tech_desk"]
  .reduce((sum, key) => sum + (latest[key] || 0), 0);

const trades = [
  ["Electrician", latest.electrician],
  ["HVAC", latest.hvac],
  ["Lineman", latest.lineman],
  ["Welder", latest.welder],
  ["Mechanic", latest.mechanic],
  ["CDL", latest.cdl],
];

const flags = [
  ["HOT picks", latest.hot],
  ["Fair-chance", latest.fairchance],
  ["Will-train", latest.will_train],
  ["Per diem", latest.per_diem],
  ["Day-1 benefits", latest.day1_benefits],
  ["Sign-on bonus", latest.sign_on],
  ["Travel paid", latest.travel_paid],
  ["Employer six-figure", latest.six_figure_posted],
  ["North Dakota", latest.north_dakota],
  ["Montana", latest.montana],
];

const tradeRows = trades.map(([label, val]) =>
  `        <div class="stat"><span class="num">${n(val)}</span><span class="label">${label}</span></div>`
).join("\n");

const flagChips = flags.map(([label, val]) =>
  `        <div class="chip"><b>${n(val)}</b> ${label}</div>`
).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark" />
<title>AIJOBSBOOM — Weekly Trade Board Snapshot</title>
<meta name="description" content="Free weekly snapshot of the AIJOBSBOOM skilled-trades job board: trade counts, perk flags, and HOT picks. Full historical data available via the x402 API." />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@500;600&display=swap" rel="stylesheet" />
<style>
  :root{
    --steel-900:#16191d; --steel-800:#1e2228; --steel-700:#2a2f37;
    --hivis:#ffb400; --hazard:#ec4a16; --bone:#f3f1ea; --mute:#aab0b8; --line:#3a4048;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    background:var(--steel-900); color:var(--bone);
    font-family:"IBM Plex Sans",system-ui,sans-serif; line-height:1.5;
    padding:32px 16px 64px;
  }
  .mono{font-family:"IBM Plex Mono",ui-monospace,monospace}
  main{max-width:760px;margin:0 auto}
  h1{font-family:"Oswald",sans-serif;font-weight:700;font-size:clamp(28px,5vw,40px);
    color:var(--hivis);letter-spacing:0.3px;text-transform:uppercase}
  .subhead{color:var(--mute);margin-top:6px;font-size:15px}
  .date{display:inline-block;margin-top:14px;padding:4px 10px;border:1px solid var(--hivis);
    border-radius:999px;color:var(--hivis);font-size:13px;font-weight:600}
  section{margin-top:36px}
  h2{font-family:"Oswald",sans-serif;font-weight:600;font-size:18px;text-transform:uppercase;
    letter-spacing:0.5px;color:var(--bone);border-bottom:2px solid var(--hazard);
    padding-bottom:8px;margin-bottom:16px}
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}
  .stat{background:var(--steel-800);border:1px solid var(--line);border-radius:10px;
    padding:16px 12px;text-align:center}
  .stat .num{display:block;font-family:"Oswald",sans-serif;font-weight:700;font-size:28px;color:var(--hivis)}
  .stat .label{display:block;margin-top:4px;font-size:12.5px;color:var(--mute)}
  .chips{display:flex;flex-wrap:wrap;gap:8px}
  .chip{background:var(--steel-800);border:1px solid var(--line);border-radius:999px;
    padding:7px 12px;font-size:13px;color:var(--bone)}
  .chip b{color:var(--hivis);font-family:"IBM Plex Mono",monospace}
  .headline{background:var(--steel-800);border-left:3px solid var(--hivis);border-radius:6px;
    padding:14px 16px;font-size:15px;color:var(--bone)}
  .headline b{color:var(--hivis)}
  footer{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);
    font-size:13px;color:var(--mute)}
  footer a{color:var(--hivis);text-decoration:none}
  footer a:hover{text-decoration:underline}
  code{font-family:"IBM Plex Mono",monospace;background:var(--steel-800);padding:1px 5px;
    border-radius:4px;font-size:12.5px;color:var(--hivis)}
</style>
</head>
<body>
<main>
  <h1>AIJOBSBOOM — Weekly Snapshot</h1>
  <p class="subhead">Free top-line numbers from the skilled-trades job board pipeline. Full history and machine-readable access via the x402 API below.</p>
  <span class="date mono">${fmtDate(latest.date)}</span>

  <section>
    <h2>The Board</h2>
    <p class="headline"><b>${n(latest.rows_final)}</b> live jobs on the board (from <b>${n(latest.rows_in)}</b> pulled, <b>${scrubTotal}</b> scrubbed for garbage, mismatched locations, or off-trade roles).</p>
  </section>

  <section>
    <h2>Trade Counts</h2>
    <div class="stats-grid">
${tradeRows}
    </div>
  </section>

  <section>
    <h2>Flags &amp; Perks</h2>
    <div class="chips">
${flagChips}
    </div>
  </section>

  <footer>
    <p>This page is generated automatically from the latest pipeline run and is always free. Historical data, weekly series, and programmatic access (including MCP tools for agents) are available for a small per-call fee via the <b>AIJOBSBOOM x402 API</b>:</p>
    <p style="margin-top:8px">
      <code>GET /snapshot</code> — $0.01 USDC on Base &nbsp;·&nbsp;
      <code>GET /series?weeks=N</code> — $0.10 USDC on Base &nbsp;·&nbsp;
      <code>GET /methodology</code> — free
    </p>

    <div style="margin-top:14px;padding:14px 16px;background:var(--steel-800);border:1px solid var(--hivis);border-radius:8px">
      <p style="color:var(--hivis);font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;font-size:13px;letter-spacing:.3px">Human plan</p>
      <p style="margin-top:6px"><b>$299/year</b> — skip the wallet and the API. Get the weekly snapshot
      delivered straight to your inbox, no code required.</p>
      <a href="mailto:pepper@aijobsboom.com?subject=Annual%20Data%20License%20(%24299%2Fyr)"
        style="display:inline-block;margin-top:10px;padding:11px 20px;background:var(--hivis);
        color:var(--steel-900);font-family:'Oswald',sans-serif;font-weight:700;
        text-transform:uppercase;font-size:13px;letter-spacing:.3px;text-decoration:none;
        border-radius:6px">Email pepper@aijobsboom.com to Subscribe →</a>
    </div>

    <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
      <p style="color:var(--bone);font-weight:600">What's x402?</p>
      <p style="margin-top:4px">x402 is an open, HTTP-native payment protocol (built by Coinbase) that lets
      any script or AI agent pay per request in USDC — no accounts, API keys, or
      subscriptions. Hit a gated endpoint without paying and you get an HTTP 402
      back with the price; an x402-aware client signs a small USDC payment and
      retries automatically, and the data comes back in that same request.</p>

      <p style="margin-top:12px;color:var(--bone);font-weight:600">How to pay</p>
      <ol style="margin:4px 0 0 18px;padding:0">
        <li>Get a wallet on <b>Base</b> (Coinbase Wallet or MetaMask configured for Base).</li>
        <li>Fund it with a few dollars of <b>USDC</b> — at $0.01–$0.10 per call, that covers hundreds of requests.</li>
        <li>Point your script or agent's HTTP client at the endpoint (or use the <code>aijobsboom-x402</code> MCP server) — payment happens automatically per request, no manual approval needed.</li>
      </ol>

      <p style="margin-top:12px">Not a developer? See the Human Plan above —
      $299/year gets the weekly snapshot delivered directly, no wallet or API required.</p>
    </div>

    <p style="margin-top:12px"><a href="https://aijobsboom.com">aijobsboom.com</a></p>
  </footer>
</main>
</body>
</html>
`;

writeFileSync(join(__dirname, "teaser.html"), html, "utf-8");
console.log(`wrote teaser.html from ${latest.date} row`);
