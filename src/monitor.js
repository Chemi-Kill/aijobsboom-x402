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

// Fixed 9/21/26: the downloaded constant was garbled (47 chars). This is the
// mint the Worker's own 402 advertises as `asset` and what x402 1.2.0 ships.
const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SOL_RPC = 'https://api.mainnet-beta.solana.com';
const BASE_RPC = 'https://mainnet.base.org';
const TTL_SETTLE = 90 * 86400;
const TTL_PROBE = 30 * 86400;
const BALANCE_CACHE_S = 60;
// KV write budget (free tier: 1,000 writes/day). Non-settle events ("noise":
// probes + fails) are rationed per UTC day so a bot hammering a gated route
// can never starve settle records: below NOISE_ROLLUP_ONLY a probe/fail costs
// 2 writes (event row + day row); from there to NOISE_STOP it costs 1 (day
// counter only, no evt: row); at NOISE_STOP and beyond, nothing is written.
// Worst case 100*2 + 700*1 = 900 writes, leaving 100 for settles, which
// ALWAYS write both rows.
const NOISE_ROLLUP_ONLY = 100;
const NOISE_STOP = 800;

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
      if (noise >= NOISE_STOP) return;                 // budget kept for settles
      if (noise >= NOISE_ROLLUP_ONLY) eventRow = false; // count it, don't log it
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
      try { await write(c.env, evt, ttl); } catch (e) { console.log('monitor write failed', e && e.message); }
      if (evt.type === 'settle') { try { await telegram(c.env, evt); } catch (e) { console.log('telegram failed', e && e.message); } }
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
  async function balance(env, net) {
    const kv = env.X402_EVENTS;
    const ck = 'cache:balance:' + net;
    try { const c = kv && (await kv.get(ck, 'json')); if (c) return c; } catch {}
    let out = { usdc: null, error: null };
    try {
      const addr = cfg.wallets?.[net]?.(env);
      if (!addr) throw new Error('no wallet configured');
      if (net === 'solana') {
        const r = await fetch(SOL_RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner',
            params: [addr, { mint: USDC_SOL_MINT }, { encoding: 'jsonParsed' }] }) });
        const j = await r.json();
        out.usdc = (j.result?.value || []).reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
      } else {
        const data = '0x70a08231' + addr.toLowerCase().replace('0x', '').padStart(64, '0');
        const r = await fetch(BASE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC_BASE, data }, 'latest'] }) });
        const j = await r.json();
        out.usdc = Number(BigInt(j.result || '0x0')) / 1e6;
      }
      out.address = addr;
    } catch (e) { out.error = e.message; }
    try { kv && (await kv.put(ck, JSON.stringify(out), { expirationTtl: BALANCE_CACHE_S })); } catch {}
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
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60"><meta name="robots" content="noindex">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(s.worker)} monitor</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px;background:#0f172a;color:#e2e8f0}h1{font-size:18px;margin:0 0 4px}.sub{color:#94a3b8;font-size:12px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}.tile{background:#1e293b;border-radius:8px;padding:12px}.k{color:#94a3b8;font-size:12px}.v{font-size:22px;font-weight:600}
table{width:100%;border-collapse:collapse;margin:8px 0 20px}td,th{padding:6px 8px;border-bottom:1px solid #334155;text-align:left;font-size:13px}th{color:#94a3b8;font-weight:500}
.settle{color:#4ade80}.probe{color:#94a3b8}.fail{color:#f87171}.err{color:#f87171;font-size:12px}a{color:#7dd3fc}h2{font-size:14px;color:#94a3b8;margin:20px 0 6px}.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:600px){.two{grid-template-columns:1fr}}</style></head><body>
<h1>${esc(s.worker)} <span class="sub">v${esc(s.version)} · data ${esc(s.data_as_of)} · ${esc(s.generated.slice(0, 16).replace('T', ' '))} UTC</span></h1>
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
  }

  return { observe, routes, snapshot, _write: write };
}
