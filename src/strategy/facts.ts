import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { journal } from "../journal.js";
import { clamp, withRetry } from "../util.js";

/**
 * Live official sensors — not forecasts.
 * USGS earthquakes and USGS river discharge. If the window hasn't started
 * or the number isn't decided yet, we skip rather than guess.
 */

function isYesLike(label: string): boolean {
  return /^(yes|true)\b/i.test(label.trim());
}
function isNoLike(label: string): boolean {
  return /^(no|false)\b/i.test(label.trim());
}

function binaryProbs(market: MarketSnapshot, pYes: number): number[] | null {
  const yesIdx = market.outcomes.findIndex(isYesLike);
  const noIdx = market.outcomes.findIndex(isNoLike);
  if (market.outcomes.length !== 2 || yesIdx === -1 || noIdx === -1) return null;
  const p = clamp(pYes, 0.02, 0.98);
  return market.outcomes.map((_, i) => (i === yesIdx ? p : 1 - p));
}

/** "at least 5 magnitude 4.5+ earthquakes ... from 12:00 to 20:00 UTC on Aug 16, 2026" */
function parseQuakeQuestion(question: string): {
  minMag: number;
  minCount: number;
  start: Date;
  end: Date;
} | null {
  const mag = question.match(/magnitude\s+(\d+(?:\.\d+)?)\s*\+/i);
  const count = question.match(/at least\s+(\d+)/i);
  const window = question.match(
    /from\s+(\d{1,2}:\d{2})\s+to\s+(\d{1,2}:\d{2})\s+UTC\s+on\s+(\w+ \d{1,2}, \d{4})/i,
  );
  if (!mag || !count || !window) return null;
  const day = window[3]!;
  const start = new Date(`${day} ${window[1]!} UTC`);
  const end = new Date(`${day} ${window[2]!} UTC`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { minMag: Number(mag[1]), minCount: Number(count[1]), start, end };
}

async function usgsQuakeCount(minMag: number, start: Date, end: Date): Promise<number> {
  const url =
    `https://earthquake.usgs.gov/fdsnws/event/1/count` +
    `?starttime=${start.toISOString()}&endtime=${end.toISOString()}&minmagnitude=${minMag}`;
  return withRetry("usgs quake count", async () => {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`usgs http ${res.status}`);
    const n = Number(await res.text());
    if (!Number.isFinite(n)) throw new Error("usgs count not a number");
    return n;
  });
}

async function estimateQuake(market: MarketSnapshot): Promise<ProbabilityEstimate | null> {
  const parsed = parseQuakeQuestion(market.question);
  if (!parsed) return null;
  const now = Date.now();
  if (now < parsed.start.getTime()) return null; // window hasn't started — don't forecast

  let count: number;
  try {
    count = await usgsQuakeCount(parsed.minMag, parsed.start, parsed.end);
  } catch (err) {
    journal("error", { where: "estimateFacts.quake", err: String((err as Error).message).slice(0, 200) });
    return null;
  }

  const decided = now >= parsed.end.getTime() || count >= parsed.minCount;
  if (!decided) return null; // still in play — wait, don't invent 97%

  const pYes = count >= parsed.minCount ? 0.97 : 0.03;
  const probs = binaryProbs(market, pYes);
  if (!probs) return null;
  return {
    source: "facts",
    probs,
    confidence: 0.96,
    reasoning: `USGS: ${count} M${parsed.minMag}+ quakes in window (need ${parsed.minCount}); ${now >= parsed.end.getTime() ? "window closed" : "threshold already hit"}`,
    correlationGroup: "usgs:quakes",
  };
}

/** Mississippi Baton Rouge discharge — USGS site 07374000, parameter 00060 (cfs). */
function parseDischargeQuestion(question: string): { threshold: number; at: Date | null } | null {
  if (!/mississippi river discharge/i.test(question) || !/baton rouge/i.test(question)) return null;
  const n = question.match(/below\s+([\d,]+)\s*cfs/i);
  if (!n) return null;
  const threshold = Number(n[1]!.replace(/,/g, ""));
  const atMatch = question.match(/at\s+(\d{1,2}:\d{2})\s+UTC\s+on\s+(\w+ \d{1,2}, \d{4})/i);
  const at = atMatch ? new Date(`${atMatch[2]} ${atMatch[1]} UTC`) : null;
  return { threshold, at: at && !Number.isNaN(at.getTime()) ? at : null };
}

async function usgsDischargeCfs(site = "07374000"): Promise<number | null> {
  const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${site}&parameterCd=00060`;
  return withRetry("usgs discharge", async () => {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`usgs nwis http ${res.status}`);
    const data = (await res.json()) as {
      value?: { timeSeries?: Array<{ values?: Array<{ value?: Array<{ value?: string }> }> }> };
    };
    const raw = data.value?.timeSeries?.[0]?.values?.[0]?.value?.[0]?.value;
    const cfs = Number(raw);
    return Number.isFinite(cfs) ? cfs : null;
  });
}

async function estimateDischarge(market: MarketSnapshot): Promise<ProbabilityEstimate | null> {
  const parsed = parseDischargeQuestion(market.question);
  if (!parsed) return null;

  let cfs: number | null;
  try {
    cfs = await usgsDischargeCfs();
  } catch (err) {
    journal("error", { where: "estimateFacts.discharge", err: String((err as Error).message).slice(0, 200) });
    return null;
  }
  if (cfs === null) return null;

  const hoursLeft = parsed.at ? (parsed.at.getTime() - Date.now()) / 3_600_000 : 12;
  // River flow doesn't jump tens of percent in a few hours. Only trade when
  // current reading is far from the line and the snapshot is soon.
  const gap = (cfs - parsed.threshold) / parsed.threshold;
  if (hoursLeft > 36) return null;
  if (Math.abs(gap) < 0.12) return null; // too close to call

  const below = cfs < parsed.threshold;
  const pYes = below ? 0.92 : 0.08; // question is "be below X"
  const probs = binaryProbs(market, pYes);
  if (!probs) return null;
  return {
    source: "facts",
    probs,
    confidence: clamp(0.8 + Math.min(0.15, Math.abs(gap)), 0.8, 0.95),
    reasoning: `USGS 07374000 live discharge ${Math.round(cfs).toLocaleString()} cfs vs ${parsed.threshold.toLocaleString()} (${(gap * 100).toFixed(0)}%, ${hoursLeft.toFixed(1)}h to snapshot)`,
    correlationGroup: "usgs:mississippi",
  };
}

export async function estimateFacts(market: MarketSnapshot): Promise<ProbabilityEstimate | null> {
  return (await estimateQuake(market)) ?? (await estimateDischarge(market));
}
