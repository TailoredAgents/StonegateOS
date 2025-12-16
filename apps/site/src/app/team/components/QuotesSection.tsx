import React, { type ReactElement } from "react";
import { QuotesList } from "../QuotesList";
import { callAdminApi } from "../lib/api";
import { deleteQuoteAction, quoteDecisionAction, sendQuoteAction } from "../actions";

interface QuoteDto {
  id: string;
  status: string;
  services: string[];
  addOns: string[] | null;
  total: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  expiresAt: string | null;
  shareToken: string | null;
  contact: { name: string; email: string | null };
  property: { addressLine1: string; city: string; state: string; postalCode: string };
}

export async function QuotesSection(): Promise<ReactElement> {
  const res = await callAdminApi("/api/quotes");
  if (!res.ok) throw new Error("Failed to load quotes");

  const payload = (await res.json()) as { quotes: QuoteDto[] };
  return (
    <QuotesList
      initial={payload.quotes}
      sendAction={sendQuoteAction}
      decisionAction={quoteDecisionAction}
      deleteAction={deleteQuoteAction}
    />
  );
}
