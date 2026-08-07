import "dotenv/config";
import { DelphiClient } from "@gensyn-ai/gensyn-delphi-sdk";

const client = new DelphiClient();
console.log("Using network:", client.network || process.env.DELPHI_NETWORK);

client.listMarkets({ status: "open", limit: 100 })
  .then(listMarketsResponse => {
    const markets = listMarketsResponse.markets || [];
    let marketsWithReferenceUrl = 0;
    markets.forEach(market => {
      const dataSources = market.metadata?.dataSources || [];
      const hasReferenceUrl = dataSources.some(dataSource => typeof dataSource === "string" && dataSource.includes("http"));
      if (hasReferenceUrl) marketsWithReferenceUrl++;
      console.log(`[${market.id}] ${market.metadata?.question}`);
      console.log(`  dataSources: ${JSON.stringify(dataSources)}`);
    });
    console.log(`\n${marketsWithReferenceUrl} of ${markets.length} markets have a URL in dataSources.`);
  })
  .catch(error => console.error("ERROR:", error.message));