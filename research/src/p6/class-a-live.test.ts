import { expect, test } from "bun:test";
import { CLASS_A_PAPER_START_MS } from "./class-a-paper";
import { captureHot, loadSplit, persistSplit } from "./hot-store";
import { acceptRestBar, startPaperHost } from "./paper-host";
import { decodeLease, LEASE_KEY, memoryKv, tryAcquire } from "./relay";
import { hostHolder } from "./vercel-live";

const DAY = 86_400;

test("the production bar path records the signal at the start and keeps it across a reload", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  try {
    for (const flag of ["0", "1"] as const) {
      process.env.P6_GZIP_WRITES = flag;
      const kv = memoryKv(() => CLASS_A_PAPER_START_MS);
      const host = startPaperHost(["SOL-USD", "BTC-USD"], {});
      host.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(host, kv).warm();
      expect(host.classAPaper?.startMs).toBe(CLASS_A_PAPER_START_MS);
      const signalDay = Date.parse("2026-10-25T00:00:00.000Z");
      const first = signalDay - 110 * DAY * 1000;
      for (let i = 0; i <= 110; i += 1) {
        const openMs = first + i * DAY * 1000;
        const openSec = openMs / 1000;
        const close = i === 110 ? 100.05 : 100;
        host.clock = () => openMs + 15 * 60 * 1000;
        expect(acceptRestBar(host, { productId: "SOL-USD", startSec: openSec, open: close, high: close + 0.05, low: close - 0.05, close, volume: 0 })).toBe("accepted");
        host.clock = () => openMs + DAY * 1000;
        expect(acceptRestBar(host, { productId: "SOL-USD", startSec: openSec + DAY - 900, open: close, high: close + 0.05, low: close - 0.05, close, volume: 100_000 })).toBe("accepted");
      }
      const prior = Date.parse("2026-10-25T00:00:00.000Z");
      expect(host.classAPaper?.rows.some((row) => row.signalMs === prior)).toBe(false);
      const row = host.classAPaper?.rows.find((item) => item.signalMs === CLASS_A_PAPER_START_MS);
      expect(row?.pair).toBe("SOL-USD");
      expect(row?.skipReason).toBe("skip_btcveto");
      expect(await tryAcquire(kv, `live-${flag}`, CLASS_A_PAPER_START_MS + DAY * 1000, CLASS_A_PAPER_START_MS)).toBe(true);
      host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
      host.clock = () => CLASS_A_PAPER_START_MS;
      await persistSplit(kv, host);
      const loaded = startPaperHost(["SOL-USD", "BTC-USD"], {});
      loaded.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(loaded, kv).warm();
      expect(loaded.classAPaper?.rows.some((item) => item.signalMs === CLASS_A_PAPER_START_MS)).toBe(true);
      const again = startPaperHost(["SOL-USD", "BTC-USD"], {});
      again.clock = () => CLASS_A_PAPER_START_MS;
      const body = await loadSplit(kv, again);
      expect(body?.classAPaper?.rows.some((item) => item.signalMs === CLASS_A_PAPER_START_MS)).toBe(true);
      expect("classAPaper" in captureHot(startPaperHost(["SOL-USD"], {}))).toBe(false);
    }
  } finally {
    if (gzip === undefined) delete process.env.P6_GZIP_WRITES;
    else process.env.P6_GZIP_WRITES = gzip;
  }
});

