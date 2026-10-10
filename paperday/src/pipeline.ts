/**
 * The only admission path. Jev may run first. Overrides always run after, even if a caller
 * sets skipOverrides on the candidate. Allocation happens only after every override passes,
 * and the reserve itself refuses over-commit.
 */

import { DEPLOYABLE_USD, RESERVE_USD, STARTING_BUDGET_USD, type JevStage } from "./config";
import { reserve, shareFor, type ReserveState } from "./allocator";
import { evaluateOverrides, type OverrideBook, type OverrideCandidate, type OverrideResult } from "./overrides";
import { applyStagePolicy, type JevReview, type JevReviewService, type PacketInput } from "./jev";
import type { Candidate } from "./rules";
import { MemoryStore } from "./store";

export interface Admission {
  admitted: boolean;
  failed: string[];
  overrides: OverrideResult;
  reserved: boolean;
  jevStatus: string | null;
}

export interface SessionOpts {
  stage: JevStage;
  jev: JevReviewService | null;
  store: MemoryStore;
  state: ReserveState;
  book: OverrideBook;
  enabledPairs: readonly string[];
  atrByPair: Record<string, number>;
  /** When true, skip the transport entirely (jev_off). */
  jevOff: boolean;
}

function toOverride(c: Candidate & { side?: "long" | "short"; addOn?: boolean; skipOverrides?: boolean }): OverrideCandidate {
  return {
    pair: c.pair,
    setup: c.setup,
    side: c.side ?? "long",
    barTs: c.barTs,
    entry: c.entry,
    stop: c.stop,
    signalClose: c.signalClose,
    atr: c.atr,
    rsi: c.rsi,
    originatedFromSentiment: c.originatedFromSentiment,
    addOn: c.addOn,
    plannedTargetBps: c.plannedTargetBps,
    entryProfile: c.entryProfile,
    lossToStopUsd: c.lossToStopUsd,
  };
}

export class PaperSession {
  opts: SessionOpts;

  constructor(opts: SessionOpts) {
    this.opts = opts;
  }

  proposedNotional(pair: string): number {
    return shareFor(this.opts.state, pair, this.opts.enabledPairs, this.opts.atrByPair);
  }

  /**
   * Admit one already-qualified candidate. Overrides are unconditional.
   * `skipOverrides` is ignored on purpose: it is the bypass attempt the tests send.
   */
  submit(
    candidate: Candidate & { side?: "long" | "short"; addOn?: boolean; skipOverrides?: boolean },
    nowMs: number,
  ): Admission {
    const notional = this.proposedNotional(candidate.pair);
    const overrides = evaluateOverrides(toOverride(candidate), this.opts.book, notional, nowMs);
    this.opts.store.put("candidates", candidate.id, { ...candidate, nowMs });
    this.opts.store.put("override_checks", `${candidate.id}|${nowMs}`, {
      candidateId: candidate.id,
      pass: overrides.pass,
      failed: overrides.failed,
      checks: overrides.checks,
    });
    if (!overrides.pass) {
      this.opts.store.put("ideas", candidate.id, { take: false, reason: overrides.failed.join(","), candidateId: candidate.id });
      return { admitted: false, failed: overrides.failed, overrides, reserved: false, jevStatus: null };
    }
    const reserved = reserve(this.opts.state, candidate.pair, notional, {
      enabledPairs: this.opts.enabledPairs,
      atrByPair: this.opts.atrByPair,
      allocatableUsd: this.opts.book.allocatableUsd,
    });
    this.opts.store.put("allocations", `${candidate.id}|${nowMs}`, {
      pair: candidate.pair,
      amount: notional,
      ok: reserved.ok,
      reason: reserved.reason,
      mode: this.opts.state.mode,
      total: reserved.state.total,
    });
    if (!reserved.ok) {
      this.opts.store.put("ideas", candidate.id, { take: false, reason: reserved.reason, candidateId: candidate.id });
      return { admitted: false, failed: [reserved.reason], overrides, reserved: false, jevStatus: null };
    }
    this.opts.state = reserved.state;
    this.opts.book = {
      ...this.opts.book,
      openNotionalUsd: this.opts.book.openNotionalUsd + notional,
      allocatableUsd: Math.max(0, this.opts.book.allocatableUsd - notional),
      restingCount: this.opts.book.restingCount + 1,
      ideasTodayCt: this.opts.book.ideasTodayCt + 1,
      openPairs: this.opts.book.openPairs.includes(candidate.pair) ? this.opts.book.openPairs : [...this.opts.book.openPairs, candidate.pair],
    };
    this.opts.store.put("ideas", candidate.id, { take: true, reason: "admitted", candidateId: candidate.id, notional });
    return { admitted: true, failed: [], overrides, reserved: true, jevStatus: null };
  }

  async consider(
    candidate: Candidate & { side?: "long" | "short"; addOn?: boolean; skipOverrides?: boolean },
    packet: PacketInput,
    nowMs: number,
  ): Promise<Admission> {
    if (this.opts.jevOff || !this.opts.jev) {
      return this.submit(candidate, nowMs);
    }
    const review = await this.opts.jev.review(packet, nowMs);
    this.opts.store.put("jev_reviews", `${candidate.id}|${review.inputHash}|${review.status}`, { ...review });
    const stage = this.opts.jev.stage;
    const cuts = review.applied && review.verdict === "veto" && stage >= 1;
    if (cuts) {
      this.opts.store.put("ideas", candidate.id, { take: false, reason: "jev_veto", candidateId: candidate.id });
      const overrides = evaluateOverrides(toOverride(candidate), this.opts.book, this.proposedNotional(candidate.pair), nowMs);
      this.opts.store.put("override_checks", `${candidate.id}|${nowMs}`, {
        candidateId: candidate.id,
        pass: false,
        failed: ["jev_veto"],
        checks: overrides.checks,
      });
      return { admitted: false, failed: ["jev_veto"], overrides, reserved: false, jevStatus: review.status };
    }
    const admission = this.submit(candidate, nowMs);
    return { ...admission, jevStatus: review.status };
  }
}

export function selectForRoom(
  qualified: Candidate[],
  reviews: Map<string, JevReview>,
  stage: JevStage,
  room: number,
): Candidate[] {
  return applyStagePolicy(qualified, reviews, stage, room);
}

export function freshBook(enabledPairs: readonly string[], sentiment: OverrideBook["sentiment"] = "clear"): OverrideBook {
  return {
    openPairs: [],
    openCount: 0,
    restingCount: 0,
    ideasTodayCt: 0,
    lossesTodayUtc: 0,
    rTodayUtc: 0,
    realizedUsdTodayUtc: 0,
    pairLossUsd: {},
    equityUsd: STARTING_BUDGET_USD,
    openNotionalUsd: 0,
    allocatableUsd: STARTING_BUDGET_USD - RESERVE_USD,
    pairStop: {},
    pairEntry: {},
    sentiment,
    gapPairs: [],
    enabledPairs: [...enabledPairs],
    kill: false,
    paper: true,
    macroCalendarPresent: true,
  };
}

export { DEPLOYABLE_USD };
