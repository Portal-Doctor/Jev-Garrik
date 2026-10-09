import { expect, test } from "bun:test";
import { config } from "../cb/config";
import { ENABLED_PAIRS, JEV_USD_PER_MTOK } from "./src/config";
import { blankAllocator } from "./src/allocator";
import {
  applyStagePolicy,
  buildPacket,
  costUsdFromTokens,
  JevReviewService,
  type JevRaw,
  type JevReview,
  type PacketInput,
} from "./src/jev";
import { freshBook, PaperSession } from "./src/pipeline";
import type { Candidate } from "./src/rules";
import { MemoryStore } from "./src/store";

const NOW = Date.parse("2026-10-07T15:00:00.000Z");

function labels(): JevRaw["labels"] {
  return { regime: "balance", direction_bias: "flat", toxic_flow: "low", liquidity_stress: "normal" };
}

function candidate(id = "UNI-USD|A|1", patch: Partial<Candidate> = {}): Candidate {
  return {
    id,
    pair: "UNI-USD",
    setup: "A",
    barTs: NOW - 300_000,
    side: "long",
    entry: 100,
    stop: 94,
    signalClose: 100,
    atr: 1,
    rsi: 50,
    originatedFromSentiment: false,
    ...patch,
  };
}

function packet(id = "UNI-USD|A|1"): PacketInput {
  return {
    asOf: NOW,
    pair: "UNI-USD",
    setup: "A",
    barTs: NOW - 300_000,
    candidateId: id,
    biasUp: true,
    close: 100,
    stop: 94,
    atr: 1,
    rsi: 50,
    vwap: 99,
    sentiment: "clear",
    barTsList: [NOW - 300_000],
  };
}

function session(jev: JevReviewService | null, jevOff: boolean, stage: 0 | 1 | 2 = 0) {
  return new PaperSession({
    stage,
    jev,
    store: new MemoryStore(),
    state: blankAllocator("POOL", "equal"),
    book: freshBook(ENABLED_PAIRS, "clear"),
    enabledPairs: ENABLED_PAIRS,
    atrByPair: Object.fromEntries(ENABLED_PAIRS.map((p) => [p, 1])),
    jevOff,
  });
}

test("jevUsdPerMTok matches cb/config.ts", () => {
  expect(JEV_USD_PER_MTOK).toBe(0.042);
  expect(JEV_USD_PER_MTOK).toBe(config.jevUsdPerMTok);
});

test("token cost is usage times jevUsdPerMTok and the service hard-stops at $100", async () => {
  const tokens = Math.ceil((100 / JEV_USD_PER_MTOK) * 1_000_000);
  expect(costUsdFromTokens(tokens)).toBeGreaterThanOrEqual(100);
  let calls = 0;
  const jev = new JevReviewService(
    {
      async review(): Promise<JevRaw> {
        calls += 1;
        return { model: "jev-latest", verdict: "approve", rationale: "ok", labels: labels(), inputTokens: tokens, outputTokens: 0 };
      },
    },
    { stage: 1, pinnedModel: "jev-latest" },
  );
  const first = await jev.review(packet("a"), NOW);
  expect(first.costUsd).toBeGreaterThanOrEqual(100);
  expect(first.applied).toBe(false);
  expect(jev.budgetOpen("2026-10")).toBe(false);
  const second = await jev.review(packet("b"), NOW);
  expect(second.status).toBe("budget_hit");
  expect(second.applied).toBe(false);
  expect(calls).toBe(1);
  expect(jev.calls).toBe(1);
});

test("budget hit never adds a trade the rules rejected", async () => {
  const jev = new JevReviewService(
    {
      async review(): Promise<JevRaw> {
        return { model: "jev-latest", verdict: "approve", rationale: "ok", labels: labels(), inputTokens: 1, outputTokens: 1 };
      },
    },
    { stage: 1, pinnedModel: "jev-latest" },
  );
  jev.spendByMonth.set("2026-10", 100);
  const s = session(jev, false, 1);
  const bad = candidate("tight", { stop: 99 });
  const admission = await s.consider(bad, packet("tight"), NOW);
  expect(jev.calls).toBe(0);
  expect(admission.admitted).toBe(false);
  expect(admission.jevStatus).toBe("budget_hit");
  expect(s.opts.state.total).toBe(0);
});

