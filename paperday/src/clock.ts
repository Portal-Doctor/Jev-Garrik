/**
 * America/Chicago session clock plus UTC day boundaries.
 * Entry windows and the weekend idea cap use Chicago local time.
 * The daily loss stop and the flat-before-midnight rule use UTC.
 */

const TZ = "America/Chicago";

const WEEKDAY: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 Sunday .. 6 Saturday */
  weekday: number;
}

export interface ClockStatus {
  utcDay: string;
  ctDay: string;
  ctHour: number;
  ctMinute: number;
  weekend: boolean;
  inEntryWindow: boolean;
  inMacroBlackout: boolean;
  /** True when no macro calendar file was loaded. Default slots still block. */
  macroCalendarMissing: boolean;
  msUntilUtcMidnight: number;
  mustFlatBeforeEntry: boolean;
}

/** Default blackout slots, America/Chicago local time, used when the calendar is missing and as a floor. */
export const DEFAULT_BLACKOUTS: ReadonlyArray<{ startMin: number; endMin: number; name: string }> = [
  { startMin: 7 * 60 + 15, endMin: 8 * 60, name: "data_0730_ct" },
  { startMin: 8 * 60 + 45, endMin: 9 * 60 + 15, name: "data_0900_ct" },
  { startMin: 12 * 60 + 45, endMin: 13 * 60 + 30, name: "fomc_1300_ct" },
];

/** Entry window: 08:00 inclusive through 15:00 exclusive, America/Chicago. */
export const ENTRY_START_MIN = 8 * 60;
export const ENTRY_END_MIN = 15 * 60;

const CHICAGO_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
});

function part(parts: Intl.DateTimeFormatPart[], type: string): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

export function chicagoParts(utcMs: number): ZonedParts {
  const parts = CHICAGO_FMT.formatToParts(new Date(utcMs));
  let hour = Number(part(parts, "hour"));
  if (hour === 24) hour = 0;
  const weekdayName = part(parts, "weekday");
  return {
    year: Number(part(parts, "year")),
    month: Number(part(parts, "month")),
    day: Number(part(parts, "day")),
    hour,
    minute: Number(part(parts, "minute")),
    second: Number(part(parts, "second")),
    weekday: WEEKDAY[weekdayName] ?? 0,
  };
}

/** Minutes east of UTC is negative in the US. Distinguishes the repeated hour on the DST fallback. */
export function chicagoOffsetMinutes(utcMs: number): number {
  const z = chicagoParts(utcMs);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return Math.round((asUtc - utcMs) / 60_000);
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function ctDayKey(utcMs: number): string {
  const z = chicagoParts(utcMs);
  return `${z.year}-${pad2(z.month)}-${pad2(z.day)}`;
}

export function utcDayKey(utcMs: number): string {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function utcMonthKey(utcMs: number): string {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

export function isWeekendCt(utcMs: number): boolean {
  const w = chicagoParts(utcMs).weekday;
  return w === 0 || w === 6;
}

export function ctMinutes(utcMs: number): number {
  const z = chicagoParts(utcMs);
  return z.hour * 60 + z.minute;
}

export function inEntryWindow(utcMs: number): boolean {
  const m = ctMinutes(utcMs);
  return m >= ENTRY_START_MIN && m < ENTRY_END_MIN;
}

export function inMacroBlackout(utcMs: number, extra: ReadonlyArray<{ startMin: number; endMin: number }> = []): boolean {
  const m = ctMinutes(utcMs);
  const slots = [...DEFAULT_BLACKOUTS, ...extra];
  return slots.some((s) => m >= s.startMin && m < s.endMin);
}

export function msUntilUtcMidnight(utcMs: number): number {
  const d = new Date(utcMs);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return next - utcMs;
}

/** True when this 1-minute bar's close reaches or passes 00:00 UTC. The position must be flat before that instant. */
export function barEndsAtUtcMidnight(barOpenMs: number, barMs = 60_000): boolean {
  const closeTs = barOpenMs + barMs;
  const d = new Date(barOpenMs);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
  return barOpenMs < midnight && closeTs >= midnight;
}

export function clockStatus(utcMs: number, macroCalendarPresent = false): ClockStatus {
  const z = chicagoParts(utcMs);
  const until = msUntilUtcMidnight(utcMs);
  return {
    utcDay: utcDayKey(utcMs),
    ctDay: ctDayKey(utcMs),
    ctHour: z.hour,
    ctMinute: z.minute,
    weekend: z.weekday === 0 || z.weekday === 6,
    inEntryWindow: inEntryWindow(utcMs),
    inMacroBlackout: inMacroBlackout(utcMs),
    macroCalendarMissing: !macroCalendarPresent,
    msUntilUtcMidnight: until,
    mustFlatBeforeEntry: until < 60 * 60_000,
  };
}

export function quarterKey(utcMs: number): string {
  const d = new Date(utcMs);
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `${d.getUTCFullYear()}Q${q}`;
}
