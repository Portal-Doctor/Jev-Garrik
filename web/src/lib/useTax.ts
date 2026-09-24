"use client";

import { useEffect, useState } from "react";
import type { TaxReport } from "./taxTypes";

export type TaxStatus = "loading" | "ok" | "error";

export function useTax(apiUrl: string): {
  report: TaxReport | null;
  status: TaxStatus;
  updatedAt: number | null;
  refresh: () => void;
} {
  const [report, setReport] = useState<TaxReport | null>(null);
  const [status, setStatus] = useState<TaxStatus>("loading");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const base = apiUrl.replace(/\/+$/, "");
    const load = async () => {
      try {
        const res = await fetch(`${base}/tax`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as TaxReport;
        if (alive) {
          setReport(data);
          setStatus("ok");
          setUpdatedAt(Date.now());
        }
      } catch {
        if (alive) setStatus((s) => (s === "loading" ? "error" : s));
      }
    };
    load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [apiUrl, nonce]);

  return { report, status, updatedAt, refresh: () => setNonce((n) => n + 1) };
}
