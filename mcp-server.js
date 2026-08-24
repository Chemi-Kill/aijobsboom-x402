#!/usr/bin/env node
// MCP server wrapper for the AIJOBSBOOM x402 data API.
//
// Exposes get_snapshot and get_series as MCP tools. This process holds its
// own Base wallet (funded with USDC) and pays for each gated call itself via
// x402-fetch, so the calling agent just invokes a tool and gets JSON back --
// no wallet or payment handling on the agent's side.
//
// Env vars:
//   AIJOBSBOOM_API_BASE       base URL of the deployed Worker (default below)
//   X402_CLIENT_PRIVATE_KEY   0x-prefixed private key of the paying wallet

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";

const API_BASE = process.env.AIJOBSBOOM_API_BASE || "https://x402-api.aijobsboom.com";
const PRIVATE_KEY = process.env.X402_CLIENT_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error(
    "Missing X402_CLIENT_PRIVATE_KEY -- this MCP server needs a Base wallet " +
    "funded with USDC to pay for gated /snapshot and /series calls.",
  );
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({ account, chain: base, transport: http() });
const payFetch = wrapFetchWithPayment(fetch, walletClient);

const server = new McpServer({ name: "aijobsboom-x402", version: "1.0.0" });

server.registerTool(
  "get_snapshot",
  {
    title: "Get latest AIJOBSBOOM snapshot",
    description:
      "Returns the latest pipeline-run rollup from the AIJOBSBOOM skilled-trades " +
      "job board: total rows in/out, scrub-rule removal counts, per-trade counts " +
      "(electrician, HVAC, lineman, welder, mechanic, CDL), and perk-flag counts " +
      "(fair-chance, will-train, per diem, day-1 benefits, sign-on bonus, travel " +
      "paid, employer-posted six-figure, HOT count, North Dakota, Montana). " +
      "Derived statistics only -- no job titles, employers, or URLs. " +
      "Costs $0.01 USDC on Base, paid automatically via x402.",
    inputSchema: {},
  },
  async () => {
    const res = await payFetch(`${API_BASE}/snapshot`);
    if (!res.ok) throw new Error(`snapshot request failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.registerTool(
  "get_series",
  {
    title: "Get AIJOBSBOOM historical series",
    description:
      "Returns the last N pipeline-run rollups from the AIJOBSBOOM skilled-trades " +
      "job board as a chronological (oldest-to-newest) array, same fields as " +
      "get_snapshot. Use this for trend/week-over-week analysis. " +
      "Costs $0.10 USDC on Base, paid automatically via x402.",
    inputSchema: {
      weeks: z.number().int().positive().max(52).default(8)
        .describe("Number of most recent pipeline-run rows to return"),
    },
  },
  async ({ weeks }) => {
    const res = await payFetch(`${API_BASE}/series?weeks=${weeks}`);
    if (!res.ok) throw new Error(`series request failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
