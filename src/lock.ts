import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const LOCK_PATH = join(process.cwd(), "data", "agent.lock");

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Prevent two live agents on this machine from trading the same wallet. */
export function acquireAgentLock(): void {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  if (existsSync(LOCK_PATH)) {
    try {
      const prev = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
      if (prev.pid && pidAlive(prev.pid) && prev.pid !== process.pid) {
        console.error(`Karve is already running (pid ${prev.pid}). Stop that process first — two bots on one wallet will fight.`);
        process.exit(1);
      }
    } catch {
      // stale/corrupt lock — take over
    }
  }
  writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");
}

export function releaseAgentLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    const prev = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { pid?: number };
    if (prev.pid === process.pid) unlinkSync(LOCK_PATH);
  } catch {
    // ignore
  }
}