test("the production bar path keeps a pending maker order across a reload, fills on a print, and records nofill only after four hours", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  try {
    for (const flag of ["0", "1"] as const) {
      process.env.P6_GZIP_WRITES = flag;
      const kv = memoryKv(() => CLASS_A_PAPER_START_MS);
      const host = startPaperHost(["SOL-USD", "BTC-USD"], {});
      host.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(host, kv).warm();
      host.classAPaper!.spreadLog = { "SOL-USD": Array.from({ length: 25 }, () => 2) };
      const signalDay = Date.parse("2026-10-25T00:00:00.000Z");
      const first = signalDay - 110 * DAY * 1000;
      for (let i = 0; i <= 110; i += 1) {
        const openMs = first + i * DAY * 1000;
        const openSec = openMs / 1000;
        const sol = i === 110 ? 100.05 : 100;
        const btc = 100 * (1 + 0.002 * i);
        const closeOf = (productId: string, close: number) => {
          host.clock = () => openMs + DAY * 1000;
          expect(acceptRestBar(host, { productId, startSec: openSec + DAY - 900, open: close, high: close + 0.05, low: close - 0.05, close, volume: 100_000 })).toBe("accepted");
        };
        closeOf("BTC-USD", btc);
        if (i === 110) {
          host.books.set("SOL-USD", { bids: new Map([["100.04", 1_000_000]]), asks: new Map([["100.06", 1_000_000]]) });
          host.l2Ts.set("SOL-USD", CLASS_A_PAPER_START_MS - 100);
        }
        closeOf("SOL-USD", sol);
      }
      const placed = host.classAPaper?.rows.find((item) => item.pair === "SOL-USD" && item.signalMs === CLASS_A_PAPER_START_MS);
      expect(placed?.fill).toBe("pending");
      expect(placed?.skipReason).toBeNull();
      expect(host.classAPaper?.resting).toHaveLength(1);
      host.clock = () => CLASS_A_PAPER_START_MS + 900_000;
      expect(acceptRestBar(host, {
        productId: "SOL-USD",
        startSec: CLASS_A_PAPER_START_MS / 1000,
        open: 100.05,
        high: 100.06,
        low: 100.05,
        close: 100.05,
        volume: 1,
      })).toBe("accepted");
      expect(placed?.fill).toBe("pending");
      expect(await tryAcquire(kv, `maker-${flag}`, CLASS_A_PAPER_START_MS + DAY * 1000, CLASS_A_PAPER_START_MS)).toBe(true);
      host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
      host.clock = () => CLASS_A_PAPER_START_MS + 900_000;
      await persistSplit(kv, host);
      const loaded = startPaperHost(["SOL-USD", "BTC-USD"], {});
      loaded.clock = () => CLASS_A_PAPER_START_MS + 900_000;
      await hostHolder(loaded, kv).warm();
      const rested = loaded.classAPaper?.rows.find((item) => item.pair === "SOL-USD" && item.signalMs === CLASS_A_PAPER_START_MS);
      expect(rested?.fill).toBe("pending");
      expect(loaded.classAPaper?.resting).toHaveLength(1);
      if (flag === "0") {
        loaded.trades.push({ productId: "SOL-USD", tsSec: CLASS_A_PAPER_START_MS / 1000 + 600, price: 100, size: 1 });
        loaded.clock = () => CLASS_A_PAPER_START_MS + 1_800_000;
        expect(acceptRestBar(loaded, {
          productId: "SOL-USD",
          startSec: CLASS_A_PAPER_START_MS / 1000 + 900,
          open: 100.05,
          high: 100.06,
          low: 100.05,
          close: 100.05,
          volume: 1,
        })).toBe("accepted");
        expect(rested?.fill).toBe("fill");
        expect(rested?.skipReason).toBeNull();
        expect(loaded.classAPaper?.open).toHaveLength(1);
        expect(loaded.classAPaper?.open[0]?.entry).toBe(100.05);
        expect(loaded.classAPaper?.open[0]?.feeEntryBps).toBe(35);
      } else {
        loaded.clock = () => CLASS_A_PAPER_START_MS + 4 * 60 * 60 * 1000;
        expect(acceptRestBar(loaded, {
          productId: "SOL-USD",
          startSec: CLASS_A_PAPER_START_MS / 1000 + 4 * 60 * 60 - 900,
          open: 100.05,
          high: 100.06,
          low: 100.05,
          close: 100.05,
          volume: 1,
        })).toBe("accepted");
        expect(rested?.fill).toBe("nofill");
        expect(rested?.skipReason).toBe("skip_nofill");
        expect(loaded.classAPaper?.open).toHaveLength(0);
        expect(loaded.classAPaper?.resting).toHaveLength(0);
      }
    }
  } finally {
    if (gzip === undefined) delete process.env.P6_GZIP_WRITES;
    else process.env.P6_GZIP_WRITES = gzip;
  }
});
