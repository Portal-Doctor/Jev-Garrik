import type { NextConfig } from "next";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");

const nextConfig: NextConfig = {
  // The engine lives in the repo, outside this app. Turbopack has to see it.
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  outputFileTracingExcludes: {
    "/api/engine": ["../research/data/candles/**", "../research/data/daily/**", "../research/data/**/*.sqlite"],
    "/p6": ["../research/data/candles/**", "../research/data/daily/**", "../research/data/**/*.sqlite"],
  },
  outputFileTracingIncludes: {
    "/api/engine": [
      "../research/data/reports/p4-registration.json",
      "../research/data/reports/universe-membership.json",
      "../research/data/reports/product-stats.json",
      "../research/data/products/usd-spot.json",
      "../research/data/reports/p6-jev-spend.json",
      "../research/data/reports/p6-forward-a.json",
      "../research/data/reports/p6-forward-a.sha256",
    ],
  },
};

export default nextConfig;
