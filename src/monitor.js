// monitor.js — x402 payment & activity monitor for Hono on Cloudflare Workers.
// Drop-in module. Same file for aijobsboom-x402 and offersignal-api; only createMonitor() config differs.
//
// Integration (see x402-monitor-build.md):
//   import { createMonitor } from './monitor.js';
//   const monitor = createMonitor({ name: 'offersignal-api', version: '0.5.0',
//     prices: { '/v1/tools/index': 0.05, '/v1/offers/pulse': 0.10 },
//     wallets: { solana: env => env.X402_SOLANA_WALLET, base: env => env.X402_WALLET },
//     dataAsOf: env => META.data_as_of });
//   app.use('/v1/*', monitor.observe);        // BEFORE the payment middleware(s)
//   monitor.routes(app);                       // adds /monitor and /monitor/api
//
// Bindings required: KV namespace X402_EVENTS. Secrets: MONITOR_TOKEN (required),
// TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (optional).
// Invariant: nothing in here can change a paid response. Every write is try/catch + waitUntil.
//
// Owner email (2026-10-08, MONITOR_BUILD below). Uses Cloudflare's send_email binding
// (Email Routing on aijobsboom.com), no third-party mail service:
//   - binding SEND_EMAIL ([[send_email]] in wrangler.toml)
//   - var NOTIFY_TO: a VERIFIED Email Routing destination address. Kept out of the repo:
//     set at deploy with `wrangler deploy --var NOTIFY_TO:<addr>`; keep_vars = true keeps it.
//   - cfg.notify: { from, fromName, sale: 'x402 sale', week: 'x402 week' }
// (1) every settle -> one plain-text email, sent after the KV rows are written (or failed);
//     a send failure is logged, never thrown. (2) export scheduled() -> Monday digest.
// Unset SEND_EMAIL / NOTIFY_TO = no email, everything else unchanged.
import { EmailMessage } from 'cloudflare:email';

const MONITOR_BUILD = '2026-10-08 (email alerts + digest)';
const REPEAT_AFTER = 5;     // a payer with more than this many settles (all time) is a "repeat buyer"

// Fixed 9/21/26: the downloaded constant was garbled (47 chars). This is the
// mint the Worker's own 402 advertises as `asset` and what x402 1.2.0 ships.
const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// Tried in order. A failed lookup (HTTP error, JSON-RPC error, missing result) is an
// explicit error on the tile, never $0.00 (until 2026-10-08 a failed Solana lookup
// summed an empty list and showed $0.00 while the wallet held $0.31).
const SOL_RPCS = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
const BASE_RPCS = ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'];
const TTL_SETTLE = 90 * 86400;
const TTL_PROBE = 30 * 86400;
const BALANCE_CACHE_S = 60;
// KV write budget. The free-plan limit is 1,000 KV writes per UTC day PER
// CLOUDFLARE ACCOUNT -- shared by every Worker and namespace on it (this
// module runs in both aijobsboom-x402 and offersignal-api), not per Worker.
// Once it is spent, every put() throws until 00:00 UTC; on 2026-09-24 that
// silently dropped a real Base settle. Non-settle events ("noise": probes +
// fails) are rationed per UTC day so a bot hammering a gated route can never
// starve settle records: below PROBE_EVENT_CAP a probe/fail costs 2 writes
// (event row + day row); from there to PROBE_HARD_CAP it costs 1 (day counter
// only, no evt: row); at PROBE_HARD_CAP and beyond, nothing is written.
// Worst case 20*2 + 80*1 = 120 writes per Worker per day. Settles ALWAYS
// write both rows. The /monitor page itself writes nothing to KV (see
// balance() -- that cache lives in isolate memory).
const PROBE_EVENT_CAP = 20;
const PROBE_HARD_CAP = 100;

// Balance cache, in isolate memory (moved out of KV 2026-09-25). The KV
// version wrote 2 keys per /monitor load, and the page then auto-refreshed
// every 60 s, so one open tab burned ~2,900 writes/day. The refresh is 300 s
// since 2026-09-25: each load also costs ~90 KV reads, and at 60 s one open
// tab would pass the 100k reads/day free limit (also per account). Cache API was the other
// option, but it is a no-op on *.workers.dev hosts. Per-isolate means a cold
// isolate refetches from the public RPCs -- harmless, it is 2 reads.
const balanceCache = new Map(); // net -> { at: ms, out }

