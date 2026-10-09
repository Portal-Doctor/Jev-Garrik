import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ENABLED_PAIRS } from "./src/config";
import { evaluateOverrides, OVERRIDE_RULES, payoffAt5090, type OverrideBook, type OverrideCandidate } from "./src/overrides";
import { blankAllocator } from "./src/allocator";
import { freshBook, PaperSession } from "./src/pipeline";
import { MemoryStore } from "./src/store";
import { JevReviewService, type JevRaw, type PacketInput } from "./src/jev";
import type { Candidate } from "./src/rules";

const NOW = Date.parse("2026-10-07T15:00:00.000Z");

function book(patch: Partial<OverrideBook> = {}): OverrideBook {
  return { ...freshBook(ENABLED_PAIRS, "clear"), ...patch };
}

function candidate(patch: Partial<OverrideCandidate> = {}): OverrideCandidate {
  return {
    pair: "UNI-USD",
    setup: "A",
    side: "long",
    barTs: NOW - 300_000,
    entry: 100,
    stop: 94,
    signalClose: 100,
    atr: 1,
    rsi: 50,
    originatedFromSentiment: false,
    ...patch,
  };
}

function failed(patchBook: Partial<OverrideBook>, patchCandidate: Partial<OverrideCandidate> = {}, notional = 1000, now = NOW) {
  return evaluateOverrides(candidate(patchCandidate), book(patchBook), notional, now);
}

test("base candidate passes every hard override", () => {
  const result = failed({});
  expect(result.pass).toBe(true);
  expect(result.failed).toEqual([]);
  expect(result.checks.map((c) => c.rule)).toEqual([...OVERRIDE_RULES]);
});

test("fee_gate requires the 3R winner to be at least twice the loser after 50/90", () => {
  const exact = payoffAt5090(100, 95.8);
  expect(exact.stopBps).toBeCloseTo(420, 6);
  expect(exact.pass).toBe(true);
  const tight = payoffAt5090(100, 95.81);
  expect(tight.pass).toBe(false);
  const result = failed({}, { stop: 99 });
  expect(result.failed).toContain("fee_gate");
});

test("daily_two_losses halts at two losing closes", () => {
  expect(failed({ lossesTodayUtc: 1 }).pass).toBe(true);
  expect(failed({ lossesTodayUtc: 2 }).failed).toContain("daily_two_losses");
});

test("daily_minus_2r halts at -2R", () => {
  expect(failed({ rTodayUtc: -1.99 }).pass).toBe(true);
  expect(failed({ rTodayUtc: -2 }).failed).toContain("daily_minus_2r");
});

test("daily_loss_halt trips at -$900", () => {
  expect(failed({ realizedUsdTodayUtc: -899.99 }).pass).toBe(true);
  expect(failed({ realizedUsdTodayUtc: -900 }).failed).toContain("daily_loss_halt");
});

test("kill_switch blocks new entries", () => {
  expect(failed({ kill: true }).failed).toContain("kill_switch");
});

test("long_only rejects a short", () => {
  expect(failed({}, { side: "short" }).failed).toContain("long_only");
});

test("flat_before_utc_midnight blocks the last hour of the UTC day", () => {
  const late = Date.parse("2026-10-07T23:30:00.000Z");
  expect(failed({}, {}, 1000, late).failed).toContain("flat_before_utc_midnight");
  const midday = Date.parse("2026-10-07T22:30:00.000Z");
  expect(failed({}, {}, 1000, midday).failed).not.toContain("flat_before_utc_midnight");
});

test("one_per_pair blocks a second idea on an open pair", () => {
  expect(failed({ openPairs: ["UNI-USD"] }).failed).toContain("one_per_pair");
});

test("max_concurrent stops at two", () => {
  expect(failed({ openCount: 1, restingCount: 0 }).pass).toBe(true);
  expect(failed({ openCount: 2 }).failed).toContain("max_concurrent");
  expect(failed({ openCount: 1, restingCount: 1 }).failed).toContain("max_concurrent");
});

