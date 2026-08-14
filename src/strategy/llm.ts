import { CONFIG } from "../config.js";
import type { MarketSnapshot, ProbabilityEstimate } from "../types.js";
import { journal, loadState, saveState } from "../journal.js";
import { clamp, sleep } from "../util.js";

/**
 * LLM fallback estimator (Gemini with web-search grounding).
 *
 * Last resort for markets no other module covers. Estimates are cached for
 * hours (world state doesn't change every scan) and the risk layer demands a
 * much larger edge from this source before trading.
 */

const CACHE_TTL_MS = 6 * 3_600_000;

// Free-tier etiquette: space calls out, and when Google returns 429 stand down
// for a while instead of hammering. Answers are cached for hours, so a slow
// trickle of calls is all this module ever needs.
const CALL_SPACING_MS = 8_000;
const QUOTA_COOLDOWN_MS = 5 * 60_000;
let nextAllowedCallAt = 0;
let quotaCooldownUntil = 0;

/** Try models in order — separate models often have separate free-tier quotas. */
function modelLadder(): string[] {
  const ladder = [
    process.env.GEMINI_MODEL,
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-2.0-flash",
  ].filter((m): m is string => !!m);
  return [...new Set(ladder)];
}

async function callGemini(prompt: string): Promise<{ text: string; model: string }> {
  let sawQuota = false;
  let lastError = "no model succeeded";
  // Search grounding needs a paid tier; source pages are fetched by us instead.
  // Set KARVE_GEMINI_GROUNDING=1 to re-enable if billing is ever added.
  const grounded = process.env.KARVE_GEMINI_GROUNDING === "1";
  for (const model of modelLadder()) {
    try {
      const body: Record<string, unknown> = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      };
      if (grounded) body.tools = [{ google_search: {} }];
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${CONFIG.geminiApiKey}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (res.status === 429) { sawQuota = true; lastError = `${model}: 429 quota`; continue; }
      if (res.status === 404) { lastError = `${model}: 404 unavailable`; continue; }
      if (!res.ok) { lastError = `${model}: http ${res.status} ${(await res.text()).slice(0, 150)}`; continue; }
      const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text) { lastError = `${model}: empty response`; continue; }
      return { text, model };
    } catch (err) {
      lastError = `${model}: ${String((err as Error).message).slice(0, 120)}`;
    }
  }
  if (sawQuota) {
    quotaCooldownUntil = Date.now() + QUOTA_COOLDOWN_MS;
    journal("error", { where: "estimateLlm", note: `quota exhausted on all models — cooling down ${QUOTA_COOLDOWN_MS / 60_000}min` });
  }
  throw new Error(lastError);
}

/**
 * Fetch the market's own resolution-source pages and reduce them to readable
 * text. Reading the exact page the oracle will use beats any web search.
 */
