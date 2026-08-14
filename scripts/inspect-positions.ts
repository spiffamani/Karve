import { Delphi } from "../src/delphi.js";
import { sharesToNumber } from "../src/util.js";

const d = new Delphi();
await d.init();
const bal = await d.balances();
const pos = await d.openPositions();
console.log(`cash=${bal.collateral.toFixed(2)} eth=${bal.eth.toFixed(6)} openPositions=${pos.length}`);

let mark = 0;
for (const p of pos.slice(0, 30)) {
  try {
    const probs = await d.impliedProbabilities(p.market, Math.max(p.outcomeIdx + 1, 2));
    const px = probs[p.outcomeIdx] ?? 0;
    const shares = sharesToNumber(p.shares);
    const value = shares * px;
    mark += value;
    console.log(`${p.marketStatus.padEnd(20)} idx=${p.outcomeIdx} shares=${shares.toFixed(2)} px=${(px * 100).toFixed(1)}% ~${value.toFixed(2)} TST  ${p.market.slice(0, 10)}`);
  } catch (err) {
    console.log(`fail ${p.market} ${String((err as Error).message).slice(0, 80)}`);
  }
}
console.log(`mark-to-market (first ${Math.min(30, pos.length)}): ${mark.toFixed(2)} TST`);
console.log(`approx bankroll if all valued: cash+mark ≈ ${(bal.collateral + mark).toFixed(2)}`);
