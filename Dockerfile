# aijobsboom-x402 MCP server (stdio transport), for Glama / container hosts.
# Runs mcp-server.js, which pays for each gated call from its own Solana
# wallet via x402-fetch. Requires at runtime:
#   X402_CLIENT_PRIVATE_KEY   base58 secret key of a USDC-funded Solana wallet
#   AIJOBSBOOM_API_BASE       (optional) Worker base URL
# Never bake either into the image -- pass them as container env vars.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY mcp-server.js ./

ENV NODE_ENV=production
ENTRYPOINT ["node", "mcp-server.js"]
