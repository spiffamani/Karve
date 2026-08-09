import { COLLATERAL_DECIMALS, SHARE_DECIMALS } from "./config.js";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const nowIso = () => new Date().toISOString();

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Collateral bigint (6 decimals) → human number. */
export function tokensToNumber(raw: bigint): number {
  return Number(raw) / 10 ** COLLATERAL_DECIMALS;
}

/** Human collateral amount → bigint (6 decimals). */
export function numberToTokens(amount: number): bigint {
  return BigInt(Math.round(amount * 10 ** COLLATERAL_DECIMALS));
}

/** Share bigint (18 decimals) → human number. */
export function sharesToNumber(raw: bigint): number {
  return Number(raw) / 10 ** SHARE_DECIMALS;
}

/** Human share amount → bigint (18 decimals). */
export function numberToShares(amount: number): bigint {
  // Avoid float overflow on big share counts: split integer and fraction.
  const whole = Math.trunc(amount);
  const frac = amount - whole;
  return BigInt(whole) * 10n ** BigInt(SHARE_DECIMALS) + BigInt(Math.round(frac * 1e18));
}

const TRANSIENT_ERROR_HINTS = [
  "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN",
  "fetch failed", "socket hang up", "timeout", "429", "502", "503", "504",
  "network", "Recv failure",
];

function isTransient(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return TRANSIENT_ERROR_HINTS.some((hint) => msg.toLowerCase().includes(hint.toLowerCase()));
}

/**
 * Retry with exponential backoff + jitter. Only retries errors that look like
 * network flakiness — contract reverts (MarketNotOpen etc.) fail immediately.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; retryAll?: boolean } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 1_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retriable = opts.retryAll || isTransient(err);
      if (!retriable || i === attempts - 1) break;
      const delay = base * 2 ** i * (0.5 + Math.random());
      console.warn(`[retry] ${label} failed (${String((err as Error)?.message ?? err).slice(0, 200)}); retrying in ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function formatProb(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}
