import { CONFIG } from "../config.js";
import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { clamp } from "../util.js";

/**
 * Favorite-longshot bias harvesting (high-conviction mode).
 *
 * Amateur prediction markets systematically underprice near-certain outcomes:
 * a market that should trade at 96% often sits at 88-93% because naive agents
 * "buy the cheap side" hoping for a big payoff. Near resolution, buying the
 * favorite at a discount is positive EV — and under the 95% conviction floor
 * we only take the strongest of these, then size them hard.
 */

const CALIBRATION_BUMP = 0.05; // how underpriced favorites tend to be near resolution
const MAX_ESTIMATE = 0.98;     // never claim absolute certainty — oracles can surprise

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
  // Must clear the global 95% conviction floor after the bump, or skip.
  if (boosted < CONFIG.minOutcomeProbability) return null;

  const remaining = 1 - boosted;
  const otherTotal = market.impliedProbs.reduce((a, p, i) => (i === favoriteIdx ? a : a + p), 0);

  const probs = market.impliedProbs.map((p, i) =>
    i === favoriteIdx ? boosted : otherTotal > 0 ? (p / otherTotal) * remaining : remaining / (market.impliedProbs.length - 1),
  );

  // Closer to resolution + higher market favorite → higher trust for sizing.
  const hoursLeft = msLeft / 3_600_000;
  const timeFactor = clamp(1 - hoursLeft / (CONFIG.hotWindowMs / 3_600_000), 0.7, 1);
  const confidence = clamp(0.85 + (boosted - 0.95) * 2 + timeFactor * 0.08, 0.85, 0.97);

  return {
    source: "favorite",
    probs,
    confidence,
    reasoning: `favorite-bias harvest: "${market.outcomes[favoriteIdx]}" priced ${(favoriteProb * 100).toFixed(1)}% with ${hoursLeft.toFixed(1)}h to resolution; calibrated ≈ ${(boosted * 100).toFixed(1)}%`,
    correlationGroup: "favorite-harvest",
  };
}
