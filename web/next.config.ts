import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  // The engine lives in the repo, outside this app. Turbopack has to see it.
  turbopack: { root: path.resolve(__dirname, "..") },
};

export default nextConfig;
