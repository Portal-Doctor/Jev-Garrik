import { redisKvFromUrl } from "./relay";
const t = Date.now();
try { await redisKvFromUrl("redis://qa:x@127.0.0.1:6399").get("k"); console.log("no error"); } catch (e) { console.log("blackhole:", (e as Error).message, Date.now() - t, "ms"); }
try { console.log("wrongpass get ->", await redisKvFromUrl("redis://qa:wrong@127.0.0.1:6390").get("qa:x")); } catch (e) { console.log("wrongpass:", (e as Error).message); }
try { console.log("tls no CA ->", await redisKvFromUrl("rediss://qa:qapass@localhost:6391").get("qa:x")); } catch (e) { console.log("tls without CA:", (e as Error).message); }
process.exit(0);
