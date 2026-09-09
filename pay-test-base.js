// Standalone x402 paid-call test against the live aijobsboom-x402 Worker,
// paying on BASE via the CDP facilitator (the v1.1.0 rail). PRIVATE_KEY must
// already be set in the environment -- the same 0x-prefixed EVM test-buyer
// key offersignal-api/pay-test.js uses. This script never prompts for it,
// logs it, or writes it anywhere.
//
// Usage:
//   node pay-test-base.js                       # /snapshot, cap $0.01
//   node pay-test-base.js /series?weeks=4 0.10  # /series, cap $0.10
//
// A Base payment settled through the CDP facilitator is what gets a route
// indexed in the x402 Bazaar; Solana/PayAI payments never touch the Bazaar.
//
// This Worker is gated with x402-hono@1.x (x402 protocol v1), so the matching
// legacy x402-fetch v1 client is the correct one here.
import { createSigner, wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY is not set in the environment. Aborting.");
  process.exit(1);
}

const BASE_URL = (process.env.AIJOBSBOOM_API_BASE || "https://aijobsboom-x402.sonofgus.workers.dev").replace(/\/+$/, "");
const ROUTE = process.argv[2] || "/snapshot";
const MAX_USD = Number(process.argv[3] || "0.01");
if (!Number.isFinite(MAX_USD) || MAX_USD <= 0) {
  console.error(`Bad max-USD cap: ${process.argv[3]}`);
  process.exit(1);
}
const URL = `${BASE_URL}${ROUTE}`;
const MAX_ATOMIC_USDC = BigInt(Math.round(MAX_USD * 1e6)); // USDC, 6 decimals

// Wraps the real fetch so we can PROVE whether the payment retry fires (an
// outgoing X-PAYMENT header). Logs presence/absence only -- never the value.
let requestCount = 0;
async function instrumentedFetch(input, init) {
  requestCount += 1;
  const hasPayment = Boolean(init && init.headers && init.headers["X-PAYMENT"]);
  console.log(`  [request ${requestCount}] ${typeof input === "string" ? input : input.url} (X-PAYMENT header: ${hasPayment ? "present" : "absent"})`);
  const res = await fetch(input, init);
  console.log(`  [request ${requestCount}] -> HTTP ${res.status}`);
  return res;
}

async function main() {
  // x402-fetch's selector picks the `accepts` entry whose network matches the
  // signer -- an EVM signer on Base matches "base", so the merged
  // Solana+Base 402 from the dispatcher resolves to the Base rail here.
  const signer = await createSigner("base", PRIVATE_KEY);
  const payFetch = wrapFetchWithPayment(instrumentedFetch, signer, MAX_ATOMIC_USDC);

  console.log(`Calling ${URL} (network: base, cap: $${MAX_USD}) ...`);
  const res = await payFetch(URL);
  const body = await res.json();

  if (res.status === 402) {
    console.error("\nPAYMENT DID NOT ATTACH");
    if (requestCount < 2) {
      console.error("Reason: the wrapper never retried with a payment -- only the initial");
      console.error("unpaid request was sent. Check the 402 below actually lists a `base` entry.");
    } else {
      console.error("Reason: a second request WAS sent with an X-PAYMENT header, but the server");
      console.error("still answered 402 -- the facilitator or Worker rejected the payment (bad");
      console.error("signature, insufficient USDC, expired auth, network/asset mismatch, etc).");
    }
    console.error("\nServer's final 402 body:");
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`\nPAYMENT DID NOT ATTACH (unexpected HTTP ${res.status})`);
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }
  const paymentResponseHeader = res.headers.get("x-payment-response");
  if (!paymentResponseHeader) {
    console.error("\nPAYMENT DID NOT ATTACH");
    console.error("Reason: response was 200 but carried no X-PAYMENT-RESPONSE header.");
    process.exit(1);
  }
  console.log("\nPAID -- settle result:");
  console.log(JSON.stringify(decodeXPaymentResponse(paymentResponseHeader), null, 2));
  if (Array.isArray(body)) console.log(`\nrows returned: ${body.length} (${body[0]?.date} -> ${body[body.length - 1]?.date})`);
  else if (body.date) console.log(`\nsnapshot row date: ${body.date}, board_rows: ${body.rows_final}`);
  console.log("\nResponse JSON:");
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error("\nPAYMENT DID NOT ATTACH");
  console.error("Reason:", err.message);
  process.exit(1);
});
