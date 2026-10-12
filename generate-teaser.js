#!/usr/bin/env node
// Regenerates teaser.html from the latest row of data/stats.csv.
// Run after copying a fresh archive/stats.csv into data/ (see wrangler.toml).
//   node generate-teaser.js

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// RFC-4180-style CSV parser (hand-rolled state machine -- identical to the
// one in ../worker.js, kept in sync). Some columns (e.g. wage_floor_by_trade,
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
  if (rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map((cells) => {
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

// Phase 1.5b (10/6/26): the page carries a full Spanish sibling block
// (<main data-lang="es" hidden>) filled from the SAME row; the site's
// i18n-page.js shows the block for the reader's EN|ES choice. Numbers, prices,
// endpoints and URLs are identical in both blocks.
const TRADE_ES = { Electrician: "Electricista", HVAC: "HVAC", Lineman: "Liniero", Welder: "Soldador",
  Mechanic: "Mecánico", CDL: "CDL" };
const FLAG_ES = { "HOT picks": "Selecciones HOT", "Fair-chance": "Segunda oportunidad", "Will-train": "Te capacitan",
  "Per diem": "Viáticos", "Day-1 benefits": "Beneficios desde el día 1", "Sign-on bonus": "Bono de contratación",
  "Travel paid": "Viaje pagado", "Employer six-figure": "Seis cifras del empleador",
  "North Dakota": "North Dakota", "Montana": "Montana" };
const MONTHS_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre"];
function fmtDateEs(d) {
  const dt = new Date(`${d}T00:00:00Z`);
  return `${dt.getUTCDate()} de ${MONTHS_ES[dt.getUTCMonth()]} de ${dt.getUTCFullYear()}`;
}
const tradeRowsEs = trades.map(([label, val]) =>
  `        <div class="stat"><span class="num">${n(val)}</span><span class="label">${TRADE_ES[label]}</span></div>`
).join("\n");
const flagChipsEs = flags.map(([label, val]) =>
  `        <div class="chip"><b>${n(val)}</b> ${FLAG_ES[label]}</div>`
).join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="dark" />
<title>AIJOBSBOOM — Weekly Trade Board Snapshot</title>
<link rel="canonical" href="https://aijobsboom.com/teaser.html" />
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
  /* site header (same as the other pages): logo, por Pepper, EN|ES, back to the jobs */
  .ajb-head{margin:-32px -16px 28px;background:var(--steel-900);border-bottom:2px solid var(--hivis)}
  .ajb-head-in{max-width:1080px;margin:0 auto;padding:14px 16px;display:flex;justify-content:space-between;
    align-items:center;gap:12px;flex-wrap:wrap}
  .ajb-brand{display:flex;align-items:baseline;gap:11px;flex-wrap:wrap;text-decoration:none}
  .ajb-logo{font-family:"Oswald",sans-serif;font-weight:700;letter-spacing:.04em;font-size:clamp(20px,5vw,28px);
    line-height:1;text-transform:uppercase;color:var(--bone)}
  .ajb-logo .boom{color:var(--hivis)}
  .ajb-by{font-family:"IBM Plex Mono",monospace;font-size:11px;color:var(--hivis);border:1px solid var(--line);
    border-radius:999px;padding:3px 9px;white-space:nowrap}
  .ajb-back{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:var(--bone);text-decoration:none;
    border-bottom:2px solid var(--hivis);padding-bottom:1px;white-space:nowrap}
</style>
</head>
<body>
<header class="ajb-head">
  <div class="ajb-head-in">
    <a class="ajb-brand" href="index.html"><span class="ajb-logo">AI<span class="boom">JOBS</span>BOOM</span><span class="ajb-by" data-i18n="pg_by">🌶 by Pepper</span></a>
    <div class="ajb-lang" data-langsw></div>
    <a class="ajb-back" href="index.html" data-i18n="pg_back">← back to the jobs</a>
  </div>
</header>
<main data-lang="en">
  <h1>AIJOBSBOOM — Weekly Snapshot</h1>
  <p class="subhead">Free top-line numbers from the skilled-trades job board pipeline. Full history and machine-readable access via the x402 API below.</p>
  <span class="date mono">${fmtDate(latest.date)}</span>

  <section>
    <h2>The Board</h2>
    <p class="headline"><b>${n(latest.rows_final)}</b> listings in this week's pull (from <b>${n(latest.rows_in)}</b> pulled, <b>${scrubTotal}</b> scrubbed for garbage, mismatched locations, or off-trade roles).</p>
${latest.board_rows_rolling != null && latest.board_rows_rolling !== "" ? `    <p class="headline"><b>${n(latest.board_rows_rolling)}</b> on the rolling board</p>
` : ""}  </section>

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
      <code>GET /snapshot</code> — $0.01 USDC on Solana &nbsp;·&nbsp;
      <code>GET /series?weeks=N</code> — $0.10 USDC on Solana &nbsp;·&nbsp;
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
        <li>Get a <b>Solana</b> wallet (Phantom, Solflare, or Coinbase Wallet configured for Solana).</li>
        <li>Fund it with a few dollars of <b>USDC</b> — at $0.01–$0.10 per call, that covers hundreds of requests.</li>
        <li>Point your script or agent's HTTP client at the endpoint (or use the <code>aijobsboom-x402</code> MCP server) — payment happens automatically per request, no manual approval needed.</li>
      </ol>

      <p style="margin-top:12px">Not a developer? See the Human Plan above —
      $299/year gets the weekly snapshot delivered directly, no wallet or API required.</p>
    </div>

    <p style="margin-top:12px"><a href="https://aijobsboom.com">aijobsboom.com</a></p>
  </footer>
</main>
<main data-lang="es" hidden>
  <h1>AIJOBSBOOM — Resumen semanal</h1>
  <p class="subhead">Los números principales, gratis, del proceso que arma la bolsa de trabajo para oficios. El historial completo y el acceso para máquinas, con la API x402 de abajo.</p>
  <span class="date mono">${fmtDateEs(latest.date)}</span>

  <section>
    <h2>La bolsa</h2>
    <p class="headline"><b>${n(latest.rows_final)}</b> anuncios en la corrida de esta semana (de <b>${n(latest.rows_in)}</b> recolectados, <b>${scrubTotal}</b> descartados por basura, ubicaciones que no cuadran o puestos que no son de oficio).</p>
${latest.board_rows_rolling != null && latest.board_rows_rolling !== "" ? `    <p class="headline"><b>${n(latest.board_rows_rolling)}</b> en el tablero acumulado</p>
` : ""}  </section>

  <section>
    <h2>Conteo por oficio</h2>
    <div class="stats-grid">
${tradeRowsEs}
    </div>
  </section>

  <section>
    <h2>Señales y beneficios</h2>
    <div class="chips">
${flagChipsEs}
    </div>
  </section>

  <footer>
    <p>Esta página se genera sola con la última corrida y siempre es gratis. El historial, las series semanales y el acceso por programa (incluidas herramientas MCP para agentes) están disponibles por una tarifa pequeña por consulta con la <b>API x402 de AIJOBSBOOM</b>:</p>
    <p style="margin-top:8px">
      <code>GET /snapshot</code> — $0.01 USDC en Solana &nbsp;·&nbsp;
      <code>GET /series?weeks=N</code> — $0.10 USDC en Solana &nbsp;·&nbsp;
      <code>GET /methodology</code> — gratis
    </p>

    <div style="margin-top:14px;padding:14px 16px;background:var(--steel-800);border:1px solid var(--hivis);border-radius:8px">
      <p style="color:var(--hivis);font-family:'Oswald',sans-serif;font-weight:700;text-transform:uppercase;font-size:13px;letter-spacing:.3px">Plan para personas</p>
      <p style="margin-top:6px"><b>$299/año</b> — sin billetera y sin API. Recibe el resumen semanal
      directo en tu correo, sin programar nada.</p>
      <a href="mailto:pepper@aijobsboom.com?subject=Annual%20Data%20License%20(%24299%2Fyr)"
        style="display:inline-block;margin-top:10px;padding:11px 20px;background:var(--hivis);
        color:var(--steel-900);font-family:'Oswald',sans-serif;font-weight:700;
        text-transform:uppercase;font-size:13px;letter-spacing:.3px;text-decoration:none;
        border-radius:6px">Escribe a pepper@aijobsboom.com para suscribirte →</a>
    </div>

    <div style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
      <p style="color:var(--bone);font-weight:600">¿Qué es x402?</p>
      <p style="margin-top:4px">x402 es un protocolo de pagos abierto, nativo de HTTP (creado por Coinbase), que deja
      que cualquier script o agente de IA pague por consulta en USDC — sin cuentas, sin claves de API y
      sin suscripciones. Si llamas a un endpoint de pago sin pagar, te regresa un HTTP 402 con el precio;
      un cliente compatible con x402 firma un pago chico en USDC y vuelve a intentar solo, y los datos
      llegan en esa misma consulta.</p>

      <p style="margin-top:12px;color:var(--bone);font-weight:600">Cómo pagar</p>
      <ol style="margin:4px 0 0 18px;padding:0">
        <li>Consigue una billetera de <b>Solana</b> (Phantom, Solflare o Coinbase Wallet configurada para Solana).</li>
        <li>Ponle unos cuantos dólares en <b>USDC</b> — a $0.01–$0.10 por consulta, eso alcanza para cientos de consultas.</li>
        <li>Apunta el cliente HTTP de tu script o agente al endpoint (o usa el servidor MCP <code>aijobsboom-x402</code>) — el pago se hace solo en cada consulta, sin aprobarlo a mano.</li>
      </ol>

      <p style="margin-top:12px">¿No eres programador? Mira el Plan para personas de arriba —
      por $299/año recibes el resumen semanal directo, sin billetera ni API.</p>
    </div>

    <p style="margin-top:12px"><a href="https://aijobsboom.com">aijobsboom.com</a></p>
  </footer>
</main>
<script src="i18n.js?v=4"></script>
<script src="i18n-page.js?v=2"></script>
</body>
</html>
`;

writeFileSync(join(__dirname, "teaser.html"), html, "utf-8");
console.log(`wrote teaser.html (EN + ES) from ${latest.date} row`);
