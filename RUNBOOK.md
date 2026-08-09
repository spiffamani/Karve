# Karve Runbook — Delphi Agent Arena (Aug 10–24)

One page for operating the agent during the competition. The strategy details live in the code (`src/strategy/`); this is how you run and supervise it.

## One-time setup (before Aug 10)

1. **Register the wallet** on the DoraHacks competition page. One wallet for the team. Use a fresh keypair — this wallet is our leaderboard identity.
2. **Generate a testnet API key**: https://delphi-api-access.gensyn.ai/
3. **Gas**: get Sepolia ETH from a faucet and bridge to Gensyn Testnet (or use the Alchemy Gensyn faucet — requires 0.001 ETH held on ETH mainnet).
4. `copy .env.example .env` and fill in `DELPHI_API_ACCESS_KEY` and `WALLET_PRIVATE_KEY`. Optional: `GEMINI_API_KEY` (enables the LLM fallback), `KARVE_DISCORD_WEBHOOK` (trade/error alerts).
5. `npm install`

## Daily operation

| What | Command |
| --- | --- |
| See all open markets + prices | `npm run markets` |
| Read-only end-to-end check | `npm run smoke` |
| One real 1-token trade (launch-day check) | `npm run smoke -- --buy` |
| Agent in dry-run (decides, doesn't trade) | `npm run agent` |
| Agent LIVE | `npm run agent -- --live` |
| Agent LIVE + auto-restart on crash | `powershell -ExecutionPolicy Bypass -File scripts\run-forever.ps1 -Live` |

## Launch sequence (Aug 10)

1. `npm run smoke` — wallet connects, competition tokens landed, markets visible.
2. `npm run agent` (dry-run) for 1–2 hours — read `data/journal.jsonl`, sanity-check every `trade` line: does the reasoning make sense? Are sizes sane?
3. `npm run smoke -- --buy` — one tiny real trade end-to-end (this also starts satisfying the minimum-activity requirement).
4. Start live: `powershell -ExecutionPolicy Bypass -File scripts\run-forever.ps1 -Live`
5. Laptop must stay on and awake: plug it in, and in Windows power settings set "When plugged in, put my device to sleep" to **Never**.

## What to review daily (both of you, ~15 min)

- `data/journal.jsonl` — every decision with reasoning. Grep-able: `trade`, `skip`, `error`, `redeem`, `balance` lines.
- `data/matches.json` — Polymarket matches queued for human review. If a match is correct, set `"approved": true` and the agent starts using it next scan. **This is the highest-value 5 minutes of your day** — every approved match unlocks a real-money price signal.
- The official leaderboard — are we drifting? What are top wallets doing? (Their trades are public on the subgraph.)
- Gas: journal `balance` lines warn when ETH runs low. Top up early, not at 2am.

## Strategy levers (in `.env`, restart the agent to apply)

- `KARVE_KELLY_FRACTION` (default 0.35) — global aggression. Raise toward 0.5 in week 2 if we're behind the leaders; lower if we're ahead and defending.
- `KARVE_MIN_EDGE_*` — per-signal trade thresholds.
- `KARVE_MAX_PER_MARKET` / `KARVE_MAX_PER_GROUP` — concentration caps.

## Emergencies

- **Agent crashed / laptop rebooted**: just rerun the run-forever script. State lives in `data/` and on-chain; nothing is lost.
- **Out of gas**: bridge more Sepolia ETH; the agent resumes automatically.
- **A signal looks systematically wrong** (e.g. every crossmarket trade losing): set its `KARVE_MIN_EDGE_*` to `1` (disables that module) and restart. No code changes needed.
- **Kill switch**: Ctrl+C in the agent window. Open positions are safe — they settle on-chain regardless of whether the agent is running.

## Rules we must not break

- ONE wallet. Never register or fund a second one.
- No coordinating trades with other entrants (talking strategy in Discord is fine; coordinated pricing is not).
- Only official competition markets count — the agent only sees those via the competition API, so this is automatic.
