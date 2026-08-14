import { CONFIG } from "../config.js";
import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { clamp } from "../util.js";

/**
 * Favorite-longshot bias harvesting (aggressive catch-up mode).
 *
 * Amateur prediction markets systematically underprice strong favorites.
 * We buy them while discounted, across a wide pre-resolution window.
 */

const CALIBRATION_BUMP = 0.05;
const MAX_ESTIMATE = 0.98;

export function estimateFavorite(market: MarketSnapshot): ProbabilityEstimate | null {
  const horizon = market.resolvesAt ?? market.settlesAt;
  if (!horizon) return null;
  const msLeft = horizon.getTime() - Date.now();
  if (msLeft <= 0 || msLeft > CONFIG.hotWindowMs) return null;

  const favoriteIdx = market.impliedProbs.indexOf(Math.max(...market.impliedProbs));
  const favoriteProb = market.impliedProbs[favoriteIdx]!;

  if (favoriteProb < CONFIG.favoriteMinProbability - CALIBRATION_BUMP) return null;
  if (favoriteProb >= MAX_ESTIMATE) return null;

  const boosted = clamp(favoriteProb + CALIBRATION_BUMP, 0, MAX_ESTIMATE);
  if (boosted < CONFIG.minOutcomeProbability) return null;

  const remaining = 1 - boosted;
  const otherTotal = market.impliedProbs.reduce((a, p, i) => (i === favoriteIdx ? a : a + p), 0);

  const probs = market.impliedProbs.map((p, i) =>
    i === favoriteIdx ? boosted : otherTotal > 0 ? (p / otherTotal) * remaining : remaining / (market.impliedProbs.length - 1),
  );

  const hoursLeft = msLeft / 3_600_000;
  const timeFactor = clamp(1 - hoursLeft / (CONFIG.hotWindowMs / 3_600_000), 0.55, 1);
  const confidence = clamp(0.55 + (boosted - 0.70) * 1.2 + timeFactor * 0.15, 0.55, 0.92);

  return {
    source: "favorite",
    probs,
    confidence,
    reasoning: `favorite-bias harvest: "${market.outcomes[favoriteIdx]}" priced ${(favoriteProb * 100).toFixed(1)}% with ${hoursLeft.toFixed(1)}h to resolution; calibrated ≈ ${(boosted * 100).toFixed(1)}%`,
    correlationGroup: "favorite-harvest",
  };
}
