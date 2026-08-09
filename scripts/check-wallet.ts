import { createPublicClient, defineChain, formatEther, http } from "viem";

/**
 * Where is the wallet's money? Checks gas on Gensyn Testnet, gas on Sepolia
 * (in case faucet ETH was never bridged), and competition-token balance.
 * Usage: npx tsx scripts/check-wallet.ts 0xYourAddress
 */

const address = (process.argv[2] ?? process.env.ETH_ADDRESS ?? "") as `0x${string}`;
if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error("Usage: npx tsx scripts/check-wallet.ts 0xYourAddress");
  process.exit(1);
}

const gensynTestnet = defineChain({
  id: 685685,
  name: "Gensyn Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://gensyn-testnet.g.alchemy.com/public"] } },
});

const sepolia = defineChain({
  id: 11155111,
  name: "Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://ethereum-sepolia-rpc.publicnode.com"] } },
});

const TST = "0x8A2d75753362Eb5D5669a2c22cbf394b26a0571F" as const;
const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const gensynClient = createPublicClient({ chain: gensynTestnet, transport: http() });
const sepoliaClient = createPublicClient({ chain: sepolia, transport: http() });

console.log(`wallet: ${address}\n`);

const [gensynEth, sepoliaEth, tst] = await Promise.allSettled([
  gensynClient.getBalance({ address }),
  sepoliaClient.getBalance({ address }),
  gensynClient.readContract({ address: TST, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }),
]);

if (gensynEth.status === "fulfilled") {
  const eth = Number(formatEther(gensynEth.value));
  console.log(`Gensyn Testnet ETH (gas the agent uses): ${eth.toFixed(6)} ${eth > 0.0005 ? "— OK" : "— TOO LOW, bridge more"}`);
} else {
  console.log(`Gensyn Testnet ETH: query failed (${String(gensynEth.reason).slice(0, 120)})`);
}

if (sepoliaEth.status === "fulfilled") {
  const eth = Number(formatEther(sepoliaEth.value));
  console.log(`Sepolia ETH (needs bridging to be useful): ${eth.toFixed(6)}`);
} else {
  console.log(`Sepolia ETH: query failed (${String(sepoliaEth.reason).slice(0, 120)})`);
}

if (tst.status === "fulfilled") {
  const tokens = Number(tst.value) / 1e6;
  console.log(`Competition tokens (TST): ${tokens.toFixed(2)} ${tokens > 0 ? "— funded!" : "— not funded yet (expected before Aug 10)"}`);
} else {
  console.log(`Competition tokens (TST): query failed (${String(tst.reason).slice(0, 120)})`);
}
