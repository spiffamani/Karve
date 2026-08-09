import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { estimateDeterministic } from "./deterministic.js";
import { estimateCrossMarket } from "./crossmarket.js";
import { estimateFavorite } from "./favorite.js";
import { estimateLlm } from "./llm.js";

/**
 * Run estimators in priority order and return the first hit:
 *   1. deterministic — mechanical truth (spot price + volatility), best edge
 *   2. crossmarket   — real-money markets pricing the same question
 *   3. favorite      — calibration bias near resolution
 *   4. llm           — opinion of a well-prompted model, weakest, widest edge bar
 */
export async function estimateMarket(market: MarketSnapshot): Promise<ProbabilityEstimate | null> {
  const deterministic = await estimateDeterministic(market);
  if (deterministic) return deterministic;

  const crossMarket = await estimateCrossMarket(market);
  if (crossMarket) return crossMarket;

  const favorite = estimateFavorite(market);
  if (favorite) return favorite;

  return estimateLlm(market);
}
