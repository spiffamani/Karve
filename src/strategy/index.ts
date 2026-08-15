import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { estimateDeterministic } from "./deterministic.js";
import { estimateCrossMarket } from "./crossmarket.js";
import { estimateFacts } from "./facts.js";
import { estimateLlm } from "./llm.js";

/**
 * Estimators in priority order. Favorite-bias is disabled — it invented a
 * fake +5–8% edge on the market's own price and caused sell→rebuy thrash.
 *   1. deterministic — crypto spot + vol
 *   2. facts         — USGS quakes / river gauges (live numbers, not guesses)
 *   3. crossmarket   — tight Polymarket matches only
 *   4. llm           — already-resolved official sources only
 */
export async function estimateMarket(market: MarketSnapshot): Promise<ProbabilityEstimate | null> {
  const deterministic = await estimateDeterministic(market);
  if (deterministic) return deterministic;

  const facts = await estimateFacts(market);
  if (facts) return facts;

  const crossMarket = await estimateCrossMarket(market);
  if (crossMarket) return crossMarket;

  return estimateLlm(market);
}
