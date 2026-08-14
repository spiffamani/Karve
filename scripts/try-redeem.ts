import { Delphi } from "../src/delphi.js";

const d = new Delphi();
await d.init();
const pos = await d.openPositions();
const settled = [...new Set(pos.filter((p) => p.marketStatus === "settled").map((p) => p.market))];
console.log(`settled markets to probe: ${settled.length}`);

for (const market of settled) {
  try {
    const quote = await d.client.quoteRedeem({ marketAddress: market });
    console.log(`QUOTE ${market} → tokensOut=${quote.tokensOut} sharesIn=${quote.sharesIn}`);
  } catch (err) {
    console.log(`QUOTE FAIL ${market}: ${String((err as Error).message).slice(0, 160)}`);
  }
  try {
    const result = await d.client.redeemMarket({ marketAddress: market });
    console.log(`REDEEM OK ${market} → tokensOut=${result.tokensOut} tx=${result.transactionHash}`);
  } catch (err) {
    console.log(`REDEEM FAIL ${market}: ${String((err as Error).message).slice(0, 200)}`);
  }
}
