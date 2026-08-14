import { CONFIG } from "./config.js";
import { Delphi } from "./delphi.js";
import { executeIntent } from "./executor.js";
import { journal } from "./journal.js";
import { decideTrade, loadPortfolio, savePortfolio } from "./risk.js";
import { estimateMarket } from "./strategy/index.js";
import type { Address } from "./types.js";
import { formatProb, sleep, tokensToNumber } from "./util.js";

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

/**
 * When cash is too low to punch new trades, sell positions we've lost conviction
 * on so capital can rotate into fresher edges.
 */
async function rotateWeakPositions(delphi: Delphi, markets: Awaited<ReturnType<Delphi["listOpenMarkets"]>>): Promise<number> {
  const mark = await delphi.bankrollMark();
  if (mark.bankroll <= 0) return 0;
  if (mark.cash / mark.bankroll >= CONFIG.rotateCashTriggerFraction) return 0;

  const open = (await delphi.openPositions()).filter((p) => p.marketStatus === "open");
  if (open.length === 0) return 0;

  const byAddress = new Map(markets.map((m) => [m.address.toLowerCase(), m]));
  let freed = 0;

  for (const pos of open) {
    const market = byAddress.get(pos.market.toLowerCase());
    if (!market) continue;
    try {
      const estimate = await estimateMarket(market);
      if (!estimate) continue;
      const ourProb = estimate.probs[pos.outcomeIdx] ?? 0;
      const mktProb = market.impliedProbs[pos.outcomeIdx] ?? 0;
      const edge = ourProb - mktProb;
      const shouldSell = edge <= CONFIG.rotateSellEdge || ourProb <= CONFIG.rotateSellMaxProb;
      if (!shouldSell) continue;

      if (CONFIG.dryRun) {
        journal("decision", {
          note: "rotate would sell",
          market: market.address,
          outcomeIdx: pos.outcomeIdx,
          ourProb,
          edge,
          shares: pos.shares.toString(),
        });
        continue;
      }

      const { transactionHash, tokensOut } = await delphi.sellShares(pos.market as Address, pos.outcomeIdx, pos.shares);
      const amount = tokensToNumber(tokensOut);
      freed += amount;
      journal("trade", {
        action: "sell",
        market: market.address,
        question: market.question.slice(0, 140),
        outcome: market.outcomes[pos.outcomeIdx],
        outcomeIdx: pos.outcomeIdx,
        ourProb,
        edge,
        tokensOut: amount,
        transactionHash,
        reason: edge <= CONFIG.rotateSellEdge ? "edge flipped/weak" : "conviction collapsed",
      });
      await notifyDiscord(
        `Karve SOLD (rotate): "${market.question.slice(0, 100)}" → ${market.outcomes[pos.outcomeIdx]} ` +
        `(+${amount.toFixed(1)} TST, edge ${(edge * 100).toFixed(1)}%)`,
      );
    } catch (err) {
      journal("error", { where: "rotateWeakPositions", market: pos.market, err: String((err as Error).message).slice(0, 300) });
    }
  }

  if (freed > 0) await reconcilePortfolio(delphi);
  return freed;
}

/** In dry-run no position is recorded, so remember session decisions to avoid re-logging the same trade every scan. */
const dryRunDecisions = new Set<string>();

async function scanCycle(delphi: Delphi): Promise<void> {
  // Redeem winners BEFORE sizing so recovered cash can be redeployed this cycle.
  const recovered = await delphi.settlementSweep();
  await reconcilePortfolio(delphi);

  let mark = await delphi.bankrollMark();
  const markets = await delphi.listOpenMarkets();

  // Free capital from weak holdings when we're cash-starved.
  const rotated = await rotateWeakPositions(delphi, markets);
  if (rotated > 0) mark = await delphi.bankrollMark();

  journal("scan", {
    openMarkets: markets.length,
    cash: mark.cash,
    positionValue: Number(mark.positionValue.toFixed(2)),
    bankroll: Number(mark.bankroll.toFixed(2)),
    recovered,
    rotated: Number(rotated.toFixed(2)),
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
