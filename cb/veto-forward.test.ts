import { expect, test } from "bun:test";
import { buildHoldTrendMix, buildHoldTrendWindow, toxicVetoCall, type HoldTrendForward } from "./report";

const fwd = (vetoedN: number, vetoedBps: number | null, clearN: number, clearBps: number | null): HoldTrendForward => ({
  vetoedN,
  vetoedBps,
  clearN,
  clearBps,
});

const decision = (id: string, ts: number, gate: Record<string, unknown>) => ({ id, run_id: "r1", ts, state: { gate } });

const toxicGate = (toxicVeto: boolean, stressVeto = false) => ({
  approved: !toxicVeto && !stressVeto,
  reason: toxicVeto ? "toxic flow" : null,
  toxicVeto,
  toxicSource: "jev",
  stressVeto,
  stressSource: "jev",
});

test("no sample when either side of the comparison is empty", () => {
  expect(toxicVetoCall(fwd(0, null, 0, null), fwd(0, null, 0, null))).toBe("no sample");
  expect(toxicVetoCall(fwd(5, -10, 0, null), fwd(5, -10, 0, null))).toBe("no sample");
  expect(toxicVetoCall(fwd(0, null, 5, 10), fwd(0, null, 5, 10))).toBe("no sample");
});

test("vetoed worse only when the vetoed mean is below clear at both horizons", () => {
  expect(toxicVetoCall(fwd(10, -30, 40, 12), fwd(10, -5, 40, 20))).toBe("vetoed worse");
});

test("vetoed not worse when the veto fails at either horizon", () => {
  expect(toxicVetoCall(fwd(10, -30, 40, 12), fwd(10, 25, 40, 20))).toBe("vetoed not worse");
  expect(toxicVetoCall(fwd(10, 30, 40, 12), fwd(10, -5, 40, 20))).toBe("vetoed not worse");
});

test("a tie is not worse, so the veto does not earn its keep", () => {
  expect(toxicVetoCall(fwd(10, 12, 40, 12), fwd(10, 20, 40, 20))).toBe("vetoed not worse");
});

test("one horizon with a sample still produces a call", () => {
  expect(toxicVetoCall(fwd(3, -40, 9, 5), fwd(0, null, 0, null))).toBe("vetoed worse");
  expect(toxicVetoCall(fwd(3, 40, 9, 5), fwd(0, null, 0, null))).toBe("vetoed not worse");
});

test("a stress veto does not count a decision as toxic vetoed", () => {
  const w = buildHoldTrendWindow({
    notionalUsd: 600,
    decisions: [
      decision("toxic", 1, toxicGate(true)),
      decision("stress", 2, toxicGate(false, true)),
      decision("clear", 3, toxicGate(false)),
    ],
    fills: [],
    outcomes: [
      { decision_id: "toxic", horizon_sec: 3600, move_bps: -50 },
      { decision_id: "stress", horizon_sec: 3600, move_bps: 100 },
      { decision_id: "clear", horizon_sec: 3600, move_bps: 10 },
      { decision_id: "toxic", horizon_sec: 14400, move_bps: -20 },
      { decision_id: "stress", horizon_sec: 14400, move_bps: 60 },
      { decision_id: "clear", horizon_sec: 14400, move_bps: 40 },
    ],
  });
  // The stress-vetoed decision sits on the toxic-clear side, pulling the clear mean up.
  expect(w.forwardH1.vetoedN).toBe(1);
  expect(w.forwardH1.vetoedBps).toBe(-50);
  expect(w.forwardH1.clearN).toBe(2);
  expect(w.forwardH1.clearBps).toBe(55);
  // And it appears on the vetoed side of the stress table.
  expect(w.stressForwardH1.vetoedN).toBe(1);
  expect(w.stressForwardH1.vetoedBps).toBe(100);
  expect(w.stressForwardH1.clearN).toBe(2);
  expect(w.toxicCall).toBe("vetoed worse");
});

test("a toxic veto that is followed by a better move than clear reads not worse", () => {
  const w = buildHoldTrendWindow({
    notionalUsd: 600,
    decisions: [decision("toxic", 1, toxicGate(true)), decision("clear", 2, toxicGate(false))],
    fills: [],
    outcomes: [
      { decision_id: "toxic", horizon_sec: 3600, move_bps: 30 },
      { decision_id: "clear", horizon_sec: 3600, move_bps: 5 },
      { decision_id: "toxic", horizon_sec: 14400, move_bps: 12 },
      { decision_id: "clear", horizon_sec: 14400, move_bps: 44 },
    ],
  });
  expect(w.toxicCall).toBe("vetoed not worse");
});

test("the mix carries a 7 day block beside the run and the last 24 hours", () => {
  const now = 10 * 86_400_000;
  const mix = buildHoldTrendMix({
    notionalUsd: 600,
    now,
    runId: "r1",
    decisions: [
      // Older than 7 days: only the run window sees it.
      decision("old", now - 8 * 86_400_000, toxicGate(true)),
      // Inside 7 days but older than 24 hours.
      decision("week", now - 3 * 86_400_000, toxicGate(true)),
      decision("day", now - 3_600_000, toxicGate(false)),
    ],
    fills: [],
    outcomes: [
      { decision_id: "old", horizon_sec: 3600, move_bps: -90 },
      { decision_id: "week", horizon_sec: 3600, move_bps: -40 },
      { decision_id: "day", horizon_sec: 3600, move_bps: 20 },
    ],
  });
  expect(mix.run.decisions).toBe(3);
  expect(mix.last7d.decisions).toBe(2);
  expect(mix.last24h.decisions).toBe(1);
  expect(mix.last7d.forwardH1.vetoedBps).toBe(-40);
  expect(mix.last7d.forwardH1.clearBps).toBe(20);
  expect(mix.run.forwardH1.vetoedBps).toBe(-65);
  // The 24 hour block has only a clear decision, so there is nothing to compare.
  expect(mix.last24h.toxicCall).toBe("no sample");
});
