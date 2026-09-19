import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Coinbase Paper Trader",
  description: "Measuring directional edge after fees on Coinbase spot pairs — no capital at risk.",
};

export default function PaperLayout({ children }: { children: React.ReactNode }) {
  return children;
}
