import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { journal, loadState, saveState } from "../journal.js";
import { clamp, withRetry } from "../util.js";

/**
 * Cross-market signal: compare Delphi's implied probability with Polymarket's
 * real-money price for the same real-world question. Polymarket is priced by
 * professionals risking real capital; the competition testnet is priced by
 * amateur bots with play money. When they disagree, trust the real money.
 */

interface PolyMarket {
  id: string;
  question: string;
  outcomes: string[];
  outcomePrices: number[];
  endDate: Date | null;
  volume24h: number;
}

let polyCache: { markets: PolyMarket[]; fetchedAt: number } | null = null;
const POLY_CACHE_TTL_MS = 10 * 60_000;
const AUTO_MATCH_SCORE = 0.65;
const REVIEW_MATCH_SCORE = 0.4;

function parsePolyRow(row: Record<string, unknown>): PolyMarket | null {
  try {
    const outcomes = JSON.parse(String(row.outcomes ?? "[]")) as string[];
    const prices = (JSON.parse(String(row.outcomePrices ?? "[]")) as string[]).map(Number);
    if (outcomes.length < 2 || prices.length !== outcomes.length) return null;
    if (!prices.every((p) => Number.isFinite(p) && p >= 0 && p <= 1)) return null;
    return {
      id: String(row.id ?? row.conditionId ?? ""),
      question: String(row.question ?? ""),
      outcomes,
      outcomePrices: prices,
      endDate: row.endDate ? new Date(String(row.endDate)) : null,
      volume24h: Number(row.volume24hr ?? row.volumeNum ?? 0),
    };
  } catch {
    return null;
  }
}

