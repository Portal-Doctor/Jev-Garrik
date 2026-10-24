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
