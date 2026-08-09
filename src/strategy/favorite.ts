import { CONFIG } from "../config.js";
import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { clamp } from "../util.js";

/**
 * Favorite-longshot bias harvesting.
 *
 * Amateur prediction markets systematically underprice near-certain outcomes:
 * a market that should trade at 96% often sits at 85-92% because naive agents
 * "buy the cheap side" hoping for a big payoff. Near resolution, buying the
 * favorite at a discount to its calibrated probability is a small, repeatable,
 * positive-EV bet. Confidence is deliberately low so each position stays small;
 * the aggregate across many markets is where the profit accumulates.
 */

const CALIBRATION_BUMP = 0.06; // how underpriced favorites tend to be near resolution
const MAX_ESTIMATE = 0.975;    // never claim certainty — oracles can surprise

export function estimateFavorite(market: MarketSnapshot): ProbabilityEstimate | null {
  const horizon = market.resolvesAt ?? market.settlesAt;
  if (!horizon) return null;
  const msLeft = horizon.getTime() - Date.now();
  if (msLeft <= 0 || msLeft > CONFIG.hotWindowMs) return null;

  const favoriteIdx = market.impliedProbs.indexOf(Math.max(...market.impliedProbs));
  const favoriteProb = market.impliedProbs[favoriteIdx]!;

  // Only bet on already-strong favorites that still have visible discount.
  if (favoriteProb < CONFIG.favoriteMinProbability - CALIBRATION_BUMP) return null;
  if (favoriteProb >= MAX_ESTIMATE) return null;

  const boosted = clamp(favoriteProb + CALIBRATION_BUMP, 0, MAX_ESTIMATE);
  const remaining = 1 - boosted;
  const otherTotal = market.impliedProbs.reduce((a, p, i) => (i === favoriteIdx ? a : a + p), 0);

  const probs = market.impliedProbs.map((p, i) =>
    i === favoriteIdx ? boosted : otherTotal > 0 ? (p / otherTotal) * remaining : remaining / (market.impliedProbs.length - 1),
  );

  return {
    source: "favorite",
    probs,
    confidence: 0.4,
    reasoning: `favorite-bias harvest: "${market.outcomes[favoriteIdx]}" priced ${(favoriteProb * 100).toFixed(1)}% with ${(msLeft / 3_600_000).toFixed(1)}h to resolution; calibrated ≈ ${(boosted * 100).toFixed(1)}%`,
    correlationGroup: "favorite-harvest",
  };
}
