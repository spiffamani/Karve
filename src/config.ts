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

  // ── Decision thresholds ───────────────────────────────────────────────────
  // WAR MODE: undertrading is killing us (53 trades / 3.6K vol). Take more edges.
  minEdge: {
    deterministic: num("KARVE_MIN_EDGE_DETERMINISTIC", 0.015),
    crossmarket: num("KARVE_MIN_EDGE_CROSSMARKET", 0.02),
    favorite: num("KARVE_MIN_EDGE_FAVORITE", 0.06),
    llm: num("KARVE_MIN_EDGE_LLM", 0.04),
  },

  // Lower floor = more trades. 0.55 still requires a clear favorite outcome.
  minOutcomeProbability: num("KARVE_MIN_OUTCOME_PROB", 0.55),
  minConfidence: num("KARVE_MIN_CONFIDENCE", 0.40),

  favoriteMinProbability: num("KARVE_FAVORITE_MIN_PROB", 0.70),

  // ── Position sizing — nearly full Kelly, fat concentration ────────────────
  kellyFraction: num("KARVE_KELLY_FRACTION", 0.95),
  edgeSizeBoost: num("KARVE_EDGE_SIZE_BOOST", 2.0),
  maxFractionPerMarket: num("KARVE_MAX_PER_MARKET", 0.65),
  maxFractionPerGroup: num("KARVE_MAX_PER_GROUP", 0.85),
  cashFloorFraction: num("KARVE_CASH_FLOOR", 0.0),
  minTradeTokens: num("KARVE_MIN_TRADE_TOKENS", 1),

  // ── Rotation (anti-thrash) ────────────────────────────────────────────────
  // Only free cash when truly starved. Do NOT sell healthy positives just to
  // "concentrate" — that caused sell→buy loops (Jaguars/Mississippi) and ate spread.
  rotateCashTriggerFraction: num("KARVE_ROTATE_CASH_TRIGGER", 0.05),
  // Sell only when edge is gone / tiny (not the synthetic +5% favorite bump).
  rotateSellEdge: num("KARVE_ROTATE_SELL_EDGE", 0.0),
  rotateSellMaxProb: num("KARVE_ROTATE_SELL_MAX_PROB", 0.50),
  // After a sell, refuse rebuy of that market (ms) so we can't wash-trade ourselves.
  sellRebuyCooldownMs: num("KARVE_SELL_REBUY_COOLDOWN_MS", 2 * 60 * 60_000),
  // Max positions to dump per scan when cash-starved (worst edges first).
  maxSellsPerScan: num("KARVE_MAX_SELLS_PER_SCAN", 1),

  // ── Execution ─────────────────────────────────────────────────────────────
  slippageBps: BigInt(num("KARVE_SLIPPAGE_BPS", 500)),
  minEdgeRetainedAfterImpact: num("KARVE_MIN_EDGE_RETAINED", 0.35),

  // ── Scheduling ────────────────────────────────────────────────────────────
  scanIntervalMs: num("KARVE_SCAN_INTERVAL_MS", 45_000),
  sweepIntervalMs: num("KARVE_SWEEP_INTERVAL_MS", 5 * 60_000),
  hotWindowMs: num("KARVE_HOT_WINDOW_MS", 72 * 3_600_000),

  // ── Safety ────────────────────────────────────────────────────────────────
  dryRun: bool("KARVE_DRY_RUN", true),
  minEthReserve: num("KARVE_MIN_ETH_RESERVE", 0.0005),
  maxOpenPositions: num("KARVE_MAX_OPEN_POSITIONS", 60),

  // ── Optional integrations ────────────────────────────────────────────────
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  discordWebhookUrl: process.env.KARVE_DISCORD_WEBHOOK ?? "",
} as const;

export const COLLATERAL_DECIMALS = 6;
export const SHARE_DECIMALS = 18;
