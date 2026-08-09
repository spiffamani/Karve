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
  minEdge: {
    deterministic: num("KARVE_MIN_EDGE_DETERMINISTIC", 0.05),
    crossmarket: num("KARVE_MIN_EDGE_CROSSMARKET", 0.08),
    favorite: num("KARVE_MIN_EDGE_FAVORITE", 0.04),
    llm: num("KARVE_MIN_EDGE_LLM", 0.15),
  },

  // Favorite-harvesting: only buy outcomes we believe are at least this
  // likely, when the market still prices them below our floor estimate.
  favoriteMinProbability: num("KARVE_FAVORITE_MIN_PROB", 0.9),

  // ── Position sizing ───────────────────────────────────────────────────────
  // Fraction of full Kelly to bet. 1.0 = full Kelly (too violent for noisy
  // edges). 0.35 is aggressive-but-survivable for a tournament.
  kellyFraction: num("KARVE_KELLY_FRACTION", 0.35),
  // Hard caps as fractions of CURRENT total bankroll (cash + position value).
  maxFractionPerMarket: num("KARVE_MAX_PER_MARKET", 0.15),
  maxFractionPerGroup: num("KARVE_MAX_PER_GROUP", 0.25),
  // Never let cash drop below this fraction of bankroll (dry powder for
  // late, better opportunities).
  cashFloorFraction: num("KARVE_CASH_FLOOR", 0.1),
  // Smallest trade worth the gas + journal noise (collateral tokens).
  minTradeTokens: num("KARVE_MIN_TRADE_TOKENS", 1),

  // ── Execution ─────────────────────────────────────────────────────────────
  slippageBps: BigInt(num("KARVE_SLIPPAGE_BPS", 300)),
  // Re-check: if the effective average fill price implies our edge shrinks
  // below this fraction of the original signal edge, abort the trade.
  minEdgeRetainedAfterImpact: num("KARVE_MIN_EDGE_RETAINED", 0.5),

  // ── Scheduling (milliseconds) ─────────────────────────────────────────────
  scanIntervalMs: num("KARVE_SCAN_INTERVAL_MS", 5 * 60_000),
  sweepIntervalMs: num("KARVE_SWEEP_INTERVAL_MS", 15 * 60_000),
  // Markets resolving within this window get re-scanned on every loop.
  hotWindowMs: num("KARVE_HOT_WINDOW_MS", 6 * 3_600_000),

  // ── Safety ────────────────────────────────────────────────────────────────
  dryRun: bool("KARVE_DRY_RUN", true), // trades are logged but NOT sent unless explicitly disabled
  minEthReserve: num("KARVE_MIN_ETH_RESERVE", 0.0005), // alert threshold, in ETH
  maxOpenPositions: num("KARVE_MAX_OPEN_POSITIONS", 25),

  // ── Optional integrations ────────────────────────────────────────────────
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  discordWebhookUrl: process.env.KARVE_DISCORD_WEBHOOK ?? "",
} as const;

export const COLLATERAL_DECIMALS = 6;
export const SHARE_DECIMALS = 18;
