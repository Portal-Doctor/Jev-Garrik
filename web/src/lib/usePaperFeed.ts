"use client";

import { useEffect, useReducer } from "react";
import type {
  ConnectionState,
  DecisionEvent,
  FillEvent,
  LastDecision,
  PaperMeta,
  PaperPosition,
  PaperState,
  PairFeedState,
  Snapshot,
  Tick,
} from "./paperTypes";

/** Max recent decisions / fills kept in memory (newest first). */
const CAP = 200;
const BACKOFF_MIN = 1000;
const BACKOFF_MAX = 10_000;
/** Server pings every 15s; force a reconnect if nothing arrives for this long. */
const STALE_MS = 45_000;

type Action =
  | { type: "snapshot"; meta: PaperMeta; snapshot: Snapshot }
  | { type: "tick"; ticks: Tick[] }
  | { type: "decision"; decision: DecisionEvent }
  | { type: "fill"; fill: FillEvent }
  | { type: "equity"; positions: PaperPosition[] }
  | { type: "connection"; connection: ConnectionState };

const initialState: PaperState = {
  meta: null,
  feed: {},
  positions: {},
  lastDecision: {},
  recentDecisions: [],
  recentFills: [],
  connection: "connecting",
};

const byPair = <T extends { pair: string }>(rows: T[]): Record<string, T> =>
  Object.fromEntries(rows.map((r) => [r.pair, r]));

function reducer(state: PaperState, action: Action): PaperState {
  switch (action.type) {
    case "connection":
      return state.connection === action.connection ? state : { ...state, connection: action.connection };

    case "snapshot": {
      const s = action.snapshot;
      return {
        ...state,
        meta: action.meta,
        feed: byPair(s.pairs ?? []),
        positions: byPair(s.positions ?? []),
        lastDecision: byPair(s.decisions ?? []),
        connection: "live",
      };
    }

    case "tick": {
      const feed = { ...state.feed };
      for (const t of action.ticks) {
        const prev = feed[t.pair] ?? ({ pair: t.pair } as PairFeedState);
        feed[t.pair] = { ...prev, mid: t.mid, spreadBps: t.spreadBps };
      }
      return { ...state, feed };
    }

    case "decision": {
      const d = action.decision;
      const last: LastDecision = { pair: d.pair, action: d.action, pBuy: d.pBuy, mid: d.mid };
      return {
        ...state,
        lastDecision: { ...state.lastDecision, [d.pair]: last },
        recentDecisions: [d, ...state.recentDecisions].slice(0, CAP),
      };
    }

    case "fill":
      return { ...state, recentFills: [action.fill, ...state.recentFills].slice(0, CAP) };

    case "equity":
      return { ...state, positions: { ...state.positions, ...byPair(action.positions) } };

    default:
      return state;
  }
}

/**
 * Live paper-trading feed over SSE. Connects to `${apiUrl}/events` and handles: `snapshot`
 * (meta + feed/positions/last decisions), `tick` (per-second mids), `decision`, `fill`, `equity`
 * (per-minute position marks) and `ping`. Reconnects with a 1s -> 10s backoff.
 */
export function usePaperFeed(apiUrl: string): PaperState {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    const base = (apiUrl || "").replace(/\/+$/, "");

    let closed = false;
    let attempt = 0;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let staleTimer: ReturnType<typeof setTimeout> | undefined;

    const armStale = () => {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (!closed) scheduleReconnect();
      }, STALE_MS);
    };

    const teardown = () => {
      if (es) {
        es.onopen = null;
        es.onerror = null;
        es.close();
        es = null;
      }
      if (staleTimer) clearTimeout(staleTimer);
    };

    const scheduleReconnect = () => {
      if (closed) return;
      teardown();
      dispatch({ type: "connection", connection: "reconnecting" });
      const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** attempt);
      attempt++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, delay);
    };

    const handle = (type: string, fn: (data: unknown) => void) => {
      es?.addEventListener(type, (raw: Event) => {
        armStale();
        const payload = (raw as MessageEvent).data;
        if (typeof payload !== "string" || !payload) return;
        try {
          fn(JSON.parse(payload));
        } catch {
          /* ignore malformed frame */
        }
      });
    };

    function connect() {
      if (closed) return;
      dispatch({ type: "connection", connection: attempt === 0 ? "connecting" : "reconnecting" });
      es = new EventSource(`${base}/events`);

      es.onopen = () => {
        attempt = 0;
        dispatch({ type: "connection", connection: "live" });
        armStale();
      };
      es.onerror = () => {
        if (!closed) scheduleReconnect();
      };

      handle("snapshot", (data) => {
        const d = (data ?? {}) as Record<string, unknown>;
        const meta: PaperMeta = {
          runId: String(d.runId ?? ""),
          mode: (d.mode as PaperMeta["mode"]) ?? "paper",
          model: String(d.model ?? ""),
          pairs: Array.isArray(d.pairs) ? (d.pairs as string[]) : [],
          startedAt: typeof d.startedAt === "number" ? d.startedAt : Date.now(),
        };
        const snapshot = (d.snapshot ?? { pairs: [], positions: [], decisions: [] }) as Snapshot;
        dispatch({ type: "snapshot", meta, snapshot });
      });
      handle("tick", (data) => {
        if (Array.isArray(data)) dispatch({ type: "tick", ticks: data as Tick[] });
      });
      handle("decision", (data) => dispatch({ type: "decision", decision: data as DecisionEvent }));
      handle("fill", (data) => dispatch({ type: "fill", fill: data as FillEvent }));
      handle("equity", (data) => {
        if (Array.isArray(data)) dispatch({ type: "equity", positions: data as PaperPosition[] });
      });
      handle("ping", () => dispatch({ type: "connection", connection: "live" }));
    }

    connect();

    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      teardown();
    };
  }, [apiUrl]);

  return state;
}

export default usePaperFeed;