async function fetchPolymarkets(): Promise<PolyMarket[]> {
  if (polyCache && Date.now() - polyCache.fetchedAt < POLY_CACHE_TTL_MS) return polyCache.markets;

  const collected: PolyMarket[] = [];
  for (let page = 0; page < 5; page++) {
    const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=200&offset=${page * 200}&order=volume24hr&ascending=false`;
    const rows = await withRetry("polymarket gamma", async () => {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`gamma http ${res.status}`);
      return (await res.json()) as Array<Record<string, unknown>>;
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const row of rows) {
      const parsed = parsePolyRow(row);
      if (parsed) collected.push(parsed);
    }
  }
  polyCache = { markets: collected, fetchedAt: Date.now() };
  return collected;
}

/** Delphi markets sometimes publish the exact Polymarket URL in dataSources — the authoritative match. */
function extractPolymarketSlug(dataSources: unknown): string | null {
  const list = Array.isArray(dataSources) ? dataSources : [];
  for (const s of list) {
    if (typeof s !== "string") continue;
    const m = s.match(/polymarket\.com\/(?:market|event)\/([a-z0-9-]+)/i);
    if (m) return m[1]!;
  }
  return null;
}

async function fetchPolymarketBySlug(slug: string): Promise<PolyMarket[]> {
  const candidates: PolyMarket[] = [];
  const marketRows = await withRetry("gamma by market slug", async () => {
    const res = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`gamma http ${res.status}`);
    return (await res.json()) as Array<Record<string, unknown>>;
  }).catch(() => []);
  for (const row of marketRows) {
    const parsed = parsePolyRow(row);
    if (parsed) candidates.push(parsed);
  }
  if (candidates.length > 0) return candidates;

  // The slug may name an event holding several markets (e.g. one per bucket).
  const eventRows = await withRetry("gamma by event slug", async () => {
    const res = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`gamma http ${res.status}`);
    return (await res.json()) as Array<{ markets?: Array<Record<string, unknown>> }>;
  }).catch(() => []);
  for (const event of eventRows) {
    for (const row of event.markets ?? []) {
      const parsed = parsePolyRow(row);
      if (parsed) candidates.push(parsed);
    }
  }
  return candidates;
}

const STOPWORDS = new Set([
  "will", "the", "a", "an", "of", "in", "on", "at", "by", "be", "to", "is", "are",
  "before", "after", "than", "and", "or", "for", "with", "this", "that", "it",
  "do", "does", "did", "any", "have", "has", "what", "which", "who", "when",
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9$%. ]/g, " ").split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function extractNumbers(text: string): number[] {
  return [...text.matchAll(/([\d][\d,]*(?:\.\d+)?)\s*([kKmM])?/g)].map((m) => {
    let v = Number(m[1]!.replace(/,/g, ""));
    if (m[2]?.toLowerCase() === "k") v *= 1_000;
    if (m[2]?.toLowerCase() === "m") v *= 1_000_000;
    return v;
  });
}

function matchScore(delphiQuestion: string, poly: PolyMarket, delphiResolvesAt: Date | null): number {
  const a = tokenize(delphiQuestion);
  const b = tokenize(poly.question);
  let overlap = 0;
  for (const t of a) if (b.has(t)) overlap++;
  const jaccard = overlap / new Set([...a, ...b]).size;
  const coverage = overlap / a.size; // how much of the Delphi question the candidate covers

  // Numbers must agree — a $120k question must not match a $150k market.
  const numsA = extractNumbers(delphiQuestion);
  const numsB = extractNumbers(poly.question);
  const numbersAgree = numsA.every((n) => numsB.some((m) => Math.abs(m - n) / Math.max(n, 1) < 0.001));
  if (!numbersAgree) return 0;

  // Resolution dates should be close if both are known (7-day tolerance).
  if (delphiResolvesAt && poly.endDate) {
    const daysApart = Math.abs(delphiResolvesAt.getTime() - poly.endDate.getTime()) / 86_400_000;
    if (daysApart > 7) return 0;
  }

  return 0.5 * coverage + 0.5 * jaccard;
}

/** Map each Delphi outcome label onto a Polymarket outcome index (or fail). */
function mapOutcomes(delphiOutcomes: string[], polyOutcomes: string[]): number[] | null {
  const mapping: number[] = [];
  for (const label of delphiOutcomes) {
    const norm = label.trim().toLowerCase();
    let idx = polyOutcomes.findIndex((p) => p.trim().toLowerCase() === norm);
    if (idx === -1 && (norm === "yes" || norm === "no")) {
      idx = polyOutcomes.findIndex((p) => p.trim().toLowerCase() === norm);
    }
    if (idx === -1) {
      // Fall back to token overlap for non-binary labels.
      let best = -1, bestScore = 0;
      const tokensA = tokenize(label);
      polyOutcomes.forEach((p, i) => {
        const tokensB = tokenize(p);
        let overlap = 0;
        for (const t of tokensA) if (tokensB.has(t)) overlap++;
        const score = tokensA.size ? overlap / tokensA.size : 0;
        if (score > bestScore) { bestScore = score; best = i; }
      });
      if (bestScore >= 0.6) idx = best;
    }
    if (idx === -1) return null;
    mapping.push(idx);
  }
  return new Set(mapping).size === mapping.length ? mapping : null;
}

interface MatchRecord {
  polyId: string;
  polyQuestion: string;
  score: number;
  approved: boolean; // humans can flip this in data/matches.json for borderline cases
}

export async function estimateCrossMarket(market: MarketSnapshot): Promise<ProbabilityEstimate | null> {
  // Priority path: the Delphi market links its own Polymarket reference.
  const slug = extractPolymarketSlug(market.dataSources);
  if (slug) {
    const candidates = await fetchPolymarketBySlug(slug);
    let direct: PolyMarket | null = null;
    if (candidates.length === 1) {
      direct = candidates[0]!;
    } else if (candidates.length > 1) {
      let bestScore = 0;
      for (const c of candidates) {
        const score = matchScore(market.question, c, null);
        if (score > bestScore) { bestScore = score; direct = c; }
      }
    }
    if (direct) {
      const mapping = mapOutcomes(market.outcomes, direct.outcomes);
      if (mapping) {
        const rawProbs = mapping.map((i) => clamp(direct!.outcomePrices[i]!, 0.005, 0.995));
        const total = rawProbs.reduce((a, b) => a + b, 0);
        const probs = rawProbs.map((p) => p / total);
        const peak = Math.max(...probs);
        // Direct Polymarket links are the gold standard — size hard on near-locks.
        const confidence = peak >= 0.95
          ? clamp(0.93 + Math.min(1, direct.volume24h / 50_000) * 0.05, 0.93, 0.98)
          : 0.9;
        return {
          source: "crossmarket",
          probs,
          confidence,
          reasoning: `DIRECT dataSources link → Polymarket "${direct.question}" prices ${direct.outcomePrices.map((p) => (p * 100).toFixed(0) + "%").join("/")} (24h vol $${Math.round(direct.volume24h)})`,
          correlationGroup: `poly:${direct.id}`,
        };
      }
    }
  }

  let polymarkets: PolyMarket[];
  try {
    polymarkets = await fetchPolymarkets();
  } catch (err) {
    journal("error", { where: "fetchPolymarkets", err: String((err as Error).message).slice(0, 200) });
    return null;
  }
  if (polymarkets.length === 0) return null;

  let best: PolyMarket | null = null;
  let bestScore = 0;
  for (const poly of polymarkets) {
    const score = matchScore(market.question, poly, market.resolvesAt);
    if (score > bestScore) { bestScore = score; best = poly; }
  }
  if (!best) return null;

  const matches = loadState<Record<string, MatchRecord>>("matches", {});
  const existing = matches[market.address];

  if (bestScore < AUTO_MATCH_SCORE) {
    if (bestScore >= REVIEW_MATCH_SCORE && !existing) {
      // Queue for human review — you can set approved:true in data/matches.json.
      matches[market.address] = { polyId: best.id, polyQuestion: best.question, score: bestScore, approved: false };
      saveState("matches", matches);
      journal("decision", {
        note: "crossmarket match queued for human review",
        market: market.address, question: market.question,
        candidate: best.question, score: Number(bestScore.toFixed(3)),
      });
    }
    if (!existing?.approved || existing.polyId !== best.id) return null;
  }

  const mapping = mapOutcomes(market.outcomes, best.outcomes);
  if (!mapping) return null;

  const rawProbs = mapping.map((polyIdx) => clamp(best!.outcomePrices[polyIdx]!, 0.005, 0.995));
  const total = rawProbs.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  const probs = rawProbs.map((p) => p / total);
  const peak = Math.max(...probs);
  const baseConf = clamp(0.75 * Math.min(1, best.volume24h / 10_000), 0.35, 0.75);
  // Fuzzy matches only clear the conviction gate when Polymarket itself is a near-lock
  // and volume backs it — otherwise leave them for human-approved matches only.
  const confidence = peak >= 0.95
    ? clamp(Math.max(baseConf, 0.85) + Math.min(1, best.volume24h / 50_000) * 0.1, 0.85, 0.95)
    : baseConf;
  return {
    source: "crossmarket",
    probs,
    confidence,
    reasoning: `Polymarket "${best.question}" (24h vol $${Math.round(best.volume24h)}) prices ${best.outcomePrices.map((p) => (p * 100).toFixed(0) + "%").join("/")}; match score ${bestScore.toFixed(2)}`,
    correlationGroup: `poly:${best.id}`,
  };
}
