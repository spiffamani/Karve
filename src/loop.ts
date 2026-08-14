import { CONFIG } from "./config.js";
import { Delphi } from "./delphi.js";
import { executeIntent } from "./executor.js";
import { journal } from "./journal.js";
import { decideTrade, loadPortfolio, savePortfolio } from "./risk.js";
import { estimateMarket } from "./strategy/index.js";
import { formatProb, sleep } from "./util.js";

async function notifyDiscord(message: string): Promise<void> {
  if (!CONFIG.discordWebhookUrl) return;
  try {
    await fetch(CONFIG.discordWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: message.slice(0, 1900) }),
    });
  } catch {
    // alerting must never crash the agent
  }
}

/** Reconcile local portfolio records against on-chain reality. */
async function reconcilePortfolio(delphi: Delphi): Promise<void> {
  const open = await delphi.openPositions();
  const openKeys = new Set(open.map((p) => `${p.market.toLowerCase()}:${p.outcomeIdx}`));
  const portfolio = loadPortfolio();
  const before = portfolio.positions.length;
  portfolio.positions = portfolio.positions.filter((p) =>
    openKeys.has(`${p.market.toLowerCase()}:${p.outcomeIdx}`),
  );
  if (portfolio.positions.length !== before) savePortfolio(portfolio);
}

/** In dry-run no position is recorded, so remember session decisions to avoid re-logging the same trade every scan. */
const dryRunDecisions = new Set<string>();

async function scanCycle(delphi: Delphi): Promise<void> {
  // Redeem winners BEFORE sizing so recovered cash can be redeployed this cycle.
  const recovered = await delphi.settlementSweep();
  await reconcilePortfolio(delphi);

  const mark = await delphi.bankrollMark();
  const markets = await delphi.listOpenMarkets();
  journal("scan", {
    openMarkets: markets.length,
    cash: mark.cash,
    positionValue: Number(mark.positionValue.toFixed(2)),
    bankroll: Number(mark.bankroll.toFixed(2)),
    recovered,
  });

  const portfolio = loadPortfolio();
  let evaluated = 0;
  let traded = 0;

  // Single cash tracker for the whole cycle. Before funding arrives, dry-run
  // rehearses with a placeholder bankroll; live mode always uses real cash.
  let cash = mark.cash;
  if (CONFIG.dryRun && cash === 0) cash = 100;
  // Shrink bankroll as we spend cash this cycle (positions already marked).
  let bankroll = Math.max(mark.bankroll, cash);

  for (const market of markets) {
    try {
      const estimate = await estimateMarket(market);
      if (!estimate) continue;
      evaluated++;

      journal("estimate", {
        market: market.address,
        question: market.question.slice(0, 140),
        source: estimate.source,
        ours: estimate.probs.map(formatProb).join("/"),
        market_: market.impliedProbs.map(formatProb).join("/"),
      });

      const decision = decideTrade(market, estimate, {
        cashTokens: cash,
        portfolio,
        bankroll,
      });

      if (decision.action === "skip") {
        if ((decision.edge ?? 0) > 0.02) {
          journal("skip", { market: market.address, question: market.question.slice(0, 140), reason: decision.reason });
        }
        continue;
      }

      const decisionKey = `${market.address}:${decision.intent.outcomeIdx}`;
      if (CONFIG.dryRun && dryRunDecisions.has(decisionKey)) continue;
      if (CONFIG.dryRun) dryRunDecisions.add(decisionKey);

      const result = await executeIntent(delphi, decision.intent);
      if (result.executed || result.dryRun) {
        traded++;
        const spent = Number(result.tokensIn ?? 0n) / 1e6;
        cash -= spent;
        bankroll = Math.max(cash, bankroll - spent);
        await notifyDiscord(
          `${CONFIG.dryRun ? "[DRY-RUN] " : ""}Karve ${result.executed ? "traded" : "would trade"}: ` +
          `"${market.question.slice(0, 100)}" → ${market.outcomes[decision.intent.outcomeIdx]} ` +
          `(${decision.intent.budgetTokens} TST, edge ${(decision.intent.signalEdge * 100).toFixed(1)}%, ${decision.intent.estimate.source})`,
        );
      }
    } catch (err) {
      journal("error", { where: "scanCycle", market: market.address, err: String((err as Error).message).slice(0, 300) });
    }
  }

  journal("scan", { done: true, evaluated, traded, cashLeft: Number(cash.toFixed(2)) });
}

async function sweepCycle(delphi: Delphi): Promise<void> {
  const recovered = await delphi.settlementSweep();
  await reconcilePortfolio(delphi);
  const balances = await delphi.balances();
  journal("balance", { cash: balances.collateral, eth: balances.eth, recovered });

  if (balances.eth < CONFIG.minEthReserve) {
    const warning = `LOW GAS: ${balances.eth.toFixed(6)} ETH left — top up now or the agent stops trading soon.`;
    journal("error", { where: "sweepCycle", err: warning });
    await notifyDiscord(warning);
  }
}

export async function runAgent(opts: { once: boolean }): Promise<void> {
  const delphi = new Delphi();
  const { address } = await delphi.init();
  const balances = await delphi.balances();

  journal("startup", {
    wallet: address,
    network: CONFIG.network,
    dryRun: CONFIG.dryRun,
    cash: balances.collateral,
    eth: balances.eth,
  });
  console.log(`\nKarve agent | wallet ${address} | ${CONFIG.network} | ${CONFIG.dryRun ? "DRY-RUN (no real trades)" : "LIVE TRADING"}`);
  console.log(`Balances: ${balances.collateral.toFixed(2)} collateral, ${balances.eth.toFixed(6)} ETH\n`);
  await notifyDiscord(`Karve started: ${CONFIG.dryRun ? "dry-run" : "LIVE"}, ${balances.collateral.toFixed(2)} TST, ${balances.eth.toFixed(5)} ETH`);

  let lastSweep = 0;
  for (;;) {
    try {
      await scanCycle(delphi);
      if (Date.now() - lastSweep > CONFIG.sweepIntervalMs) {
        await sweepCycle(delphi);
        lastSweep = Date.now();
      }
    } catch (err) {
      journal("error", { where: "mainLoop", err: String((err as Error).message).slice(0, 300) });
      await notifyDiscord(`Karve loop error (will retry): ${String((err as Error).message).slice(0, 200)}`);
    }
    if (opts.once) break;
    await sleep(CONFIG.scanIntervalMs);
  }
}
