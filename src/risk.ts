import { CONFIG } from "./config.js";
import type { MarketSnapshot, ProbabilityEstimate, TradeIntent } from "./types.js";
import { loadState, saveState } from "./journal.js";

/**
 * Position sizing and portfolio limits.
 *
 * Sizing: fractional Kelly for a binary share paying 1 token, bought at
 * price p with our probability q:  f* = (q - p) / (1 - p), scaled by
 * CONFIG.kellyFraction and the estimator's confidence, then clipped by
 * per-market caps, correlation-group caps, the cash floor, and position count.
 */

export interface OpenPositionRecord {
  market: string;
  outcomeIdx: number;
  costTokens: number;
  shares: string; // bigint as string
  group: string;
  source: string;
  openedAt: string;
}

export interface PortfolioState {
  positions: OpenPositionRecord[];
}

export function loadPortfolio(): PortfolioState {
  return loadState<PortfolioState>("portfolio", { positions: [] });
}

export function savePortfolio(state: PortfolioState): void {
  saveState("portfolio", state);
}

export function groupKey(market: MarketSnapshot, estimate: ProbabilityEstimate): string {
  return estimate.correlationGroup ?? `market:${market.address}`;
}

export interface SizingContext {
  cashTokens: number;
  portfolio: PortfolioState;
}

export type SizingResult =
  | { action: "trade"; intent: TradeIntent }
  | { action: "skip"; reason: string; market: string; edge?: number };

export function decideTrade(
  market: MarketSnapshot,
  estimate: ProbabilityEstimate,
  ctx: SizingContext,
): SizingResult {
  // Pick the outcome with the largest positive edge.
  let bestIdx = -1;
  let bestEdge = 0;
  for (let i = 0; i < market.outcomes.length; i++) {
    const edge = estimate.probs[i]! - market.impliedProbs[i]!;
    if (edge > bestEdge) { bestEdge = edge; bestIdx = i; }
  }
  if (bestIdx === -1) return { action: "skip", reason: "no positive edge", market: market.address };

  const minEdge = CONFIG.minEdge[estimate.source];
  if (bestEdge < minEdge) {
    return { action: "skip", reason: `edge ${(bestEdge * 100).toFixed(1)}% < min ${(minEdge * 100).toFixed(1)}% (${estimate.source})`, market: market.address, edge: bestEdge };
  }

  const q = estimate.probs[bestIdx]!;
  const p = market.impliedProbs[bestIdx]!;
  if (p >= 0.995) return { action: "skip", reason: "price already at ceiling", market: market.address };

  const positionCost = (posList: OpenPositionRecord[]) => posList.reduce((a, x) => a + x.costTokens, 0);
  const openCost = positionCost(ctx.portfolio.positions);
  const bankroll = ctx.cashTokens + openCost;

  if (ctx.portfolio.positions.length >= CONFIG.maxOpenPositions) {
    return { action: "skip", reason: `max open positions (${CONFIG.maxOpenPositions})`, market: market.address };
  }

  const kellyStar = (q - p) / (1 - p);
  let fraction = kellyStar * CONFIG.kellyFraction * estimate.confidence;
  if (fraction <= 0) return { action: "skip", reason: "non-positive Kelly fraction", market: market.address };

  let budget = fraction * bankroll;

  // Per-market cap (existing exposure counts).
  const marketExposure = positionCost(ctx.portfolio.positions.filter((x) => x.market === market.address));
  budget = Math.min(budget, CONFIG.maxFractionPerMarket * bankroll - marketExposure);

  // Correlation-group cap.
  const group = groupKey(market, estimate);
  const groupExposure = positionCost(ctx.portfolio.positions.filter((x) => x.group === group));
  budget = Math.min(budget, CONFIG.maxFractionPerGroup * bankroll - groupExposure);

  // Cash floor.
  budget = Math.min(budget, ctx.cashTokens - CONFIG.cashFloorFraction * bankroll);

  if (budget < CONFIG.minTradeTokens) {
    return { action: "skip", reason: `budget ${budget.toFixed(2)} below minimum after caps`, market: market.address, edge: bestEdge };
  }

  return {
    action: "trade",
    intent: {
      market,
      estimate,
      outcomeIdx: bestIdx,
      signalEdge: bestEdge,
      budgetTokens: Math.floor(budget * 100) / 100,
    },
  };
}
