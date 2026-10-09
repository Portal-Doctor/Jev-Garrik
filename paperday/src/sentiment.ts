/**
 * X sentiment on public reads. Veto only: a post can block, it cannot open.
 * Outage or a missing token yields unknown, which the rule engine treats as Caution.
 */

export type Sentiment = "clear" | "veto" | "unknown";

export interface SentimentRead {
  pair: string;
  asOf: number;
  sentiment: Sentiment;
  postIds: string[];
  reason: string;
}

export interface XPost {
  id: string;
  text: string;
}

export interface XReader {
  search(query: string, nowMs: number): Promise<XPost[]>;
}

const VETO_TEXT = /\b(hack|exploit|halt|insolvent|depeg|bankrupt)\b/i;

export function assetOf(pair: string): string {
  return pair.split("-")[0] ?? pair;
}

/** Pure read of posts. Bullish wording is not an entry. Only the veto list blocks. */
export function judgePosts(pair: string, posts: XPost[], asOf: number): SentimentRead {
  const hit = posts.find((p) => VETO_TEXT.test(p.text) && p.text.toUpperCase().includes(assetOf(pair).toUpperCase()));
  if (hit) {
    return { pair, asOf, sentiment: "veto", postIds: posts.map((p) => p.id), reason: `veto:${hit.id}` };
  }
  return { pair, asOf, sentiment: "clear", postIds: posts.map((p) => p.id), reason: "no veto keyword" };
}

export class XSentiment {
  private lastCallMs = -Infinity;
  private hourWindowStart = 0;
  private hourCalls = 0;
  readonly minIntervalMs: number;
  readonly maxPerHour: number;
  calls = 0;

  constructor(
    private readonly reader: XReader | null,
    opts?: { minIntervalMs?: number; maxPerHour?: number },
  ) {
    this.minIntervalMs = opts?.minIntervalMs ?? 15 * 60_000;
    this.maxPerHour = opts?.maxPerHour ?? 4;
  }

  async read(pair: string, nowMs: number): Promise<SentimentRead> {
    if (!this.reader) {
      return { pair, asOf: nowMs, sentiment: "unknown", postIds: [], reason: "no reader" };
    }
    if (nowMs - this.hourWindowStart >= 3_600_000) {
      this.hourWindowStart = nowMs;
      this.hourCalls = 0;
    }
    if (nowMs - this.lastCallMs < this.minIntervalMs || this.hourCalls >= this.maxPerHour) {
      return { pair, asOf: nowMs, sentiment: "unknown", postIds: [], reason: "rate_limit" };
    }
    this.lastCallMs = nowMs;
    this.hourCalls += 1;
    this.calls += 1;
    try {
      const posts = await this.reader.search(assetOf(pair), nowMs);
      return judgePosts(pair, posts, nowMs);
    } catch {
      return { pair, asOf: nowMs, sentiment: "unknown", postIds: [], reason: "outage" };
    }
  }
}
