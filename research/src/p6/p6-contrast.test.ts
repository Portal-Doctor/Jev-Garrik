import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

/**
 * Same pairs as p6-ux-contrast.py, light theme only.
 * Token values are read from globals.css, so a drifted hex fails this test.
 */

type Kind = "body" | "large" | "ui";

const NEED: Record<Kind, number> = { body: 4.5, large: 3, ui: 3 };

const PAIRS: readonly [string, string, string, Kind, boolean][] = [
  ["P01", "ink", "bg", "body", false],
  ["P02", "ink", "page-bg", "body", false],
  ["P03", "ink", "track", "body", false],
  ["P04", "ink-2", "bg", "body", false],
  ["P05", "link-muted", "bg", "body", false],
  ["P06", "link-muted", "panel", "body", false],
  ["P07", "link-muted", "page-bg", "body", false],
  ["P08", "buy-ink", "bg", "body", false],
  ["P09", "buy-ink", "panel", "body", false],
  ["P10", "sell-ink", "bg", "body", false],
  ["P11", "sell-ink", "panel", "body", false],
  ["P12", "ink", "buy-bar-dim", "body", false],
  ["P12b", "buy-ink", "buy-bar-dim", "ui", false],
  ["P13", "ink", "sell-bar-dim", "body", false],
  ["P14", "badge-standin-fg", "badge-standin-bg", "body", false],
  ["P14b", "ink", "badge-standin-bg", "body", false],
  ["P15", "bg", "ink", "body", false],
  ["P16", "pnl-pos", "bg", "large", false],
  ["P17", "pnl-neg", "bg", "large", false],
  ["P18", "buy-ink", "bg", "ui", false],
  ["P19", "late-ink", "bg", "ui", false],
  ["P20", "sell-ink", "bg", "ui", false],
  ["P21", "sell", "bg", "ui", false],
  ["P22", "late-ink", "bg", "ui", false],
  ["P23", "link-muted", "bg", "ui", false],
  ["P24", "link-muted", "panel", "ui", false],
  ["P25", "link-muted", "page-bg", "ui", false],
  ["P26", "ink", "track", "ui", false],
  ["F01", "muted", "panel", "body", true],
  ["F02", "muted", "page-bg", "body", true],
  ["F03", "pnl-pos", "bg", "body", true],
  ["F04", "pnl-neg", "bg", "body", true],
  ["F05", "sell-ink", "sell-bar-dim", "body", true],
  ["F06", "buy-ink", "buy-bar-dim", "body", true],
];

function rootBlock(css: string): string {
  const start = css.indexOf(":root");
  if (start < 0) throw new Error("globals.css has no :root");
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error("globals.css :root is not closed");
}

function parseTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of rootBlock(css).matchAll(/--([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})/g)) {
    const name = match[1];
    const hex = match[2];
    if (name && hex) tokens[name] = hex;
  }
  return tokens;
}

function channel(hex: string, index: number): number {
  const body = hex.slice(1);
  const wide = body.length === 3 ? body[index]! + body[index]! : body.slice(index * 2, index * 2 + 2);
  const unit = Number.parseInt(wide, 16) / 255;
  return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function lum(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

function contrast(foreground: string, background: string): number {
  const a = lum(foreground);
  const b = lum(background);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function failures(tokens: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [id, fg, bg, kind, forbidden] of PAIRS) {
    const fgHex = tokens[fg];
    const bgHex = tokens[bg];
    if (!fgHex || !bgHex) {
      bad.push(`${id} missing --${fgHex ? bg : fg}`);
      continue;
    }
    const ratio = contrast(fgHex, bgHex);
    const ok = ratio >= NEED[kind];
    if (forbidden ? ok : !ok) bad.push(`${id} ${ratio.toFixed(2)}`);
  }
  return bad;
}

const cssPath = join(import.meta.dir, "..", "..", "..", "web/src/app/globals.css");

test("light tokens from globals.css meet the summary contrast pairs", () => {
  const css = readFileSync(cssPath, "utf8");
  const tokens = parseTokens(css);
  expect(tokens.ink?.toLowerCase()).toBe("#0a0a0a");
  expect(tokens["link-muted"]?.toLowerCase()).toBe("#5a5a56");
  expect(tokens["buy-ink"]?.toLowerCase()).toBe("#0b7a48");
  expect(tokens["sell-ink"]?.toLowerCase()).toBe("#c2402f");
  expect(tokens["pnl-pos"]?.toLowerCase()).toBe("#0e9f5d");
  expect(tokens["pnl-neg"]?.toLowerCase()).toBe("#de3b32");
  expect(failures(tokens)).toEqual([]);
});

test("a drifted ink token fails the contrast check", () => {
  const css = readFileSync(cssPath, "utf8");
  expect(css.includes("--ink: #0A0A0A")).toBe(true);
  const drifted = css.replace("--ink: #0A0A0A", "--ink: #98968E");
  expect(drifted).not.toBe(css);
  const bad = failures(parseTokens(drifted));
  expect(bad.some((row) => row.startsWith("P01"))).toBe(true);
  expect(bad.length).toBeGreaterThan(0);
});
