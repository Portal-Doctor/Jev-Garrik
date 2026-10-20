import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: "noindex",
};

export default function P6Layout({ children }: { children: React.ReactNode }) {
  return children;
}
