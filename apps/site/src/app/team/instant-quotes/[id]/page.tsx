import React from "react";
import { InstantQuoteDetail } from "../../components/InstantQuoteDetail";
import { InstantQuotesSection } from "../../components/InstantQuotesSection";

export default async function InstantQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="space-y-4">
      <InstantQuoteDetail quoteId={id} />
      <InstantQuotesSection />
    </div>
  );
}
