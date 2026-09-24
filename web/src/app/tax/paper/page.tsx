"use client";

import { TaxBook } from "@/components/TaxBook/TaxBook";
import { useTax } from "@/lib/useTax";

const API_URL = process.env.NEXT_PUBLIC_PAPER_API_URL ?? "http://localhost:3001";

export default function CoinbaseTaxPage() {
  const { report, status, updatedAt, refresh } = useTax(API_URL);
  return (
    <TaxBook
      title="Coinbase tax worksheet"
      report={report}
      status={status}
      updatedAt={updatedAt}
      apiUrl={API_URL}
      refresh={refresh}
      detailHref="/paper"
    />
  );
}
