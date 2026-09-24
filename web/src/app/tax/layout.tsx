import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Tax worksheet",
  description: "FIFO lot worksheet for the Coinbase paper engine.",
};

export default function TaxLayout({ children }: { children: React.ReactNode }) {
  return children;
}
