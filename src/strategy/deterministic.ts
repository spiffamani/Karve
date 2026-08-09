import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { clamp, withRetry } from "../util.js";

/**
 * Deterministic pricer for crypto price-threshold markets.
 *
 * "Will BTC close above $120,000 on Aug 20?" is not a matter of opinion — it
 * is spot price + time + volatility. We price it with a driftless lognormal
 * model and free public spot/kline data, which beats any LLM guess.
 */

const ASSETS: Record<string, string> = {
  btc: "BTCUSDT", bitcoin: "BTCUSDT",
  eth: "ETHUSDT", ethereum: "ETHUSDT",
  sol: "SOLUSDT", solana: "SOLUSDT",
  xrp: "XRPUSDT", ripple: "XRPUSDT",
  doge: "DOGEUSDT", dogecoin: "DOGEUSDT",
  bnb: "BNBUSDT",
};

interface AssetView {
  spot: number;
  dailyVol: number; // stddev of daily log returns
}

const assetCache = new Map<string, { view: AssetView; fetchedAt: number }>();
const CACHE_TTL_MS = 60_000;

async function fetchAssetView(symbol: string): Promise<AssetView> {
  const cached = assetCache.get(symbol);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.view;

  const view = await withRetry(`binance ${symbol}`, async () => {
    const [tickerRes, klinesRes] = await Promise.all([
      fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`),
      fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=31`),
    ]);
    if (!tickerRes.ok || !klinesRes.ok) throw new Error(`binance http ${tickerRes.status}/${klinesRes.status}`);
    const ticker = (await tickerRes.json()) as { price: string };
    const klines = (await klinesRes.json()) as Array<[number, string, string, string, string]>;
    const closes = klines.map((k) => Number(k[4]));
    const rets: number[] = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    return { spot: Number(ticker.price), dailyVol: Math.sqrt(variance) };
  });

  assetCache.set(symbol, { view, fetchedAt: Date.now() });
  return view;
}

/** Standard normal CDF (Abramowitz–Stegun approximation, error < 7.5e-8). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

/** P(price at horizon > threshold), driftless lognormal. */
function probAboveAtHorizon(spot: number, threshold: number, dailyVol: number, days: number): number {
  if (days <= 0) return spot > threshold ? 1 : 0;
  const sigma = Math.max(dailyVol, 1e-6) * Math.sqrt(days);
  const z = (Math.log(spot / threshold) - (sigma * sigma) / 2) / sigma;
  return normCdf(z);
}

/** P(price touches threshold at any point before horizon) — reflection principle. */
function probTouchBeforeHorizon(spot: number, threshold: number, dailyVol: number, days: number): number {
  const above = threshold > spot;
  const tail = above
    ? probAboveAtHorizon(spot, threshold, dailyVol, days)
    : 1 - probAboveAtHorizon(spot, threshold, dailyVol, days);
  return clamp(2 * tail, 0, 1);
}

