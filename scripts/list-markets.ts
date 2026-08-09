import { Delphi } from "../src/delphi.js";
import { formatProb } from "../src/util.js";

/**
 * Human-readable dump of every open market with live implied probabilities.
 * Usage: npm run markets
 */
const delphi = new Delphi();
await delphi.init();

const markets = await delphi.listOpenMarkets();
markets.sort((a, b) => (a.resolvesAt?.getTime() ?? Infinity) - (b.resolvesAt?.getTime() ?? Infinity));

for (const m of markets) {
  console.log(`\n${m.question}`);
  console.log(`  address:  ${m.address}`);
  console.log(`  category: ${m.category}   resolves: ${m.resolvesAt?.toISOString() ?? "?"}`);
  m.outcomes.forEach((label, i) => {
    console.log(`    ${formatProb(m.impliedProbs[i]!).padStart(6)}  ${label}`);
  });
  if (m.dataSources) console.log(`  dataSources: ${JSON.stringify(m.dataSources).slice(0, 200)}`);
}
console.log(`\n${markets.length} open markets.`);