test("ideas_per_day is 3 on a weekday and 2 on a weekend", () => {
  expect(failed({ ideasTodayCt: 2 }).pass).toBe(true);
  expect(failed({ ideasTodayCt: 3 }).failed).toContain("ideas_per_day");
  const saturday = Date.parse("2026-10-10T15:00:00.000Z");
  expect(failed({ ideasTodayCt: 1 }, {}, 1000, saturday).pass).toBe(true);
  expect(failed({ ideasTodayCt: 2 }, {}, 1000, saturday).failed).toContain("ideas_per_day");
});

test("total_cap refuses notional above deployable room or the allocatable cash above the reserve", () => {
  expect(failed({ allocatableUsd: 8000, openNotionalUsd: 0 }, {}, 8000).pass).toBe(true);
  expect(failed({ allocatableUsd: 8000, openNotionalUsd: 0 }, {}, 8000.01).failed).toContain("total_cap");
  expect(failed({ allocatableUsd: 7000, openNotionalUsd: 0 }, {}, 7001).failed).toContain("total_cap");
  expect(failed({ allocatableUsd: 8000, openNotionalUsd: 7500 }, {}, 1000).failed).toContain("total_cap");
});

test("no_stop_widening rejects a lower long stop", () => {
  expect(failed({ pairStop: { "UNI-USD": 90 } }, { stop: 94 }).pass).toBe(true);
  expect(failed({ pairStop: { "UNI-USD": 95 } }, { stop: 94 }).failed).toContain("no_stop_widening");
});

test("no_averaging_down rejects an add and a lower entry on an open pair", () => {
  expect(failed({}, { addOn: true }).failed).toContain("no_averaging_down");
  expect(failed({ openPairs: ["UNI-USD"], pairEntry: { "UNI-USD": 100 } }, { entry: 99, stop: 90 }).failed).toContain("no_averaging_down");
});

test("no_chasing rejects an extension beyond 1 ATR and RSI above 70", () => {
  expect(failed({}, { entry: 102, signalClose: 100, atr: 1 }).failed).toContain("no_chasing");
  expect(failed({}, { rsi: 71 }).failed).toContain("no_chasing");
});

test("disabled_pair is off", () => {
  expect(failed({ enabledPairs: ["NEAR-USD"] }).failed).toContain("disabled_pair");
});

test("x_veto_only blocks a sentiment veto and a sentiment-originated entry", () => {
  expect(failed({ sentiment: "veto" }).failed).toContain("x_veto_only");
  expect(failed({}, { originatedFromSentiment: true }).failed).toContain("x_veto_only");
  expect(failed({ sentiment: "clear" }).pass).toBe(true);
});

test("paper_only rejects anything that is not paper", () => {
  expect(failed({ paper: false }).failed).toContain("paper_only");
});

test("pair_loss_gate halts a pair at $500 of realized losses", () => {
  expect(failed({ pairLossUsd: { "UNI-USD": 499.99 } }).pass).toBe(true);
  expect(failed({ pairLossUsd: { "UNI-USD": 500 } }).failed).toContain("pair_loss_gate");
});

test("book_drawdown halts new entries at $8,000 from the starting $10,000", () => {
  expect(failed({ equityUsd: 2000.01 }).pass).toBe(true);
  expect(failed({ equityUsd: 2000 }).failed).toContain("book_drawdown");
});

test("outside_session blocks Chicago hours outside 08:00-15:00", () => {
  const early = Date.parse("2026-10-07T12:00:00.000Z");
  expect(failed({}, {}, 1000, early).failed).toContain("outside_session");
});

test("macro_blackout blocks the default 09:00 CT slot even inside the entry window", () => {
  const slot = Date.parse("2026-10-07T14:00:00.000Z");
  const result = failed({}, {}, 1000, slot);
  expect(result.failed).toContain("macro_blackout");
  expect(result.failed).not.toContain("outside_session");
});

test("data_gap blocks the pair", () => {
  expect(failed({ gapPairs: ["UNI-USD"] }).failed).toContain("data_gap");
});

