import { estimateDeterministic } from "../src/strategy/deterministic.js";
import { estimateCrossMarket } from "../src/strategy/crossmarket.js";
import type { MarketSnapshot } from "../src/types.js";
import { formatProb } from "../src/util.js";

/**
 * Offline signal sanity check — no Delphi API key needed.
 * Verifies the deterministic pricer and the Polymarket matcher work against
 * live public data. Usage: npx tsx scripts/test-signals.ts
 */

function syntheticMarket(question: string, outcomes: string[], daysToResolve: number): MarketSnapshot {
  return {
    address: "0x0000000000000000000000000000000000000000",
    question,
    category: "test",
    outcomes,
    status: "open",
    impliedProbs: outcomes.map(() => 1 / outcomes.length),
    resolvesAt: new Date(Date.now() + daysToResolve * 86_400_000),
    settlesAt: null,
    metadata: null,
    dataSources: null,
    marketUrl: "",
  };
}

// ── 1. Deterministic pricer against live Binance data ─────────────────────────
const spotRes = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
const spot = Number(((await spotRes.json()) as { price: string }).price);
console.log(`live BTC spot: $${spot.toFixed(0)}\n`);

const nearThreshold = Math.round((spot * 1.05) / 1000) * 1000;
const binary = syntheticMarket(
  `Will Bitcoin be above $${nearThreshold.toLocaleString("en-US")} on ${new Date(Date.now() + 7 * 86_400_000).toDateString()}?`,
  ["Yes", "No"],
  7,
);
console.log(`Q: ${binary.question}`);
const detEstimate = await estimateDeterministic(binary);
console.log(detEstimate
  ? `   → ${detEstimate.probs.map(formatProb).join(" / ")}   (${detEstimate.reasoning})`
  : "   → deterministic module returned null (BUG)");

const lo = Math.round((spot * 0.97) / 1000) * 1000;
const hi = Math.round((spot * 1.03) / 1000) * 1000;
const buckets = syntheticMarket(
  `What will the Bitcoin price be on ${new Date(Date.now() + 5 * 86_400_000).toDateString()}?`,
  [`Below $${lo.toLocaleString("en-US")}`, `$${lo.toLocaleString("en-US")} - $${hi.toLocaleString("en-US")}`, `Above $${hi.toLocaleString("en-US")}`],
  5,
);
console.log(`\nQ: ${buckets.question}`);
console.log(`   outcomes: ${buckets.outcomes.join(" | ")}`);
const bucketEstimate = await estimateDeterministic(buckets);
console.log(bucketEstimate
  ? `   → ${bucketEstimate.probs.map(formatProb).join(" / ")}   (${bucketEstimate.reasoning})`
  : "   → deterministic module returned null (BUG)");

// ── 2. Polymarket matcher against live Gamma data ─────────────────────────────
console.log("\n── crossmarket: fetching live Polymarket data...");
const gammaRes = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&order=volume24hr&ascending=false");
const top = (await gammaRes.json()) as Array<{ question: string; outcomes: string; outcomePrices: string; volume24hr?: number }>;
console.log("top live Polymarket markets by 24h volume:");
for (const m of top) {
  console.log(`   "${m.question}" → ${JSON.parse(m.outcomes).join("/")} @ ${(JSON.parse(m.outcomePrices) as string[]).map((p) => (Number(p) * 100).toFixed(0) + "%").join("/")}`);
}

// A Delphi market asking the same question as Polymarket's biggest market must match.
const mirror = syntheticMarket(top[0]!.question, JSON.parse(top[0]!.outcomes) as string[], 30);
mirror.resolvesAt = null; // skip date-proximity check for the synthetic mirror
console.log(`\nQ (mirror of top poly market): ${mirror.question}`);
const xEstimate = await estimateCrossMarket(mirror);
console.log(xEstimate
  ? `   → matched! ${xEstimate.probs.map(formatProb).join(" / ")}   conf=${xEstimate.confidence.toFixed(2)}\n   (${xEstimate.reasoning})`
  : "   → no match (check matcher thresholds)");
