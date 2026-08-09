import { Delphi } from "../src/delphi.js";
import { numberToTokens, tokensToNumber, sharesToNumber } from "../src/util.js";

/**
 * End-to-end smoke test (read-only unless --buy is passed):
 *   1. connect + signer
 *   2. balances
 *   3. list open markets
 *   4. size a 1-token quote on the first market
 *   5. with --buy: actually execute that 1-token trade
 *
 * Usage: npm run smoke [-- --buy]
 */
const doBuy = process.argv.includes("--buy");

const delphi = new Delphi();
const { address } = await delphi.init();
console.log(`wallet: ${address}`);

const balances = await delphi.balances();
console.log(`balances: ${balances.collateral} collateral tokens, ${balances.eth} ETH`);

const markets = await delphi.listOpenMarkets();
console.log(`open markets: ${markets.length}`);
if (markets.length === 0) process.exit(0);

const market = markets[0]!;
console.log(`\nquoting: "${market.question}"`);
console.log(`outcomes: ${market.outcomes.join(" / ")}`);
console.log(`implied:  ${market.impliedProbs.map((p) => (p * 100).toFixed(1) + "%").join(" / ")}`);

const sized = await delphi.sizeBuyForBudget(market.address, 0, numberToTokens(1));
if (!sized) {
  console.log("could not size a 1-token quote");
  process.exit(1);
}
console.log(`1 token buys ${sharesToNumber(sized.sharesOut).toFixed(4)} shares of "${market.outcomes[0]}"`);
console.log(`effective price/share: ${sized.effectiveAvgPrice.toFixed(4)} (spot implied: ${market.impliedProbs[0]!.toFixed(4)})`);

if (doBuy) {
  console.log("\nexecuting 1-token live buy...");
  const hash = await delphi.buyShares(market.address, 0, sized.sharesOut, sized.tokensIn);
  console.log(`done: tx ${hash}, spent ${tokensToNumber(sized.tokensIn)} tokens`);

  const positions = await delphi.openPositions();
  console.log(`open positions now: ${positions.length}`);
} else {
  console.log("\n(read-only run — pass --buy to execute the 1-token trade)");
}
