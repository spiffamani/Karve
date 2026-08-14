import { DelphiClient, DYNAMIC_PARIMUTUEL_GATEWAY_ABI } from "@gensyn-ai/gensyn-delphi-sdk";
import type { Abi, PublicClient } from "viem";
import { CONFIG } from "./config.js";
import type { Address, MarketSnapshot, MarketStatus } from "./types.js";
import { journal } from "./journal.js";
import { sharesToNumber, tokensToNumber, withRetry } from "./util.js";

const COLLATERAL_BY_NETWORK: Record<string, Address> = {
  testnet: "0x0724D6079b986F8e44bDafB8a09B60C0bd6A45a1",
  mainnet: "0x5b32c997211621d55a89Cc5abAF1cC21F3A6ddF5",
  "competition-testnet": "0x8A2d75753362Eb5D5669a2c22cbf394b26a0571F",
};

const ERC20_BALANCE_ABI = [
  {
    type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface WalletBalances {
  eth: number;
  collateral: number;
}

/**
 * Thin, resilient wrapper around DelphiClient. All chain/API access for the
 * agent goes through here so retries, normalization, and logging live in one place.
 */
export class Delphi {
  readonly client: DelphiClient;
  private address: Address | null = null;
  private publicClient: PublicClient | null = null;
  private gatewayCache = new Map<string, Address>();

  constructor() {
    this.client = new DelphiClient();
  }

  async init(): Promise<{ address: Address }> {
    const signer = await this.client.getSigner();
    this.address = signer.address as Address;
    this.publicClient = signer.publicClient as PublicClient;
    return { address: this.address };
  }

  get wallet(): Address {
    if (!this.address) throw new Error("Delphi.init() must be called first");
    return this.address;
  }

  private get chain(): PublicClient {
    if (!this.publicClient) throw new Error("Delphi.init() must be called first");
    return this.publicClient;
  }

  private get collateralAddress(): Address {
    return (process.env.DELPHI_TOKEN_ADDRESS as Address) ?? COLLATERAL_BY_NETWORK[CONFIG.network] ?? COLLATERAL_BY_NETWORK["competition-testnet"]!;
  }

  async balances(): Promise<WalletBalances> {
    const [ethRaw, collateralRaw] = await Promise.all([
      withRetry("getBalance", () => this.chain.getBalance({ address: this.wallet })),
      withRetry("collateral balanceOf", () =>
        this.chain.readContract({
          address: this.collateralAddress,
          abi: ERC20_BALANCE_ABI,
          functionName: "balanceOf",
          args: [this.wallet],
        }),
      ),
    ]);
    return { eth: Number(ethRaw) / 1e18, collateral: tokensToNumber(collateralRaw as bigint) };
  }

  private async gatewayFor(market: Address): Promise<Address> {
    const cached = this.gatewayCache.get(market);
    if (cached) return cached;
    const gateway = (await withRetry("resolveGateway", () => this.client.resolveGateway(market))) as Address;
    this.gatewayCache.set(market, gateway);
    return gateway;
  }

  /** On-chain implied probabilities for every outcome (0..1 each). */
  async impliedProbabilities(market: Address, outcomeCount: number): Promise<number[]> {
    const gateway = await this.gatewayFor(market);
    const indices = Array.from({ length: outcomeCount }, (_, i) => BigInt(i));
    const probs = (await withRetry("spotImpliedProbabilities", () =>
      this.chain.readContract({
        address: gateway,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI as Abi,
        functionName: "spotImpliedProbabilities",
        args: [market, indices],
      }),
    )) as bigint[];
    return probs.map((p) => Number(p) / 1e18);
  }

  /** On-chain market config: LMSR fee and trading deadline. */
  async onChainConfig(market: Address): Promise<{ tradingFee: number; tradingDeadline: Date; outcomeCount: number }> {
    const gateway = await this.gatewayFor(market);
    const raw = (await withRetry("getMarket(chain)", () =>
      this.chain.readContract({
        address: gateway,
        abi: DYNAMIC_PARIMUTUEL_GATEWAY_ABI as Abi,
        functionName: "getMarket",
        args: [market],
      }),
    )) as { config: { outcomeCount: bigint; tradingFee: bigint; tradingDeadline: bigint } };
    return {
      tradingFee: Number(raw.config.tradingFee) / 1e18,
      tradingDeadline: new Date(Number(raw.config.tradingDeadline) * 1000),
      outcomeCount: Number(raw.config.outcomeCount),
    };
  }

  /** All open markets, normalized. Falls back to chain reads when the REST payload lacks prices. */
  async listOpenMarkets(): Promise<MarketSnapshot[]> {
    const collected: MarketSnapshot[] = [];
    let skip = 0;
    const limit = 50;
    for (;;) {
      const { markets } = await withRetry("listMarkets", () =>
        this.client.listMarkets({ status: "open", skip, limit, pricesAndImpliedProbabilities: true }),
      );
      if (!markets || markets.length === 0) break;
      for (const m of markets) {
        const snapshot = await this.normalizeMarket(m as unknown as Record<string, unknown>);
        if (snapshot) collected.push(snapshot);
      }
      if (markets.length < limit) break;
      skip += limit;
    }
    return collected;
  }

  private async normalizeMarket(m: Record<string, unknown>): Promise<MarketSnapshot | null> {
    const meta = (m.metadata ?? null) as Record<string, unknown> | null;
    const outcomes = Array.isArray(meta?.outcomes) ? (meta!.outcomes as string[]) : [];
    const question = String(meta?.question ?? meta?.title ?? "").trim();
    const address = m.id as Address;
    if (!address || outcomes.length < 2 || !question) {
      journal("error", { where: "normalizeMarket", market: m.id, note: "missing outcomes/question metadata" });
      return null;
    }

    let impliedProbs = this.extractRestProbs(m, outcomes.length);
    if (!impliedProbs) {
      try {
        impliedProbs = await this.impliedProbabilities(address, outcomes.length);
      } catch (err) {
        journal("error", { where: "impliedProbabilities", market: address, err: String((err as Error).message) });
        return null;
      }
    }

    return {
      address,
      question,
      category: String(m.category ?? meta?.category ?? "unknown"),
      outcomes,
      status: m.status as MarketStatus,
      impliedProbs,
      resolvesAt: m.resolvesAt ? new Date(String(m.resolvesAt)) : null,
      settlesAt: m.settlesAt ? new Date(String(m.settlesAt)) : null,
      metadata: meta,
      dataSources: m.dataSources ?? meta?.dataSources ?? null,
      marketUrl: String(m.marketUrl ?? ""),
    };
  }

  /** The REST field name for prices isn't pinned in docs — probe the plausible shapes. */
  private extractRestProbs(m: Record<string, unknown>, outcomeCount: number): number[] | null {
    const candidates = [
      m.impliedProbabilities,
      (m.pricesAndImpliedProbabilities as Record<string, unknown> | undefined)?.impliedProbabilities,
      (m.prices as Record<string, unknown> | undefined)?.impliedProbabilities,
    ];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length === outcomeCount) {
        const nums = c.map((x) => Number(x));
        if (nums.every((n) => Number.isFinite(n) && n >= 0)) {
          // Normalize: values may arrive as 0..1 floats, percents, or 1e18 fixed-point.
          const max = Math.max(...nums);
          if (max > 1e6) return nums.map((n) => n / 1e18);
          if (max > 1.5) return nums.map((n) => n / 100);
          return nums;
        }
      }
    }
    return null;
  }

  /**
   * Find the share amount whose cost ≈ budgetTokens via binary search on
   * quoteBuy (reads are free). Returns the quote for execution.
   */
  async sizeBuyForBudget(market: Address, outcomeIdx: number, budgetTokens: bigint): Promise<{
    sharesOut: bigint; tokensIn: bigint; effectiveAvgPrice: number;
  } | null> {
    const quote = async (shares: bigint): Promise<bigint> => {
      const { tokensIn } = await withRetry("quoteBuy", () =>
        this.client.quoteBuy({ marketAddress: market, outcomeIdx, sharesOut: shares }),
      );
      return tokensIn as bigint;
    };

    // Bracket: start from "budget buys shares at price 1.0" (lower bound on shares).
    let lo = (budgetTokens * 10n ** 12n); // tokens(6dec) → shares(18dec) at price 1.0
    let hi = lo * 2n;
    for (let i = 0; i < 20; i++) {
      const cost = await quote(hi);
      if (cost >= budgetTokens) break;
      hi *= 2n;
    }
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2n;
      const cost = await quote(mid);
      if (cost > budgetTokens) hi = mid; else lo = mid;
    }
    const sharesOut = lo;
    if (sharesOut <= 0n) return null;
    const tokensIn = await quote(sharesOut);
    if (tokensIn <= 0n) return null;
    const effectiveAvgPrice = tokensToNumber(tokensIn) / sharesToNumber(sharesOut);
    return { sharesOut, tokensIn, effectiveAvgPrice };
  }

  async buyShares(market: Address, outcomeIdx: number, sharesOut: bigint, tokensIn: bigint): Promise<string> {
    await withRetry("ensureTokenApproval", () =>
      this.client.ensureTokenApproval({ marketAddress: market, minimumAmount: tokensIn }),
    );
    const maxTokensIn = (tokensIn * (10_000n + CONFIG.slippageBps)) / 10_000n;
    const { transactionHash } = await withRetry("buyShares", () =>
      this.client.buyShares({ marketAddress: market, outcomeIdx, sharesOut, maxTokensIn }),
    );
    return transactionHash as string;
  }

  async sellShares(market: Address, outcomeIdx: number, sharesIn: bigint): Promise<{ transactionHash: string; tokensOut: bigint }> {
    const { tokensOut } = await withRetry("quoteSell", () =>
      this.client.quoteSell({ marketAddress: market, outcomeIdx, sharesIn }),
    );
    const minTokensOut = ((tokensOut as bigint) * (10_000n - CONFIG.slippageBps)) / 10_000n;
    const { transactionHash } = await withRetry("sellShares", () =>
      this.client.sellShares({ marketAddress: market, outcomeIdx, sharesIn, minTokensOut }),
    );
    return { transactionHash: transactionHash as string, tokensOut: tokensOut as bigint };
  }

  /** Open (non-exited) positions with a non-zero share balance. */
  async openPositions(): Promise<Array<{ market: Address; outcomeIdx: number; shares: bigint; marketStatus: MarketStatus }>> {
    const out: Array<{ market: Address; outcomeIdx: number; shares: bigint; marketStatus: MarketStatus }> = [];
    let skip = 0;
    const limit = 50;
    for (;;) {
      const { positions } = await withRetry("listPositions", () =>
        this.client.listPositions({ wallet: this.wallet, redeemedOrLiquidated: false, skip, limit }),
      );
      if (!positions || positions.length === 0) break;
      for (const p of positions) {
        const shares = BigInt(p.shares);
        if (shares === 0n) continue;
        out.push({
          market: p.marketProxy as Address,
          outcomeIdx: parseInt(p.outcomeIdx, 10),
          shares,
          marketStatus: p.marketStatus as MarketStatus,
        });
      }
      if (positions.length < limit) break;
      skip += limit;
    }
    return out;
  }

  /** Redeem every settled position; liquidate expired/failed ones. Returns tokens recovered. */
  async settlementSweep(): Promise<number> {
    const positions = await this.openPositions();
    if (positions.length === 0) return 0;

    const byMarket = new Map<Address, number[]>();
    for (const p of positions) {
      const list = byMarket.get(p.market) ?? [];
      list.push(p.outcomeIdx);
      byMarket.set(p.market, list);
    }

    let recovered = 0;
    for (const [market, outcomeIndices] of byMarket) {
      try {
        const status = await withRetry("getMarketStatus", () => this.client.getMarketStatus(market));
        if (status === "settled") {
          // Quote first: redeem reverts (0x50cd9791) when we hold only losing shares.
          let quoteTokens = 0n;
          try {
            const quote = await this.client.quoteRedeem({ marketAddress: market });
            quoteTokens = BigInt(quote.tokensOut);
          } catch {
            journal("skip", { market, reason: "settled but no winning shares to redeem (dead position)" });
            continue;
          }
          if (quoteTokens === 0n) {
            journal("skip", { market, reason: "settled redeem quote is zero" });
            continue;
          }
          const { tokensOut, transactionHash } = await withRetry("redeemMarket", () =>
            this.client.redeemMarket({ marketAddress: market }), { attempts: 2 });
          const amount = tokensToNumber(tokensOut as bigint);
          recovered += amount;
          journal("redeem", { market, tokensOut: amount, transactionHash });
        } else if (status === "expired" || status === "failed") {
          const { transactionHash } = await withRetry("liquidate", () =>
            this.client.liquidate({ marketAddress: market, outcomeIndices }), { attempts: 2 });
          journal("liquidate", { market, outcomeIndices, transactionHash });
        }
      } catch (err) {
        journal("error", { where: "settlementSweep", market, err: String((err as Error).message).slice(0, 300) });
      }
    }
    return recovered;
  }

  /**
   * Mark-to-market bankroll for sizing: cash + (shares × spot price) for every
   * non-settled open position. Settled losers contribute 0; settled winners are
   * assumed redeemed by settlementSweep before this runs.
   */
  async bankrollMark(): Promise<{ cash: number; positionValue: number; bankroll: number }> {
    const balances = await this.balances();
    const positions = await this.openPositions();
    let positionValue = 0;
    // Cache probs per market so multi-outcome positions don't re-hit RPC.
    const probCache = new Map<string, number[]>();
    for (const p of positions) {
      if (p.marketStatus === "settled" || p.marketStatus === "expired" || p.marketStatus === "failed") continue;
      try {
        let probs = probCache.get(p.market);
        if (!probs) {
          // Fetch enough slots for this outcome index; over-fetching is fine.
          probs = await this.impliedProbabilities(p.market, Math.max(p.outcomeIdx + 1, 2));
          probCache.set(p.market, probs);
        }
        const px = probs[p.outcomeIdx] ?? 0;
        positionValue += sharesToNumber(p.shares) * px;
      } catch {
        // If mark fails, fall back to ignoring that position rather than blocking the scan.
      }
    }
    const cash = balances.collateral;
    return { cash, positionValue, bankroll: cash + positionValue };
  }
}
