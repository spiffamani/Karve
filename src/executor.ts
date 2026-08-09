import { CONFIG } from "./config.js";
import type { Delphi } from "./delphi.js";
import { journal } from "./journal.js";
import { groupKey, loadPortfolio, savePortfolio } from "./risk.js";
import type { TradeIntent, TradeResult } from "./types.js";
import { numberToTokens, tokensToNumber } from "./util.js";

/**
 * Turns an approved TradeIntent into an on-chain trade (or a dry-run journal
 * entry). Re-validates the edge against the REAL quoted fill price — the LMSR
 * price impact of our own size — before sending anything.
 */
export async function executeIntent(delphi: Delphi, intent: TradeIntent): Promise<TradeResult> {
  const { market, estimate, outcomeIdx, signalEdge, budgetTokens } = intent;

  const sized = await delphi.sizeBuyForBudget(market.address, outcomeIdx, numberToTokens(budgetTokens));
  if (!sized) {
    return { intent, executed: false, dryRun: CONFIG.dryRun, reason: "could not size a valid quote" };
  }

  const q = estimate.probs[outcomeIdx]!;
  const effectiveEdge = q - sized.effectiveAvgPrice;
  const requiredEdge = signalEdge * CONFIG.minEdgeRetainedAfterImpact;
  if (effectiveEdge < requiredEdge) {
    journal("skip", {
      market: market.address, question: market.question,
      reason: `impact ate the edge: effective ${(effectiveEdge * 100).toFixed(1)}% < required ${(requiredEdge * 100).toFixed(1)}%`,
      effectiveAvgPrice: sized.effectiveAvgPrice,
    });
    return { intent, executed: false, dryRun: CONFIG.dryRun, reason: "edge lost to price impact" };
  }

  const tradeLog = {
    market: market.address,
    question: market.question,
    outcome: market.outcomes[outcomeIdx],
    outcomeIdx,
    source: estimate.source,
    ourProb: q,
    marketProb: market.impliedProbs[outcomeIdx],
    signalEdge,
    effectiveAvgPrice: sized.effectiveAvgPrice,
    budgetTokens,
    tokensIn: tokensToNumber(sized.tokensIn),
    shares: sized.sharesOut,
    reasoning: estimate.reasoning,
  };

  if (CONFIG.dryRun) {
    journal("trade", { ...tradeLog, dryRun: true });
    return {
      intent, executed: false, dryRun: true, reason: "dry-run mode",
      sharesOut: sized.sharesOut, tokensIn: sized.tokensIn, effectiveAvgPrice: sized.effectiveAvgPrice,
    };
  }

  const transactionHash = await delphi.buyShares(market.address, outcomeIdx, sized.sharesOut, sized.tokensIn);
  journal("trade", { ...tradeLog, dryRun: false, transactionHash });

  const portfolio = loadPortfolio();
  portfolio.positions.push({
    market: market.address,
    outcomeIdx,
    costTokens: tokensToNumber(sized.tokensIn),
    shares: sized.sharesOut.toString(),
    group: groupKey(market, estimate),
    source: estimate.source,
    openedAt: new Date().toISOString(),
  });
  savePortfolio(portfolio);

  return {
    intent, executed: true, dryRun: false, reason: "filled",
    sharesOut: sized.sharesOut, tokensIn: sized.tokensIn,
    effectiveAvgPrice: sized.effectiveAvgPrice, transactionHash,
  };
}
