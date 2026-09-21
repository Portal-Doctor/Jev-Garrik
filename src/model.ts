import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import type { CycleTA } from "./cycle";

/** Models answer buy or sell. `hold` only appears on late blocks (no decision was made). */
export type Action = "buy" | "sell" | "hold";

/** What the model sees. Compact, relative, human-readable. */
export interface TradeState {
  market: "MON-USDC";
  block: number;
  horizonBlocks: number; // the question is about the move over this many blocks
  blockMs: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  /** Cumulative resting MON within 10/25/50 bps of mid, per side. */
  depth: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "price x size". */
  book: { bids: string[]; asks: string[] };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  recentMids: string; // oldest..newest, sampled every 5 blocks over the horizon, space separated
  /** Taker prints over the last `horizonBlocks`. cvdMon = taker buy volume - taker sell volume. */
  trades: { count: number; buyMon: number; sellMon: number; cvdMon: number; vwap: number | null; lastPrice: number | null; lastSide: "buy" | "sell" | null };
  recentTrades: string[]; // newest last, "block side size @ price"
  /** 3-block candle TA. Only computed on a decision tick. */
  ta: CycleTA;
  allowed: { buy: boolean; sell: boolean };
}

export interface Decision {
  action: Action;
  probabilities: Record<Action, number>;
  upIn10: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: TradeState): Promise<Decision>;
}

const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will MON be higher or lower than the current mid after `horizonBlocks` more blocks?",
      goal: "Trade MON-USDC on Kuru as a two-sided maker. Blocks are ~300ms. Price and book volume stream every block; a decision is made every 3 blocks (~900ms) from 3-block candles. Skew quotes toward the side that wins after `horizonBlocks`. Quotes send on a fill or a real touch move, not on every decision.",
      timing: "Quotes are post-only. Jev only flips the inventory skew (0.60/0.40 band). The engine stands aside when the spread is under the gas hurdle or markout is toxic.",
      inputs: "Use `ta` first: `ta.book` is resting bid vs ask volume (imbalance > 0 means more bids); `ta.book.deltaBid` / `deltaAsk` is the change vs the last candle. `ta.microprice` / `ta.microDevBps` is the size-weighted touch (negative = bid-heavy). `ta.vwap` / `ta.vwapDevBps` / `ta.vwapSigmaBps` is mid vs VWAP. `ta.emaCross` is a fresh fast/slow EMA cross; `ta.emaGapBps` is the stack. `ta.atrBps` is candle range. `ta.rsi` and `ta.stochRsi` (0..1) flag stretch. `ta.ofi` is last-candle taker flow. `ta.markoutBps` is signed fill markout (negative = adverse). `ta.refMid` / `ta.refDivBps` is Coinbase vs Kuru (positive = Kuru rich). Taker flow (`trades.cvdMon`, `recentTrades`) confirms. `depth` and `book` show near-touch liquidity. If `allowed.buy` is false the trade will be a sell regardless, and vice versa.",
    },
    criteria: {
      buy: "Buy MON now: mid more likely to be higher after `horizonBlocks` blocks, by more than the spread.",
      sell: "Sell MON now: mid more likely to be lower after `horizonBlocks` blocks, by more than the spread.",
    },
  },
} as const;

/** Real Jev via the AI SDK. Gateway when AI_GATEWAY_API_KEY is set; else TypeSafe direct. */
export class JevModel implements Model {
  readonly name: string;
  private readonly model: ReturnType<typeof typeSafeAi.evaluationModel> | string;

  constructor() {
    if (config.aiGatewayApiKey) {
      this.name = config.jevGatewayModelId;
      this.model = config.jevGatewayModelId;
    } else {
      this.name = config.jevModelId;
      this.model = typeSafeAi.evaluationModel(config.jevModelId);
    }
  }

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: QUESTIONS, maxRetries: 0 });
    const a = r.answers.direction;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0, sell = p.sell ?? 0;
    return {
      action: a.choice as Action,
      probabilities: { buy, sell, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/** Deterministic stand-in: momentum + imbalance + mean reversion toward flat. */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: TradeState): Promise<Decision> {
    const t0 = performance.now();
    // momentum + book imbalance + noise, pulled back toward flat so it trades both ways
    const flow = state.trades.buyMon + state.trades.sellMon ? state.trades.cvdMon / (state.trades.buyMon + state.trades.sellMon) : 0;
    const ta = state.ta;
    const rsiPull = ta.rsi != null ? (50 - ta.rsi) / 25 : 0;
    const stoch = ta.stochRsi != null ? (0.5 - ta.stochRsi) * 2 : 0;
    const vwap = (ta.vwapDevBps ?? 0) / 12;
    const ema = ta.emaCross === "bull" ? 1.2 : ta.emaCross === "bear" ? -1.2 : (ta.emaGapBps ?? 0) / 8;
    const bookVol = ta.book.imbalance * 1.8;
    const signal = state.returnsBps.last20 / 8 + state.bookImbalance * 0.6 + flow * 1.4 + bookVol + ema - vwap + rsiPull + stoch + this.noise(state.block);
    const buy = 1 / (1 + Math.exp(-signal)); // binary softmax
    const probabilities = { buy, sell: 1 - buy, hold: 0 };
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    await Bun.sleep(80); // stand in for inference time so the pipeline behaves like production
    return {
      action, probabilities,
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  private noise(block: number) {
    let h = block * 2654435761 >>> 0;
    h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
    return ((h % 1000) / 1000 - 0.5) * 3;
  }
}

export const createModel = (): Model => (config.model === "jev" ? new JevModel() : new MockModel());
