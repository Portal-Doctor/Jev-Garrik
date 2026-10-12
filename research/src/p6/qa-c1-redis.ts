import { redisKvFromUrl, runInvocation, LEASE_KEY, LEASE_META_KEY, STATE_KEY, CRON_KEY, decodeLease, type Kv } from "./relay";
const URL_ = process.env.QA_REDIS!;
const kv: Kv = redisKvFromUrl(URL_);
const M = 60_000;
function fake(name: string, log: string[], opts: { sample?: () => Promise<void>; watch?: () => Promise<void> } = {}) {
  const gaps: any[] = [];
  return { gaps, h: {
    async warm() { log.push(`${name}:warm`); },
    async applyDueBars() { log.push(`${name}:apply`); return [`${name}-bar`]; },
    releaseDeadline() { log.push(`${name}:releaseDeadline`); },
    async sampleUntil(u: number) { log.push(`${name}:sample`); if (opts.sample) await opts.sample(); },
    async watchUntil(u: number) { log.push(`${name}:watch`); if (opts.watch) await opts.watch(); },
    async persist() { log.push(`${name}:persist`); },
    recordGap(g: any) { gaps.push(g); log.push(`${name}:gap:${g.cause}:${g.endMs - g.startMs}`); },
  } };
}
async function reset() { for (const k of [LEASE_KEY, LEASE_META_KEY, STATE_KEY, CRON_KEY]) await kv.del(k); }
const show = async () => ({ lease: decodeLease(await kv.get(LEASE_KEY)), meta: decodeLease(await kv.get(LEASE_META_KEY)) });
const scen = process.argv[2];
const T = Date.parse("2026-10-12T17:01:00Z");
if (scen === "contend") {
  await reset(); const log: string[] = [];
  const a = fake("A", log), b = fake("B", log);
  const [ra, rb] = await Promise.all([
    runInvocation({ kv, self: "A", nowMs: T, deadlineMs: T + 30 * M, lastCronMs: null, holder: a.h }),
    runInvocation({ kv, self: "B", nowMs: T, deadlineMs: T + 30 * M, lastCronMs: null, holder: b.h }),
  ]);
  console.log("A", ra.action, ra.applied, "B", rb.action, rb.applied); console.log(log.join(" ")); console.log(JSON.stringify(await show()));
  const ttl = await (kv as any).get(LEASE_KEY); 
}
if (scen === "handover") {
  await reset(); const log: string[] = [];
  const a = fake("A", log);
  const ra = await runInvocation({ kv, self: "A", nowMs: T, deadlineMs: T + 30 * M, holder: a.h });
  console.log("A", ra.action, ra.applied, JSON.stringify(await show()));
  // B fires +15m while A holds; its watch returns once A released (A already released at T+29m in Redis)
  const b = fake("B", log);
  const rb = await runInvocation({ kv, self: "B", nowMs: T + 15 * M, deadlineMs: T + 45 * M, holder: b.h });
  console.log("B@+15", rb.action, rb.cause, rb.applied, "gaps", JSON.stringify(b.gaps));
  const c = fake("C", log);
  const rc = await runInvocation({ kv, self: "C", nowMs: T + 30 * M - 500, deadlineMs: T + 60 * M, holder: c.h });
  console.log("C@+30-0.5s (early)", rc.action, rc.cause, rc.applied, "gaps", JSON.stringify(c.gaps));
  const d = fake("D", log);
  const rd = await runInvocation({ kv, self: "D", nowMs: T + 30 * M + 500, deadlineMs: T + 60 * M, holder: d.h });
  console.log("D@+30+0.5s", rd.action, rd.cause, rd.applied, "gaps", JSON.stringify(d.gaps));
  console.log(log.join(" "));
}
if (scen === "missed") {
  await reset(); const log: string[] = [];
  const a = fake("A", log);
  await runInvocation({ kv, self: "A", nowMs: T, deadlineMs: T + 30 * M, holder: a.h });
  // crons at +15 and +30 missed; next at +45
  const e = fake("E", log);
  const re = await runInvocation({ kv, self: "E", nowMs: T + 45 * M, deadlineMs: T + 75 * M, holder: e.h });
  console.log("E@+45", re.action, re.cause, re.feedGapMs, "gaps", JSON.stringify(e.gaps));
}
if (scen === "crash-child") {
  // real process: take lease with short real deadline, then hang until killed
  const now = Date.now(); const log: string[] = [];
  const a = fake("K", log, { sample: () => new Promise(() => { setInterval(() => {}, 1000); }) });
  console.log("child holding"); 
  await runInvocation({ kv, self: "K", nowMs: now, deadlineMs: now + Number(process.argv[3]), holder: a.h });
}
if (scen === "after-crash") {
  const now = Date.now(); const log: string[] = [];
  console.log("before", JSON.stringify(await show()));
  const b = fake("N", log, { watch: async () => { while (decodeLease(await kv.get(LEASE_KEY))) await new Promise(r => setTimeout(r, 200)); } });
  const t0 = Date.now();
  const rb = await runInvocation({ kv, self: "N", nowMs: now, lastCronMs: now - 15 * M, deadlineMs: now + 30 * M, holder: b.h });
  console.log("N", rb.action, rb.cause, rb.applied, "waited", Date.now() - t0, "gaps", JSON.stringify(b.gaps)); console.log(log.join(" "));
}
if (scen === "reset") { await reset(); console.log("reset"); }
if (scen === "plainauth") { console.log("ping set", await kv.set("qa:x", "1"), await kv.get("qa:x")); }
process.exit(0);