export function createMonitor(cfg) {
  const name = cfg.name || 'x402';
  const prices = cfg.prices || {};

  // ---------- helpers ----------
  const rand = () => Math.random().toString(36).slice(2, 8);
  const day = (ts) => ts.slice(0, 10);
  const short = (s) => (s && s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s || '');

  async function safeEqual(a, b) {
    const enc = new TextEncoder();
    const [ha, hb] = await Promise.all([
      crypto.subtle.digest('SHA-256', enc.encode(String(a || ''))),
      crypto.subtle.digest('SHA-256', enc.encode(String(b || ''))),
    ]);
    return crypto.subtle.timingSafeEqual(ha, hb);
  }

  async function bumpDay(kv, ts, fn) {
    const key = 'day:' + day(ts);
    const cur = (await kv.get(key, 'json')) || { settles: 0, usdc: 0, probes: 0, fails: 0, by_route: {}, by_network: {} };
    fn(cur);
    cur.usdc = Math.round(cur.usdc * 1e6) / 1e6;
    await kv.put(key, JSON.stringify(cur)); // permanent
  }

  async function write(env, evt, ttl) {
    const kv = env.X402_EVENTS;
    if (!kv) return;
    let eventRow = true;
    if (evt.type !== 'settle') {
      const cur = await kv.get('day:' + day(evt.ts), 'json');
      const noise = cur ? (cur.probes || 0) + (cur.fails || 0) : 0;
      if (noise >= PROBE_HARD_CAP) return;              // budget kept for settles
      if (noise >= PROBE_EVENT_CAP) eventRow = false;   // count it, don't log it
    }
    if (eventRow) {
      const key = `evt:${evt.type}:${evt.ts}:${rand()}`;
      await kv.put(key, JSON.stringify(evt), { expirationTtl: ttl });
    }
    await bumpDay(kv, evt.ts, (d) => {
      if (evt.type === 'settle') {
        d.settles++; d.usdc += evt.amount_usdc || 0;
        d.by_route[evt.route] = (d.by_route[evt.route] || 0) + 1;
        d.by_network[evt.network] = (d.by_network[evt.network] || 0) + 1;
      } else if (evt.type === 'probe') d.probes++;
      else if (evt.type === 'fail') d.fails++;
    });
    if (evt.type === 'settle') return bumpMonth(kv, evt);
  }

  // month:YYYY-MM = { settles, usdc, payers: {addr: n this month}, payers_all: {addr: n all time} }.
  // 1 read + 1 write per settle; the first settle of a month also reads the previous
  // month once to carry payers_all forward. Settles only, so it never touches the noise budget.
  async function bumpMonth(kv, evt) {
    const mk = evt.ts.slice(0, 7);
    let cur = await kv.get('month:' + mk, 'json');
    if (!cur) {
      const [y, m] = mk.split('-').map(Number);
      const pk = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
      const prev = await kv.get('month:' + pk, 'json');
      cur = { settles: 0, usdc: 0, payers: {}, payers_all: { ...(prev?.payers_all || {}) } };
    }
    const p = evt.payer || 'unknown';
    cur.settles++; cur.usdc = r6(cur.usdc + (evt.amount_usdc || 0));
    cur.payers[p] = (cur.payers[p] || 0) + 1;
    cur.payers_all[p] = (cur.payers_all[p] || 0) + 1;
    await kv.put('month:' + mk, JSON.stringify(cur)); // permanent
    return cur;
  }

  // ---------- email ----------
  const fmtUsd = (n) => '$' + (Number(n) || 0).toFixed(Number(n) && Number(n) < 0.01 ? 6 : 2);
  const central = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short',
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
    timeZoneName: 'short' }).format(new Date(iso));
  const explorer = (net, tx) => !tx ? '' : net === 'solana' ? `https://solscan.io/tx/${tx}` : `https://basescan.org/tx/${tx}`;

  // Plain-text RFC 5322 message. Subject is kept ASCII; body is UTF-8.
  function mime(from, fromName, to, subject, body) {
    const id = `<${Date.now()}.${rand()}@${from.split('@')[1]}>`;
    return [
      `From: "${fromName}" <${from}>`, `To: ${to}`, `Subject: ${subject.replace(/[^\x20-\x7e]/g, '?')}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: ${id}`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', body.replace(/\r?\n/g, '\r\n'), '',
    ].join('\r\n');
  }

  async function sendMail(env, subject, body) {
    const n = cfg.notify || {};
    if (!env.SEND_EMAIL || !env.NOTIFY_TO || !n.from) { console.log('email skipped: SEND_EMAIL, NOTIFY_TO or cfg.notify.from missing'); return false; }
    await env.SEND_EMAIL.send(new EmailMessage(n.from, env.NOTIFY_TO, mime(n.from, n.fromName || name, env.NOTIFY_TO, subject, body)));
    return true;
  }

  function saleEmail(evt, month) {
    const n = cfg.notify || {};
    const p = evt.payer || 'unknown';
    const all = month?.payers_all?.[p] ?? null;
    const repeat = all != null && all > REPEAT_AFTER;
    const subject = `${n.sale || 'x402 sale'}: ${evt.amount_usdc != null ? fmtUsd(evt.amount_usdc) : '$?'} ${evt.route} ${evt.network}`
      + (repeat ? ' (repeat buyer)' : '') + (evt.status === 'settle_failed' ? ' [settle reported failure]' : '');
    const lines = [
      `${name} v${cfg.version || '?'}: a payment settled.`, '',
      `Time (UTC):      ${evt.ts.replace('T', ' ').slice(0, 19)}`,
      `Time (Central):  ${central(evt.ts)}`,
      `Route:           ${evt.route}`,
      `Rail:            ${evt.network}`,
      `Amount:          ${evt.amount_usdc != null ? fmtUsd(evt.amount_usdc) + ' USDC' : 'unknown (route not in price map)'}`,
      `Payer:           ${p}`,
      `Tx:              ${evt.tx || 'none in settle header'}`,
      evt.tx ? `Explorer:        ${explorer(evt.network, evt.tx)}` : null,
      '',
      month ? `Settles this month (UTC): ${month.settles}, ${fmtUsd(month.usdc)}`
            : 'Settles this month: unavailable (the KV write failed; this sale is NOT in KV, check the chain)',
      month ? `This payer: ${month.payers[p]} this month, ${all} all time${repeat ? ` (repeat buyer: more than ${REPEAT_AFTER})` : ''}` : null,
    ].filter((l) => l !== null);
    return { subject, body: lines.join('\n') + '\n' };
  }

  // ---------- weekly digest ----------
  // Weeks are Monday 00:00 to Sunday 24:00 UTC. "This week" is the last complete one before
  // `now`, "previous week" the one before it. Reads: 14 day: rows, one list of evt:settle:
  // keys, and one get per settle event in those 14 days (payer detail lives only there).
  async function digest(env, now = new Date()) {
    const kv = env.X402_EVENTS;
    const DAY = 86400000;
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const end = today - ((new Date(today).getUTCDay() + 6) % 7) * DAY; // this Monday 00:00 UTC
    const start = end - 14 * DAY;
    const dates = Array.from({ length: 14 }, (_, i) => new Date(start + i * DAY).toISOString().slice(0, 10));
    const rows = kv ? await Promise.all(dates.map((d) => kv.get('day:' + d, 'json'))) : dates.map(() => null);
    let evts = [];
    if (kv) {
      let cursor, keys = [];
      do { const l = await kv.list({ prefix: 'evt:settle:', cursor }); keys.push(...l.keys.map((k) => k.name)); cursor = l.list_complete ? null : l.cursor; } while (cursor);
      const ts = (k) => k.slice('evt:settle:'.length, k.lastIndexOf(':'));
      keys = keys.filter((k) => { const t = Date.parse(ts(k)); return t >= start && t < end; });
      evts = (await Promise.all(keys.map((k) => kv.get(k, 'json')))).filter(Boolean);
    }
    const week = (from) => {
      const r = { from: dates[from], to: dates[from + 6], settles: 0, usdc: 0, rails: {}, payers: {}, n402: 0, capped: 0, payer_rows: 0 };
      for (let i = from; i < from + 7; i++) {
        const d = rows[i]; if (!d) continue;
        r.settles += d.settles || 0; r.usdc += d.usdc || 0;
        for (const [k, v] of Object.entries(d.by_network || {})) r.rails[k] = (r.rails[k] || 0) + v;
        const noise = (d.probes || 0) + (d.fails || 0);
        r.n402 += noise; if (noise >= PROBE_HARD_CAP) r.capped++;
      }
      const lo = start + from * DAY, hi = lo + 7 * DAY;
      for (const e of evts) { const t = Date.parse(e.ts); if (t >= lo && t < hi) { r.payers[short(e.payer || 'unknown')] = (r.payers[short(e.payer || 'unknown')] || 0) + 1; r.payer_rows++; } }
      r.usdc = r6(r.usdc);
      return r;
    };
    const cur = week(7), prev = week(0);
    const list = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    const block = (label, w) => [
      `${label}: Mon ${w.from} to Sun ${w.to} (UTC)`,
      `  Sales:        ${w.settles}, ${fmtUsd(w.usdc)} USDC`,
      `  By rail:      ${list(w.rails)}`,
      `  By payer:     ${list(w.payers)}${w.payer_rows !== w.settles ? `  (payer known for ${w.payer_rows} of ${w.settles}; the rest have no event row)` : ''}`,
      `  402s served:  at least ${w.n402} (a minimum: counting stops at ${PROBE_HARD_CAP} a day; ${w.capped} of 7 days hit that cap)`,
    ].join('\n');
    const n = cfg.notify || {};
    const subject = `${n.week || 'x402 week'}: ${cur.settles} sales, ${fmtUsd(cur.usdc)}`;
    const body = `${name} v${cfg.version || '?'} weekly digest\n\n${block('This week', cur)}\n\n${block('Previous week', prev)}\n`;
    return { subject, body, cur, prev };
  }

  async function scheduled(event, env, ctx) {
    const job = (async () => {
      try { const d = await digest(env, new Date(event.scheduledTime || Date.now())); await sendMail(env, d.subject, d.body); }
      catch (e) { console.log('digest failed', e && e.message); }
    })();
    try { ctx.waitUntil(job); } catch { await job; }
  }

  async function telegram(env, evt) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
    const text = `💵 ${name} ${evt.route} $${evt.amount_usdc} ${evt.network} ${short(evt.payer)} ${short(evt.tx)}`;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  }

  function record(c, evt, ttl) {
    const job = (async () => {
      let month = null;
      try { month = await write(c.env, evt, ttl); } catch (e) { console.log('monitor write failed', e && e.message); }
      if (evt.type === 'settle') {
        // Sent whether or not the KV write worked: if KV is out of budget, this email is the only record.
        try { const m = saleEmail(evt, month || null); await sendMail(c.env, m.subject, m.body); } catch (e) { console.log('sale email failed', e && e.message); }
        try { await telegram(c.env, evt); } catch (e) { console.log('telegram failed', e && e.message); }
      }
    })();
    try { c.executionCtx.waitUntil(job); } catch { /* no ctx (tests) — let it float */ }
  }

  function decodeSettle(header) {
    try { return JSON.parse(atob(header)); } catch { return null; }
  }

  // ---------- middleware: observe outcomes without touching them ----------
  async function observe(c, next) {
    const ts = new Date().toISOString();
    const route = new URL(c.req.url).pathname;
    const hadPayment = !!c.req.header('X-PAYMENT');
    await next();
    try {
      const res = c.res;
      const settleHdr = res.headers.get('X-PAYMENT-RESPONSE');
      if (settleHdr) {
        const s = decodeSettle(settleHdr) || {};
        record(c, {
          type: 'settle', ts, route,
          network: String(s.network || '').includes('solana') ? 'solana' : (s.network ? 'base' : 'unknown'),
          payer: s.payer || null, tx: s.transaction || null,
          amount_usdc: prices[route] ?? null, status: s.success === false ? 'settle_failed' : 'settled',
        }, TTL_SETTLE);
      } else if (res.status === 402 && hadPayment) {
        record(c, { type: 'fail', ts, route, error: 'verify_or_settle_rejected' }, TTL_PROBE);
      } else if (res.status === 402) {
        record(c, { type: 'probe', ts, route, ua: (c.req.header('user-agent') || '').slice(0, 80), cf_country: c.req.raw.cf?.country || null }, TTL_PROBE);
      }
    } catch (e) { console.log('monitor observe failed', e && e.message); }
  }

  // ---------- balances ----------
  // First RPC that answers with a JSON-RPC result wins; an HTTP error, a JSON-RPC error
  // object or an unparseable body moves on to the next. All failing throws, with each reason.
  async function rpcFirst(urls, method, params) {
    const errs = [];
    for (const url of urls) {
      const host = new URL(url).host;
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        if (!r.ok) { errs.push(`${host} HTTP ${r.status}`); continue; }
        const j = await r.json();
        if (j.error) { errs.push(`${host} ${j.error.code ?? ''} ${String(j.error.message || '').slice(0, 80)}`.trim()); continue; }
        if (!('result' in j)) { errs.push(`${host} no result`); continue; }
        return { result: j.result, host };
      } catch (e) { errs.push(`${host} ${e.message}`); }
    }
    throw new Error('balance lookup failed: ' + errs.join('; '));
  }

  async function balance(env, net) {
    const hit = balanceCache.get(net);
    if (hit && Date.now() - hit.at < BALANCE_CACHE_S * 1000) return hit.out;
    let out = { usdc: null, error: null };
    try {
      const addr = cfg.wallets?.[net]?.(env);
      if (!addr) throw new Error('no wallet configured');
      out.address = addr;
      if (net === 'solana') {
        const res = await rpcFirst(SOL_RPCS, 'getTokenAccountsByOwner', [addr, { mint: USDC_SOL_MINT }, { encoding: 'jsonParsed' }]);
        if (!Array.isArray(res.result?.value)) throw new Error(`${res.host}: no token-account list in reply`);
        out.usdc = res.result.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmountString ?? a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
        out.rpc = res.host;
      } else {
        const data = '0x70a08231' + addr.toLowerCase().replace('0x', '').padStart(64, '0');
        const res = await rpcFirst(BASE_RPCS, 'eth_call', [{ to: USDC_BASE, data }, 'latest']);
        if (typeof res.result !== 'string' || !/^0x[0-9a-f]*$/i.test(res.result)) throw new Error(`${res.host}: no balance in reply`);
        out.usdc = Number(BigInt(res.result === '0x' ? '0x0' : res.result)) / 1e6;
        out.rpc = res.host;
      }
    } catch (e) { out.usdc = null; out.error = e.message; console.log('balance lookup failed', net, e.message); }
    balanceCache.set(net, { at: Date.now(), out });
    return out;
  }

  // ---------- data assembly ----------
  async function snapshot(env) {
    const kv = env.X402_EVENTS;
    const now = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
      const row = (kv && (await kv.get('day:' + d, 'json'))) || { settles: 0, usdc: 0, probes: 0, fails: 0, by_route: {}, by_network: {} };
      days.push({ date: d, ...row });
    }
    // all-time from every day: row
    let allTime = { settles: 0, usdc: 0 };
    if (kv) {
      let cursor; do {
        const l = await kv.list({ prefix: 'day:', cursor });
        for (const k of l.keys) { const r = await kv.get(k.name, 'json'); if (r) { allTime.settles += r.settles || 0; allTime.usdc += r.usdc || 0; } }
        cursor = l.list_complete ? null : l.cursor;
      } while (cursor);
    }
    // last 50 events
    let events = [];
    if (kv) {
      let cursor, keys = [];
      do { const l = await kv.list({ prefix: 'evt:', cursor }); keys.push(...l.keys.map(k => k.name)); cursor = l.list_complete ? null : l.cursor; } while (cursor);
      keys.sort((a, b) => (a.split(':')[2] < b.split(':')[2] ? 1 : -1)); // newest first by ts
      events = (await Promise.all(keys.slice(0, 50).map(k => kv.get(k, 'json')))).filter(Boolean);
    }
    const sum = (n, f) => days.slice(-n).reduce((s, d) => s + (d[f] || 0), 0);
    const cut = (h) => now.getTime() - h * 3600000;
    const settles24 = events.filter(e => e.type === 'settle' && Date.parse(e.ts) > cut(24));
    const routes30 = {}, nets30 = {};
    for (const d of days) { for (const [k, v] of Object.entries(d.by_route || {})) routes30[k] = (routes30[k] || 0) + v; for (const [k, v] of Object.entries(d.by_network || {})) nets30[k] = (nets30[k] || 0) + v; }
    const [sol, base] = await Promise.all([balance(env, 'solana'), balance(env, 'base')]);
    return {
      worker: name, version: cfg.version || null, data_as_of: safeCall(cfg.dataAsOf, env), generated: now.toISOString(),
      tiles: {
        h24: { settles: settles24.length, usdc: r6(settles24.reduce((s, e) => s + (e.amount_usdc || 0), 0)) },
        d7: { settles: sum(7, 'settles'), usdc: r6(sum(7, 'usdc')) },
        d30: { settles: sum(30, 'settles'), usdc: r6(sum(30, 'usdc')), probes: sum(30, 'probes'), fails: sum(30, 'fails') },
        all: { settles: allTime.settles, usdc: r6(allTime.usdc) },
      },
      balances: { solana: sol, base: base },
      by_route_30d: routes30, by_network_30d: nets30, days, events,
    };
  }
  const r6 = (n) => Math.round(n * 1e6) / 1e6;
  const safeCall = (f, env) => { try { return f ? f(env) : null; } catch { return null; } };

  // ---------- HTML ----------
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function txLink(e) {
    if (!e.tx) return '';
    const u = e.network === 'solana' ? `https://solscan.io/tx/${e.tx}` : `https://basescan.org/tx/${e.tx}`;
    return `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(short(e.tx))}</a>`;
  }
  function chart(days) {
    const W = 900, H = 160, pad = 20, bw = (W - pad * 2) / days.length;
    const max = Math.max(1, ...days.map(d => Math.max(d.settles, d.probes)));
    let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="30-day settles and probes">`;
    days.forEach((d, i) => {
      const x = pad + i * bw;
      const hp = (d.probes / max) * (H - pad * 2), hs = (d.settles / max) * (H - pad * 2);
      s += `<rect x="${x + 1}" y="${H - pad - hp}" width="${bw - 2}" height="${hp}" fill="#cbd5e1"><title>${d.date}: ${d.probes} probes</title></rect>`;
      s += `<rect x="${x + 1}" y="${H - pad - hs}" width="${bw - 2}" height="${hs}" fill="#16a34a"><title>${d.date}: ${d.settles} settles, $${d.usdc}</title></rect>`;
      if (i % 5 === 0) s += `<text x="${x + bw / 2}" y="${H - 4}" font-size="10" text-anchor="middle" fill="#64748b">${d.date.slice(5)}</text>`;
    });
    return s + '</svg>';
  }
  function html(s) {
    const tile = (label, v) => `<div class="tile"><div class="k">${label}</div><div class="v">${v}</div></div>`;
    const bal = (n, b) => tile(`${n} USDC balance`, b.usdc == null ? `<span class="err">${esc(b.error || 'n/a')}</span>` : `$${b.usdc.toFixed(2)}<div class="sub">${esc(short(b.address))}</div>`);
    const rows = s.events.map(e => `<tr><td>${esc(e.ts.replace('T', ' ').slice(0, 19))}</td><td class="${e.type}">${e.type}</td><td>${esc(e.route)}</td><td>${esc(e.network || '')}</td><td>${e.amount_usdc != null ? '$' + e.amount_usdc : ''}</td><td>${esc(short(e.payer))}</td><td>${txLink(e)}</td><td class="sub">${esc(e.error || e.ua || '')}</td></tr>`).join('');
    const kv = (o) => Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('') || '<tr><td colspan=2 class="sub">none</td></tr>';
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="300"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(s.worker)} monitor</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px;background:#0f172a;color:#e2e8f0}h1{font-size:18px;margin:0 0 4px}.sub{color:#94a3b8;font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}.tile{background:#1e293b;border-radius:8px;padding:12px}.k{color:#94a3b8;font-size:12px}.v{font-size:22px;font-weight:600}
table{width:100%;border-collapse:collapse;margin:8px 0 20px}td,th{padding:6px 8px;border-bottom:1px solid #334155;text-align:left;font-size:13px}th{color:#94a3b8;font-weight:500}
.settle{color:#4ade80}.probe{color:#94a3b8}.fail{color:#f87171}.err{color:#f87171;font-size:12px}a{color:#7dd3fc}h2{font-size:14px;color:#94a3b8;margin:20px 0 6px}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:600px){.two{grid-template-columns:1fr}}</style></head><body>
<h1>${esc(s.worker)} <span class="sub">v${esc(s.version)} · monitor ${esc(MONITOR_BUILD)} · data ${esc(s.data_as_of)} · ${esc(s.generated.slice(0, 16).replace('T', ' '))} UTC</span></h1>
<div class="tiles">${tile('24h', `${s.tiles.h24.settles} <span class="sub">$${s.tiles.h24.usdc}</span>`)}${tile('7d', `${s.tiles.d7.settles} <span class="sub">$${s.tiles.d7.usdc}</span>`)}${tile('30d', `${s.tiles.d30.settles} <span class="sub">$${s.tiles.d30.usdc}</span>`)}${tile('All time', `${s.tiles.all.settles} <span class="sub">$${s.tiles.all.usdc}</span>`)}${tile('30d probes / fails', `${s.tiles.d30.probes} / ${s.tiles.d30.fails}`)}</div>
<div class="tiles">${bal('Solana', s.balances.solana)}${bal('Base', s.balances.base)}${tile('Recorded 30d USDC', `$${s.tiles.d30.usdc}<div class="sub">compare to balances → unlogged payments</div>`)}</div>
<h2>30 days · green settles, grey probes</h2>${chart(s.days)}
<div class="two"><div><h2>By route, 30d</h2><table>${kv(s.by_route_30d)}</table></div><div><h2>By network, 30d</h2><table>${kv(s.by_network_30d)}</table></div></div>
<h2>Last 50 events</h2><table><tr><th>time (UTC)</th><th>type</th><th>route</th><th>net</th><th>amt</th><th>payer</th><th>tx</th><th></th></tr>${rows || '<tr><td colspan=8 class="sub">no events yet</td></tr>'}</table>
</body></html>`;
  }

  // ---------- routes ----------
  function routes(app) {
    const guard = async (c) => {
      const tok = c.req.query('token');
      if (!c.env.MONITOR_TOKEN || !tok || !(await safeEqual(tok, c.env.MONITOR_TOKEN))) return false;
      return true;
    };
    // referrer-policy: the token rides in the query string, and the page links out
    // to solscan/basescan -- never send this URL anywhere as a Referer.
    const hdr = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex', 'referrer-policy': 'no-referrer' };
    app.get('/monitor', async (c) => {
      if (!(await guard(c))) return c.notFound();
      const s = await snapshot(c.env);
      return c.html(html(s), 200, hdr);
    });
    app.get('/monitor/api', async (c) => {
      if (!(await guard(c))) return c.notFound();
      return c.json(await snapshot(c.env), 200, hdr);
    });
    // Manual trigger, same token. POST only (a reload or a link preview must not send mail).
    //   what=digest  -> build and send the Monday digest now (same code as the cron)
    //   what=sample  -> send one sale email built from fake values, marked TEST; no KV access
    //   dry=1        -> return the subject and body instead of sending
    app.post('/monitor/notify', async (c) => {
      if (!(await guard(c))) return c.notFound();
      const what = c.req.query('what');
      let m;
      if (what === 'digest') m = await digest(c.env);
      else if (what === 'sample') {
        const ts = new Date().toISOString();
        m = saleEmail({ type: 'settle', ts, route: Object.keys(prices)[0] || '/', network: 'solana', payer: 'TEST-payer-not-a-real-sale',
          tx: null, amount_usdc: Object.values(prices)[0] ?? 0.01, status: 'settled' },
          { settles: 0, usdc: 0, payers: { 'TEST-payer-not-a-real-sale': 1 }, payers_all: { 'TEST-payer-not-a-real-sale': 1 } });
        m.subject = '[TEST] ' + m.subject; m.body = 'TEST EMAIL: no payment happened. Checking the send path only.\n\n' + m.body;
      } else return c.json({ error: 'what must be digest or sample' }, 400, hdr);
      if (c.req.query('dry') === '1') return c.json({ subject: m.subject, body: m.body }, 200, hdr);
      try { const sent = await sendMail(c.env, m.subject, m.body); return c.json({ sent, subject: m.subject }, 200, hdr); }
      catch (e) { console.log('notify send failed', e && e.message); return c.json({ sent: false, error: String(e && e.message) }, 502, hdr); }
    });
  }

  return { observe, routes, snapshot, scheduled, digest, _write: write, _saleEmail: saleEmail, _mime: mime };
}
