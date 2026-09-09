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

| Endpoint | Price | Networks |
|---|---|---|
| `GET /methodology` | free | — |
| `GET /health` | free | — |
| `GET /snapshot` | $0.01 USDC | Solana, Base |
| `GET /series?weeks=N` | $0.10 USDC | Solana, Base |

Payment is enforced via [x402](https://x402.org) (protocol v1) — no accounts,
API keys, or subscriptions required. Every paid route's 402 response lists
one `accepts` entry per network; a v1 client such as `x402-fetch` picks the
one matching its wallet automatically. Solana (the primary rail) settles
through the PayAI facilitator; Base settles through Coinbase's CDP
facilitator, which also lists the routes in the x402 Bazaar. `/health` is a
free freshness probe: the row date `/snapshot` would serve, the board row
count, and the live payment networks.

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
wrangler secret put X402_WALLET        # the Solana address that receives USDC (primary rail)
wrangler secret put X402_BASE_WALLET   # the Base address that receives USDC (unset = Solana-only)
wrangler secret put CDP_API_KEY_ID     # Coinbase CDP facilitator creds for the Base rail
wrangler secret put CDP_API_KEY_SECRET #   (required for Bazaar discovery; never commit these)
wrangler secret put FACILITATOR_URL    # optional, overrides the default Solana facilitator
npm run deploy
```

The Base rail is purely additive: with `X402_BASE_WALLET` unset the Worker
serves Solana-only 402s exactly as before. `pay-test-base.js` makes one real
Base payment (`PRIVATE_KEY` env var, an EVM key, never logged) and prints
the settle result; the first Base payment to a route is what lists it in
the Bazaar.

Data updates: after each `pipeline.py` run in the parent repo, copy the fresh
`archive/stats.csv` over `data/stats.csv`, run `npm run teaser` to refresh
`teaser.html`, then redeploy. The CSV is bundled into the Worker at build
time — there's no runtime data fetch.

### Data file is deploy-time local, not in the repo

`data/stats.csv` is gitignored and lives only on the deploy machine. wrangler
bundles it from local disk at deploy time (the `[[rules]]` Text rule in
`wrangler.toml`), so `npm run deploy` needs the file present. A fresh clone
will not build until `data/stats.csv` is copied in from the parent repo's
`archive/stats.csv`. Everything else needed to build and deploy is in the
repo plus the `X402_WALLET` secret.

## Docs

Full column dictionary, scrub-rule writeup, and ToS constraints:
[methodology.md](./methodology.md).
