const { DelphiClient } = require('@gensyn-ai/gensyn-delphi-sdk');

async function main() {
  // Try with just network config. If API key is strictly required for read-only getMarkets, 
  // it might throw an error, but let's try.
  const client = new DelphiClient({
    network: 'competition-testnet'
  });
  
  try {
    const markets = await client.getMarkets(); // or getOpenMarkets() if that's the method
    console.log(`Found ${markets.length} markets.`);
    markets.forEach(m => {
      console.log(`\n- [${m.id}] ${m.title}`);
      
      const context = m.metadata?.model?.prompt_context || m.metadata?.description || m.description || '';
      console.log(`  Context: ${context.substring(0, 100).replace(/\n/g, ' ')}...`);
      
      const sources = m.metadata?.dataSources || m.dataSources || [];
      if (sources.length > 0) {
        console.log(`  Sources: ${sources.map(d => typeof d === 'string' ? d : (d.url || d.name)).join(', ')}`);
      }
    });
  } catch (err) {
    console.error('Error fetching markets:', err.message);
  }
}

main();