test("sentiment_caution allows only setup A and one open idea", () => {
  expect(failed({ sentiment: "unknown" }, { setup: "B" }).failed).toContain("sentiment_caution");
  expect(failed({ sentiment: "unknown", openCount: 1 }, { setup: "A" }).failed).toContain("sentiment_caution");
  expect(failed({ sentiment: "unknown" }, { setup: "A" }).pass).toBe(true);
});

test("nothing upstream can bypass the override layer", () => {
  const store = new MemoryStore();
  const session = new PaperSession({
    stage: 2,
    jev: null,
    store,
    state: blankAllocator("POOL", "equal"),
    book: freshBook(ENABLED_PAIRS, "clear"),
    enabledPairs: ENABLED_PAIRS,
    atrByPair: { "UNI-USD": 1 },
    jevOff: true,
  });
  const bad = {
    ...asCandidate(candidate({ side: "short" })),
    skipOverrides: true,
  };
  const admission = session.submit(bad, NOW);
  expect(admission.admitted).toBe(false);
  expect(admission.failed).toContain("long_only");
  expect(session.opts.state.total).toBe(0);
  expect(store.count("override_checks")).toBe(1);
  expect(store.count("allocations")).toBe(0);
  expect(store.get("ideas", bad.id)?.take).toBe(false);
});

test("an approving Jev review still cannot skip a failed override", async () => {
  const jev = new JevReviewService(
    {
      async review(): Promise<JevRaw> {
        return {
          model: "jev-latest",
          verdict: "approve",
          rationale: "approve",
          labels: { regime: "expansion", direction_bias: "long", toxic_flow: "low", liquidity_stress: "normal" },
          inputTokens: 10,
          outputTokens: 10,
        };
      },
    },
    { stage: 2, pinnedModel: "jev-latest" },
  );
  const store = new MemoryStore();
  const session = new PaperSession({
    stage: 2,
    jev,
    store,
    state: blankAllocator("POOL", "equal"),
    book: freshBook(ENABLED_PAIRS, "clear"),
    enabledPairs: ENABLED_PAIRS,
    atrByPair: { "UNI-USD": 1 },
    jevOff: false,
  });
  const bad = asCandidate(candidate({ side: "short", stop: 99 }));
  const packet: PacketInput = {
    asOf: NOW,
    pair: bad.pair,
    setup: bad.setup,
    barTs: bad.barTs,
    candidateId: bad.id,
    biasUp: true,
    close: bad.entry,
    stop: bad.stop,
    atr: bad.atr,
    rsi: bad.rsi,
    vwap: 1,
    sentiment: "clear",
    barTsList: [bad.barTs],
  };
  const admission = await session.consider(bad, packet, NOW);
  expect(admission.admitted).toBe(false);
  expect(admission.failed).toContain("long_only");
  expect(session.opts.state.total).toBe(0);
  expect(store.count("allocations")).toBe(0);
});

test("paperday source does not call classifyDeterministic or an order endpoint", () => {
  const dir = join(import.meta.dir, "src");
  const files = readdirSync(dir).filter((n) => n.endsWith(".ts"));
  const text = files.map((n) => readFileSync(join(dir, n), "utf8")).join("\n");
  expect(text.includes("classifyDeterministic")).toBe(false);
  expect(text.includes("/api/v3/brokerage/orders")).toBe(false);
  expect(text.includes("placeOrder")).toBe(false);
  expect(text.includes('channel: "user"') || text.includes("channel: 'user'")).toBe(false);
});

function asCandidate(c: OverrideCandidate): Candidate & { side: "long" | "short"; skipOverrides?: boolean } {
  return {
    id: `${c.pair}|${c.setup}|${c.barTs}`,
    pair: c.pair,
    setup: c.setup,
    barTs: c.barTs,
    side: c.side,
    entry: c.entry,
    stop: c.stop,
    signalClose: c.signalClose,
    atr: c.atr,
    rsi: c.rsi,
    originatedFromSentiment: c.originatedFromSentiment,
  };
}