test("outage, timeout, and bad JSON never add a trade the rules rejected", async () => {
  const cases: Array<{ name: string; review: () => Promise<JevRaw> }> = [
    {
      name: "outage",
      review: async () => {
        throw new Error("socket hang up");
      },
    },
    {
      name: "timeout",
      review: () =>
        new Promise<JevRaw>((resolve) => {
          setTimeout(
            () =>
              resolve({
                model: "jev-latest",
                verdict: "approve",
                rationale: "late",
                labels: labels(),
                inputTokens: 1,
                outputTokens: 1,
              }),
            200,
          );
        }),
    },
    {
      name: "bad_json",
      review: async () => ({ model: "jev-latest", verdict: "yolo" }),
    },
  ];
  for (const item of cases) {
    const jev = new JevReviewService({ review: item.review }, { stage: 1, pinnedModel: "jev-latest", timeoutMs: 30 });
    const s = session(jev, false, 1);
    const bad = candidate(`${item.name}`, { stop: 99, side: "short" });
    const admission = await s.consider(bad, packet(item.name), NOW);
    expect(admission.admitted).toBe(false);
    expect(s.opts.state.total).toBe(0);
    expect(["outage", "timeout", "bad_json"]).toContain(admission.jevStatus);
  }
});

test("a stage 0 run admits the same candidate as a Jev-off run", async () => {
  const veto: JevRaw = { model: "jev-latest", verdict: "veto", rationale: "no", labels: labels(), inputTokens: 5, outputTokens: 5 };
  const jev = new JevReviewService({ async review() { return veto; } }, { stage: 0, pinnedModel: "jev-latest" });
  const shadow = session(jev, false, 0);
  const off = session(null, true, 0);
  const c = candidate();
  const a = await shadow.consider(c, packet(), NOW);
  const b = await off.consider({ ...c, id: "UNI-USD|A|1" }, packet(), NOW);
  expect(a.admitted).toBe(true);
  expect(b.admitted).toBe(true);
  expect(a.failed).toEqual(b.failed);
  expect(shadow.opts.state.total).toBe(off.opts.state.total);
  const review = await jev.review(packet("other"), NOW);
  expect(review.applied).toBe(false);
  expect(review.verdict).toBe("veto");
});

test("a model version change drops the stage to 0 and does not apply the veto", async () => {
  const jev = new JevReviewService(
    {
      async review(): Promise<JevRaw> {
        return { model: "jev-next", verdict: "veto", rationale: "changed", labels: labels(), inputTokens: 8, outputTokens: 8 };
      },
    },
    { stage: 2, pinnedModel: "jev-a" },
  );
  jev.scorecard.samples = 12;
  const review = await jev.review(packet(), NOW);
  expect(jev.stage).toBe(0);
  expect(review.status).toBe("model_version_change");
  expect(review.applied).toBe(false);
  expect(jev.scorecard.samples).toBe(0);
  expect(jev.scorecard.resetAt).toBe(NOW);
  const s = session(jev, false, 0);
  const admission = await s.consider(candidate(), packet("after"), NOW);
  expect(admission.admitted).toBe(true);
});

test("lookahead bars are rejected by the packet builder", () => {
  expect(() => buildPacket({ ...packet(), barTsList: [NOW + 60_000] })).toThrow("lookahead");
});

test("stage 2 ranks qualified names and cannot add an unqualified one", () => {
  const a = candidate("A|A|1", { pair: "AAA-USD", barTs: 1 });
  const b = candidate("B|A|1", { pair: "BBB-USD", barTs: 1 });
  const reviews = new Map<string, JevReview>([
    [a.id, review(a.id, "rank", 0.2, true)],
    [b.id, review(b.id, "rank", 0.9, true)],
  ]);
  expect(applyStagePolicy([a, b], reviews, 2, 1).map((c) => c.id)).toEqual([b.id]);
  expect(applyStagePolicy([a, b], reviews, 0, 1).map((c) => c.id)).toEqual([a.id]);
  const vetoed = new Map<string, JevReview>([[b.id, review(b.id, "veto", null, true)]]);
  expect(applyStagePolicy([a, b], vetoed, 1, 2).map((c) => c.id)).toEqual([a.id]);
  expect(applyStagePolicy([a], reviews, 2, 1).some((c) => c.id === "not-qualified")).toBe(false);
});

function review(id: string, verdict: "approve" | "veto" | "rank", rankScore: number | null, applied: boolean): JevReview {
  return {
    candidateId: id,
    model: "jev-latest",
    promptHash: "p",
    inputHash: id,
    verdict,
    rankScore,
    labels: { regime: "balance", direction_bias: "flat", toxic_flow: "low", liquidity_stress: "normal" },
    rationale: "",
    latencyMs: 1,
    costUsd: 0,
    tokens: 0,
    status: "ok",
    jevStageAtTime: applied ? 2 : 0,
    applied,
    month: "2026-10",
  };
}
