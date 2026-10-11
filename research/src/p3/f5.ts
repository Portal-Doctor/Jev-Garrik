/**
 * D1 versus 15m-derived overlap at the pre-committed F5 tolerances.
 * Open is reported beside high, low, and close. The price-group pass uses high, low, and close.
 * A 00:00 UTC boundary gap at or under 10 bps keeps pre-window closes for warmup indicators only.
 */

export const F5_PRICE_BPS = 10;
export const F5_VOLUME_REL = 0.02;
export const F5_VOLUME_NOTIONAL_USD = 1000;
export const F5_BOUNDARY_BPS = 10;
export const WINDOW_START = "2025-10-11";
const DAY_SEC = 86400;
const BAR_SEC = 900;

export interface F5Day {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  empty: boolean;
}

export interface F5Slot {
  ts: number;
  empty: boolean;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface F5NameSummary {
  productId: string;
  overlapDays: number;
  missingSlotDays: number;
  oneSidedEmptyDays: number;
  priceFailDays: number;
  volumeFailDays: number;
  openFailDays: number;
  highFailDays: number;
  lowFailDays: number;
  closeFailDays: number;
  prewindowChecked: number;
  prewindowMissing: number;
  prewindowHighBelowLow: number;
  prewindowCloseOutside: number;
  prewindowZeroVolume: number;
  prewindowPriceBad: boolean;
  prewindowVolumeBad: boolean;
  boundaryDays: number;
  boundaryBeforeMedianBps: number | null;
  boundaryAfterMedianBps: number | null;
  boundaryBestSide: "before-00:00" | "after-00:00" | null;
  boundaryBestMedianBps: number | null;
  boundarySavesCloses: boolean;
  priceGroupPasses: boolean;
  volumeGroupPasses: boolean;
  dropPrewindowPrices: boolean;
  dropPrewindowVolume: boolean;
}

export function priceAllowance(price: number, tick: number): number {
  return Math.max(tick > 0 ? tick : 0, Math.abs(price) * (F5_PRICE_BPS / 10_000));
}

export function priceOff(left: number, right: number, tick: number): boolean {
  return Math.abs(left - right) > priceAllowance(right, tick);
}

/** Volume tolerance is the larger of 2% and $1,000 of notional, in base units. */
export function volumeOff(derived: number, daily: number, price: number): boolean {
  const rel = Math.abs(derived - daily);
  const pct = F5_VOLUME_REL * Math.max(Math.abs(daily), Math.abs(derived));
  const notional = price > 0 ? F5_VOLUME_NOTIONAL_USD / price : Number.POSITIVE_INFINITY;
  return rel > Math.max(pct, notional);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function allowance(overlapDays: number): number {
  return Math.max(1, Math.floor(0.01 * overlapDays));
}

export function summarizeOverlap(opts: {
  productId: string;
  tick: number;
  derived: readonly F5Day[];
  daily: readonly F5Day[];
  slots: readonly F5Slot[];
}): F5NameSummary {
  const dailyByDate = new Map(opts.daily.map((row) => [row.date, row]));
  const slotsByTs = new Map(opts.slots.map((row) => [row.ts, row]));
  let overlapDays = 0;
  let missingSlotDays = 0;
  let oneSidedEmptyDays = 0;
  let priceFailDays = 0;
  let volumeFailDays = 0;
  let openFailDays = 0;
  let highFailDays = 0;
  let lowFailDays = 0;
  let closeFailDays = 0;
  const beforeGaps: number[] = [];
  const afterGaps: number[] = [];

  for (const derived of opts.derived) {
    if (derived.date < WINDOW_START) continue;
    const dayStart = Date.parse(`${derived.date}T00:00:00.000Z`) / 1000;
    let stored = 0;
    for (let ts = dayStart; ts < dayStart + DAY_SEC; ts += BAR_SEC) {
      if (slotsByTs.has(ts)) stored += 1;
    }
    if (stored < DAY_SEC / BAR_SEC) {
      missingSlotDays += 1;
      continue;
    }
    const other = dailyByDate.get(derived.date);
    const derivedEmpty = derived.empty;
    const dailyEmpty = !other || other.empty;
    if (derivedEmpty && dailyEmpty) continue;
    if (derivedEmpty !== dailyEmpty || !other) {
      overlapDays += 1;
      oneSidedEmptyDays += 1;
      priceFailDays += 1;
      volumeFailDays += 1;
      continue;
    }
    overlapDays += 1;
    const tick = opts.tick;
    const openFail = priceOff(derived.open, other.open, tick);
    const highFail = priceOff(derived.high, other.high, tick);
    const lowFail = priceOff(derived.low, other.low, tick);
    const closeFail = priceOff(derived.close, other.close, tick);
    const volFail = volumeOff(derived.volume, other.volume, derived.close);
    if (openFail) openFailDays += 1;
    if (highFail) highFailDays += 1;
    if (lowFail) lowFailDays += 1;
    if (closeFail) closeFailDays += 1;
    if (highFail || lowFail || closeFail) priceFailDays += 1;
    if (volFail) volumeFailDays += 1;
    const next = dayStart + DAY_SEC;
    const before = slotsByTs.get(next - BAR_SEC);
    const after = slotsByTs.get(next);
    if (before && !before.empty && other.close > 0) beforeGaps.push((Math.abs(other.close - before.close) / other.close) * 10_000);
    if (after && !after.empty && other.close > 0) afterGaps.push((Math.abs(other.close - after.open) / other.close) * 10_000);
  }

  const pre = prewindow(opts.daily);
  const beforeMedian = median(beforeGaps);
  const afterMedian = median(afterGaps);
  let bestSide: F5NameSummary["boundaryBestSide"] = null;
  let bestMedian: number | null = null;
  if (beforeMedian != null && (afterMedian == null || beforeMedian <= afterMedian)) {
    bestSide = "before-00:00";
    bestMedian = beforeMedian;
  } else if (afterMedian != null) {
    bestSide = "after-00:00";
    bestMedian = afterMedian;
  }
  const priceGroupPasses = priceFailDays <= allowance(overlapDays);
  const volumeGroupPasses = volumeFailDays <= allowance(overlapDays);
  const boundarySavesCloses = bestMedian != null && bestMedian <= F5_BOUNDARY_BPS;
  return {
    productId: opts.productId,
    overlapDays,
    missingSlotDays,
    oneSidedEmptyDays,
    priceFailDays,
    volumeFailDays,
    openFailDays,
    highFailDays,
    lowFailDays,
    closeFailDays,
    prewindowChecked: pre.checked,
    prewindowMissing: pre.missing,
    prewindowHighBelowLow: pre.highBelowLow,
    prewindowCloseOutside: pre.closeOutside,
    prewindowZeroVolume: pre.zeroVolume,
    prewindowPriceBad: pre.priceBad,
    prewindowVolumeBad: pre.volumeBad,
    boundaryDays: Math.max(beforeGaps.length, afterGaps.length),
    boundaryBeforeMedianBps: beforeMedian,
    boundaryAfterMedianBps: afterMedian,
    boundaryBestSide: bestSide,
    boundaryBestMedianBps: bestMedian,
    boundarySavesCloses,
    priceGroupPasses,
    volumeGroupPasses,
    dropPrewindowPrices: (!priceGroupPasses && !boundarySavesCloses) || pre.priceBad,
    dropPrewindowVolume: !volumeGroupPasses || pre.volumeBad,
  };
}

function prewindow(daily: readonly F5Day[]): {
  checked: number;
  missing: number;
  highBelowLow: number;
  closeOutside: number;
  zeroVolume: number;
  priceBad: boolean;
  volumeBad: boolean;
} {
  const rows = daily.filter((row) => row.date < WINDOW_START && !row.empty).sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = rows.slice(-200);
  if (last.length === 0) {
    return { checked: 0, missing: 0, highBelowLow: 0, closeOutside: 0, zeroVolume: 0, priceBad: false, volumeBad: false };
  }
  const byDate = new Map(last.map((row) => [row.date, row]));
  const start = last[0]!.date;
  const end = last[last.length - 1]!.date;
  let checked = 0;
  let missing = 0;
  let highBelowLow = 0;
  let closeOutside = 0;
  let zeroVolume = 0;
  for (let date = start; date <= end; date = addDays(date, 1)) {
    checked += 1;
    const row = byDate.get(date);
    if (!row) {
      missing += 1;
      continue;
    }
    if (row.high < row.low) highBelowLow += 1;
    if (row.close < row.low || row.close > row.high) closeOutside += 1;
    if (!(row.volume > 0)) zeroVolume += 1;
  }
  const priceDefects = missing + highBelowLow + closeOutside;
  const volumeDefects = missing + zeroVolume;
  return {
    checked,
    missing,
    highBelowLow,
    closeOutside,
    zeroVolume,
    priceBad: checked > 0 && priceDefects / checked > 0.01,
    volumeBad: checked > 0 && volumeDefects / checked > 0.01,
  };
}