function parseThreshold(text: string): number | null {
  // $120,000 | $120k | 120K | 0.50 | 3,500
  const m = text.match(/\$?\s*([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?/);
  if (!m) return null;
  let value = Number(m[1]!.replace(/,/g, ""));
  if (m[2]?.toLowerCase() === "k") value *= 1_000;
  if (m[2]?.toLowerCase() === "m") value *= 1_000_000;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function detectAsset(question: string): string | null {
  const q = question.toLowerCase();
  for (const [name, symbol] of Object.entries(ASSETS)) {
    if (new RegExp(`\\b${name}\\b`, "i").test(q)) return symbol;
  }
  return null;
}

interface OutcomeRange {
  low: number;   // inclusive lower bound (-Infinity allowed)
  high: number;  // exclusive upper bound (Infinity allowed)
}

/** Parse range-style outcome labels: "Below $90k", "$90k–$100k", "Above $100k". */
function parseOutcomeRange(label: string): OutcomeRange | null {
  const text = label.toLowerCase().replace(/[–—]/g, "-");
  const numbers = [...text.matchAll(/\$?\s*([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?/g)]
    .map((m) => {
      let v = Number(m[1]!.replace(/,/g, ""));
      if (m[2]?.toLowerCase() === "k") v *= 1_000;
      if (m[2]?.toLowerCase() === "m") v *= 1_000_000;
      return v;
    })
    .filter((v) => Number.isFinite(v) && v > 0);

  if (/below|under|less than|<|fewer/.test(text) && numbers.length >= 1) {
    return { low: -Infinity, high: numbers[0]! };
  }
  if (/above|over|more than|higher|>|exceed/.test(text) && numbers.length >= 1) {
    return { low: numbers[0]!, high: Infinity };
  }
  if (numbers.length >= 2) {
    const [a, b] = [Math.min(numbers[0]!, numbers[1]!), Math.max(numbers[0]!, numbers[1]!)];
    return { low: a, high: b };
  }
  return null;
}

function isYesLike(label: string): boolean {
  return /^(yes|true|above|over|higher)\b/i.test(label.trim());
}

function isNoLike(label: string): boolean {
  return /^(no|false|below|under|lower)\b/i.test(label.trim());
}

export async function estimateDeterministic(market: MarketSnapshot): Promise<ProbabilityEstimate | null> {
  const symbol = detectAsset(market.question);
  if (!symbol) return null;

  const horizon = market.resolvesAt ?? market.settlesAt;
  if (!horizon) return null;
  const days = (horizon.getTime() - Date.now()) / 86_400_000;
  if (days < -0.5) return null; // already past resolution

  let view: AssetView;
  try {
    view = await fetchAssetView(symbol);
  } catch {
    return null; // feed down — skip rather than guess
  }

  const asset = symbol.replace("USDT", "");

  // Case 1: multi-outcome range buckets ("<$90k", "$90k-$100k", ">$100k").
  const ranges = market.outcomes.map(parseOutcomeRange);
  if (market.outcomes.length >= 3 && ranges.every((r) => r !== null)) {
    const probs = (ranges as OutcomeRange[]).map((r) => {
      const pAboveLow = r.low === -Infinity ? 1 : probAboveAtHorizon(view.spot, r.low, view.dailyVol, days);
      const pAboveHigh = r.high === Infinity ? 0 : probAboveAtHorizon(view.spot, r.high, view.dailyVol, days);
      return clamp(pAboveLow - pAboveHigh, 0.001, 0.999);
    });
    const total = probs.reduce((a, b) => a + b, 0);
    return {
      source: "deterministic",
      probs: probs.map((p) => p / total),
      confidence: clamp(0.9 - days * 0.02, 0.5, 0.9),
      reasoning: `${asset} spot=${view.spot.toFixed(2)}, dailyVol=${(view.dailyVol * 100).toFixed(2)}%, ${days.toFixed(1)}d to resolution; lognormal bucket probabilities`,
      correlationGroup: `crypto:${asset}`,
    };
  }

  // Case 2: binary threshold question.
  const yesIdx = market.outcomes.findIndex(isYesLike);
  const noIdx = market.outcomes.findIndex(isNoLike);
  if (market.outcomes.length !== 2 || yesIdx === -1 || noIdx === -1) return null;

  const threshold = parseThreshold(market.question);
  if (!threshold) return null;
  // Sanity: threshold should be within 20x of spot, else we parsed the wrong number.
  if (threshold < view.spot / 20 || threshold > view.spot * 20) return null;

  const isTouch = /\b(reach|touch|hit|at any (point|time)|before)\b/i.test(market.question);
  const isBelowQuestion = /\b(below|under|less than|fall|drop)\b/i.test(market.question);

  let pYes: number;
  if (isTouch) {
    pYes = probTouchBeforeHorizon(view.spot, threshold, view.dailyVol, days);
    if (isBelowQuestion !== (threshold < view.spot)) {
      // touch target on the other side of spot — probTouch already handles direction via tail choice
    }
  } else {
    const pAbove = probAboveAtHorizon(view.spot, threshold, view.dailyVol, days);
    pYes = isBelowQuestion ? 1 - pAbove : pAbove;
  }
  pYes = clamp(pYes, 0.005, 0.995);

  const probs = market.outcomes.map((_, i) => (i === yesIdx ? pYes : 1 - pYes));
  return {
    source: "deterministic",
    probs,
    confidence: clamp(0.9 - days * 0.02, 0.5, 0.9),
    reasoning: `${asset} spot=${view.spot.toFixed(2)}, threshold=${threshold}, dailyVol=${(view.dailyVol * 100).toFixed(2)}%, ${days.toFixed(1)}d left, ${isTouch ? "touch" : "terminal"} model → P(yes)=${(pYes * 100).toFixed(1)}%`,
    correlationGroup: `crypto:${asset}`,
  };
}
