import "dotenv/config";

/**
 * All tunables in one place so strategy changes during the live window are
 * one-line edits, not code surgery.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Env var ${name}="${raw}" is not a number`);
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

export const CONFIG = {
  // ── Identity / network ────────────────────────────────────────────────────
  network: process.env.DELPHI_NETWORK ?? "competition-testnet",

  // ── Decision thresholds (absolute probability edge, 0..1) ────────────────
  // Edge = ourProbability - marketImpliedProbability, evaluated against the
  // EFFECTIVE fill price from a real quote (includes LMSR impact + fees).
  // MAX-AGGRESSION catch-up: take more edges, size them hard.
  minEdge: {
    deterministic: num("KARVE_MIN_EDGE_DETERMINISTIC", 0.02),
    crossmarket: num("KARVE_MIN_EDGE_CROSSMARKET", 0.03),
    favorite: num("KARVE_MIN_EDGE_FAVORITE", 0.02),
    llm: num("KARVE_MIN_EDGE_LLM", 0.05),
  },

  // Conviction floor on OUR probability for the chosen outcome.
  // 0.70 = hunt real edges without waiting for near-locks only.
  minOutcomeProbability: num("KARVE_MIN_OUTCOME_PROB", 0.70),
  // Estimator trust floor before we size.
  minConfidence: num("KARVE_MIN_CONFIDENCE", 0.55),

  // Favorite-harvesting: buy strong favorites while still discounted.
  favoriteMinProbability: num("KARVE_FAVORITE_MIN_PROB", 0.78),

  // ── Position sizing (tournament catch-up) ─────────────────────────────────
  // 0.75 of Kelly — violent but necessary when chasing top 3 with days left.
  kellyFraction: num("KARVE_KELLY_FRACTION", 0.75),
  // Extra size multiplier when edge is fat (applied as 1 + edgeBoost * edge).
  edgeSizeBoost: num("KARVE_EDGE_SIZE_BOOST", 1.5),
  // Hard caps as fractions of CURRENT total bankroll (cash + position value).
  maxFractionPerMarket: num("KARVE_MAX_PER_MARKET", 0.40),
  maxFractionPerGroup: num("KARVE_MAX_PER_GROUP", 0.60),
  // Keep almost no idle cash — redeploy.
  cashFloorFraction: num("KARVE_CASH_FLOOR", 0.01),
  // Smallest trade worth the gas + journal noise (collateral tokens).
  minTradeTokens: num("KARVE_MIN_TRADE_TOKENS", 1),

  // ── Rotation (sell weak positions to free cash) ───────────────────────────
  // If liquid cash falls below this fraction of bankroll, try selling losers.
  rotateCashTriggerFraction: num("KARVE_ROTATE_CASH_TRIGGER", 0.08),
  // Sell a held outcome when our edge on it is at or below this (can be negative).
  rotateSellEdge: num("KARVE_ROTATE_SELL_EDGE", -0.02),
  // Also sell if ourProb on the held outcome drops below this.
  rotateSellMaxProb: num("KARVE_ROTATE_SELL_MAX_PROB", 0.45),

  // ── Execution ─────────────────────────────────────────────────────────────
  slippageBps: BigInt(num("KARVE_SLIPPAGE_BPS", 400)),
  // Re-check: if the effective average fill price implies our edge shrinks
  // below this fraction of the original signal edge, abort the trade.
  minEdgeRetainedAfterImpact: num("KARVE_MIN_EDGE_RETAINED", 0.4),

  // ── Scheduling (milliseconds) ─────────────────────────────────────────────
  scanIntervalMs: num("KARVE_SCAN_INTERVAL_MS", 90_000),
  sweepIntervalMs: num("KARVE_SWEEP_INTERVAL_MS", 8 * 60_000),
  // Favorite harvest window.
  hotWindowMs: num("KARVE_HOT_WINDOW_MS", 48 * 3_600_000),

  // ── Safety ────────────────────────────────────────────────────────────────
  dryRun: bool("KARVE_DRY_RUN", true), // trades are logged but NOT sent unless explicitly disabled
  minEthReserve: num("KARVE_MIN_ETH_RESERVE", 0.0005), // alert threshold, in ETH
  maxOpenPositions: num("KARVE_MAX_OPEN_POSITIONS", 50),

  // ── Optional integrations ────────────────────────────────────────────────
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  discordWebhookUrl: process.env.KARVE_DISCORD_WEBHOOK ?? "",
} as const;

export const COLLATERAL_DECIMALS = 6;
export const SHARE_DECIMALS = 18;