async function fetchSourceContext(urls: string[]): Promise<string> {
  const chunks: string[] = [];
  for (const url of urls.slice(0, 2)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; KarveAgent/1.0)", accept: "text/html,*/*" },
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const raw = (await res.text()).slice(0, 400_000);
      const text = raw
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 6_000);
      if (text.length > 200) chunks.push(`SOURCE (${url}): ${text}`);
    } catch {
      // JS-only or blocked pages simply contribute nothing
    }
  }
  return chunks.join("\n\n");
}

interface CachedEstimate {
  probs: number[];
  reasoning: string;
  alreadyResolved?: boolean;
  usedSources?: boolean;
  at: number;
}

export async function estimateLlm(market: MarketSnapshot): Promise<ProbabilityEstimate | null> {
  if (!CONFIG.geminiApiKey) return null;
  // Hard-off switch still honored if someone sets min edge ≥ 1.
  if (CONFIG.minEdge.llm >= 1) return null;

  const cache = loadState<Record<string, CachedEstimate>>("llm-cache", {});
  const cached = cache[market.address];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS && cached.probs.length === market.outcomes.length) {
    const peak = Math.max(...cached.probs);
    if (peak < CONFIG.minOutcomeProbability) return null;
    // Already-resolved claims still need sources + a closed window.
    if (cached.alreadyResolved) {
      const horizon = market.resolvesAt ?? market.settlesAt;
      const windowStillOpen = horizon !== null && horizon.getTime() > Date.now() + 60 * 60_000;
      if (!cached.usedSources || windowStillOpen) return null;
    }
    return toEstimate(cached.probs, cached.reasoning + " (cached)", cached.alreadyResolved === true, cached.usedSources === true);
  }

  const resolutionCriteria = String((market.metadata as Record<string, unknown>)?.resolutionCriteria ?? "");
  const dataSources = Array.isArray(market.dataSources)
    ? market.dataSources.filter((s): s is string => typeof s === "string").slice(0, 3)
    : [];
  const sourceContext = await fetchSourceContext(dataSources);
  const usedSources = sourceContext.length > 0;

  const prompt = [
    `Today is ${new Date().toUTCString()}.`,
    `You are a careful probabilistic forecaster answering a prediction-market question.`,
    `FIRST, determine whether the outcome is ALREADY KNOWN: many questions concern events that already`,
    `finished (a game already played, a recorded temperature, a published ranking).`,
    `If the outcome is already determined by the evidence, assign ~0.95-0.97 to the correct outcome (never 1.0).`,
    `Only if the event is genuinely undecided, forecast it probabilistically.`,
    usedSources
      ? `CURRENT CONTENT OF THE MARKET'S OFFICIAL RESOLUTION SOURCES (fetched minutes ago — treat as ground truth):\n${sourceContext}`
      : `No source content could be fetched. Reason only from well-established base rates; if the answer depends on a recent event you cannot verify, spread probabilities toward uncertainty and set alreadyResolved=false.`,
    `Question: ${market.question}`,
    resolutionCriteria ? `Resolution criteria: ${resolutionCriteria}` : "",
    market.resolvesAt ? `Resolution date: ${market.resolvesAt.toUTCString()}` : "",
    `Possible outcomes (in order): ${market.outcomes.join(" | ")}`,
    `Respond with ONLY a JSON object, no prose:`,
    `{"probabilities": [p per outcome, summing to 1], "alreadyResolved": true/false, "reasoning": "<one concise paragraph citing the key facts>"}`,
  ].filter(Boolean).join("\n");

  if (Date.now() < quotaCooldownUntil) return null;
  const waitMs = nextAllowedCallAt - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  nextAllowedCallAt = Date.now() + CALL_SPACING_MS;

  try {
    const { text } = await callGemini(prompt);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`no JSON in response: ${text.slice(0, 150)}`);
    const parsed = JSON.parse(jsonMatch[0]) as { probabilities?: number[]; alreadyResolved?: boolean; reasoning?: string };

    const probs = parsed.probabilities;
    if (!Array.isArray(probs) || probs.length !== market.outcomes.length) throw new Error("bad probabilities array");
    const total = probs.reduce((a, b) => a + b, 0);
    if (!(total > 0.5 && total < 1.5)) throw new Error(`probabilities sum to ${total}`);
    const normalized = probs.map((p) => clamp(p / total, 0.005, 0.995));

    const alreadyResolved = parsed.alreadyResolved === true;
    // A "the event already happened" claim with no source evidence is memory, not knowledge. Too risky.
    if (alreadyResolved && !usedSources) throw new Error("model claims resolution without source evidence — skipped");

    cache[market.address] = { probs: normalized, reasoning: parsed.reasoning ?? "", alreadyResolved, usedSources, at: Date.now() };
    saveState("llm-cache", cache);

    const peak = Math.max(...normalized);
    if (peak < CONFIG.minOutcomeProbability) return null;

    // "Already resolved" still requires sources + a closed resolution window.
    if (alreadyResolved) {
      const horizon = market.resolvesAt ?? market.settlesAt;
      const windowStillOpen = horizon !== null && horizon.getTime() > Date.now() + 60 * 60_000;
      if (!usedSources || windowStillOpen) return null;
    }
    // Speculative forecasts are allowed in max-aggression mode when peak clears the floor.
    return toEstimate(normalized, parsed.reasoning ?? "", alreadyResolved, usedSources);
  } catch (err) {
    journal("error", { where: "estimateLlm", market: market.address, err: String((err as Error).message).slice(0, 300) });
    return null;
  }
}

function toEstimate(probs: number[], reasoning: string, alreadyResolved: boolean, usedSources: boolean): ProbabilityEstimate {
  const peak = Math.max(...probs);
  let confidence: number;
  if (alreadyResolved && usedSources && peak >= 0.95) {
    confidence = clamp(0.94 + (peak - 0.95) * 2, 0.94, 0.98);
  } else if (alreadyResolved && usedSources) {
    confidence = 0.8;
  } else if (usedSources) {
    confidence = clamp(0.55 + (peak - 0.7) * 0.5, 0.55, 0.75);
  } else {
    confidence = clamp(0.45 + (peak - 0.7) * 0.4, 0.4, 0.65);
  }
  return {
    source: "llm",
    probs,
    confidence,
    reasoning: `Gemini${alreadyResolved ? " (event already resolved)" : ""}${usedSources ? " [read official sources]" : ""}: ${reasoning}`.slice(0, 600),
  };
}
