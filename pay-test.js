// Standalone x402 paid-call test against the live OfferSignal Base deployment.
// PRIVATE_KEY must already be set in the environment -- this script never
// prompts for it, logs it, or writes it anywhere.
import { createSigner, wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("PRIVATE_KEY is not set in the environment. Aborting.");
  process.exit(1);
}

const URL = "https://offersignal.io/v1/tools/index";
const MAX_ATOMIC_USDC = 50000n; // $0.05 USDC, 6 decimals -- refuse to pay more than this

const signer = await createSigner("base", PRIVATE_KEY);
const payFetch = wrapFetchWithPayment(fetch, signer, MAX_ATOMIC_USDC);

console.log(`Calling ${URL} ...`);
const res = await payFetch(URL);
console.log("HTTP status:", res.status);

const paymentResponseHeader = res.headers.get("x-payment-response");
if (paymentResponseHeader) {
  console.log("Settle result:", JSON.stringify(decodeXPaymentResponse(paymentResponseHeader), null, 2));
} else {
  console.log("Settle result: (no X-PAYMENT-RESPONSE header on the response)");
}

const data = await res.json();
console.log("Response JSON:", JSON.stringify(data, null, 2));
