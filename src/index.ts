import { CONFIG } from "./config.js";
import { runAgent } from "./loop.js";
import { journal } from "./journal.js";

/**
 * Karve — autonomous trading agent for the Delphi Agent Arena.
 *
 *   npm run agent              → dry-run (decisions logged, nothing sent on-chain)
 *   npm run agent -- --live    → real trading
 *   npm run agent -- --once    → single scan cycle, then exit
 */

const args = new Set(process.argv.slice(2));
if (args.has("--live")) {
  // Config is read once at startup; flipping here before first use is safe.
  (CONFIG as { dryRun: boolean }).dryRun = false;
}

const required = ["DELPHI_API_ACCESS_KEY"];
if ((process.env.DELPHI_SIGNER_TYPE ?? "") === "private_key") required.push("WALLET_PRIVATE_KEY");
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  console.error("Copy .env.example to .env and fill them in.");
  process.exit(1);
}

process.on("unhandledRejection", (reason) => {
  journal("error", { where: "unhandledRejection", err: String(reason).slice(0, 300) });
});

runAgent({ once: args.has("--once") }).catch((err) => {
  journal("error", { where: "fatal", err: String((err as Error).stack ?? err).slice(0, 1000) });
  console.error(err);
  process.exit(1);
});
