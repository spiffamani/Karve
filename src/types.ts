export type Address = `0x${string}`;

export type MarketStatus = "open" | "awaiting_settlement" | "settled" | "expired" | "failed";

/** Normalized view of a Delphi market, flattened from REST + metadata. */
export interface MarketSnapshot {
  address: Address;
  question: string;
  category: string;
  outcomes: string[];
  status: MarketStatus;
  /** Implied probability per outcome, 0..1, aligned with `outcomes`. */
  impliedProbs: number[];
  resolvesAt: Date | null;
  settlesAt: Date | null;
  /** Raw metadata for estimators that need description/resolution criteria. */
  metadata: Record<string, unknown> | null;
  dataSources: unknown;
  marketUrl: string;
}

export type SignalSource = "deterministic" | "crossmarket" | "facts" | "favorite" | "llm";

/** A strategy module's opinion about one market. */
export interface ProbabilityEstimate {
  source: SignalSource;
  /** Our probability per outcome, 0..1, aligned with market outcomes. Sums to ~1. */
  probs: number[];
  /** 0..1 — how much the sizing layer should trust this estimate. */
  confidence: number;
  /** Human-readable justification, persisted to the journal. */
  reasoning: string;
  /** Correlation group key, e.g. "BTC-price" — positions in the same group share a cap. */
  correlationGroup?: string;
}

export interface TradeIntent {
  market: MarketSnapshot;
  estimate: ProbabilityEstimate;
  outcomeIdx: number;
  /** Edge vs spot implied probability at signal time (0..1). */
  signalEdge: number;
  /** Collateral tokens the risk layer approved for spending. */
  budgetTokens: number;
}

export interface TradeResult {
  intent: TradeIntent;
  executed: boolean;
  dryRun: boolean;
  reason: string;
  sharesOut?: bigint;
  tokensIn?: bigint;
  effectiveAvgPrice?: number;
  transactionHash?: string;
}
