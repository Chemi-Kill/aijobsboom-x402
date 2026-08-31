# aijobsboom-x402

x402-gated data API for the [aijobsboom.com](https://aijobsboom.com) skilled-trades
job board, plus an MCP server wrapper that pays for calls on an agent's behalf.

**Live API:** https://aijobsboom-x402.sonofgus.workers.dev

## What this is

Rollup statistics from the aijobsboom pipeline — counts, not listings. Every
pipeline run appends one row: total rows pulled, rows removed per scrub rule,
per-trade counts (electrician, HVAC, lineman, welder, mechanic, CDL), and
perk-flag counts (fair-chance, will-train, per diem, day-1 benefits, sign-on
bonus, travel paid, employer-posted six-figure, HOT count, North Dakota,
Montana). **No job titles, employer names, posting URLs, or descriptions are
served anywhere in this dataset** — see [methodology.md](./methodology.md)
for why.

## Endpoints

| Endpoint | Price | Network |
|---|---|---|
| `GET /methodology` | free | — |
| `GET /snapshot` | $0.01 USDC | Solana |
| `GET /series?weeks=N` | $0.10 USDC | Solana |

Payment is enforced via [x402](https://x402.org) — no accounts, API keys, or
subscriptions required.

## MCP server

`mcp-server.js` wraps the API as two MCP tools, `get_snapshot` and
`get_series`. It holds its own Solana wallet (funded with USDC) and pays for
each gated call itself via `x402-fetch`'s Solana signer, so the calling
agent just invokes a tool and gets JSON back.

```bash
npm install
AIJOBSBOOM_API_BASE=https://aijobsboom-x402.sonofgus.workers.dev \
X402_CLIENT_PRIVATE_KEY=... \
npm run mcp
```

`X402_CLIENT_PRIVATE_KEY` is the base58-encoded secret key of a Solana
wallet funded with USDC (the format Phantom/Solflare export as "private
key") — never commit this.

## Worker deployment

```bash
npm install
wrangler secret put X402_WALLET      # the Solana address that receives USDC
wrangler secret put FACILITATOR_URL  # optional, overrides the default facilitator
npm run deploy
```

Data updates: after each `pipeline.py` run in the parent repo, copy the fresh
`archive/stats.csv` over `data/stats.csv`, run `npm run teaser` to refresh
`teaser.html`, then redeploy. The CSV is bundled into the Worker at build
time — there's no runtime data fetch.

## Docs

Full column dictionary, scrub-rule writeup, and ToS constraints:
[methodology.md](./methodology.md).
