import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./util.js";

/**
 * Append-only JSONL journal — every decision (including skips) gets a line.
 * This is our memory, our debugging tool, and our post-competition review data.
 */

const DATA_DIR = join(process.cwd(), "data");

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export type JournalKind =
  | "scan" | "estimate" | "decision" | "trade" | "skip"
  | "redeem" | "liquidate" | "error" | "balance" | "startup";

export function journal(kind: JournalKind, payload: Record<string, unknown>): void {
  ensureDataDir();
  const line = JSON.stringify({ t: nowIso(), kind, ...payload }, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  appendFileSync(join(DATA_DIR, "journal.jsonl"), line + "\n", "utf8");
  // Mirror the important events to the console for live monitoring.
  if (kind !== "scan" && kind !== "estimate") {
    console.log(`[${kind}] ${line.slice(0, 400)}`);
  }
}

/** Small persisted key-value state (LLM estimate cache, market matches, etc). */
export function loadState<T>(name: string, fallback: T): T {
  ensureDataDir();
  const file = join(DATA_DIR, `${name}.json`);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function saveState(name: string, value: unknown): void {
  ensureDataDir();
  const file = join(DATA_DIR, `${name}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}
