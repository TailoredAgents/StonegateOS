"use client";

import * as React from "react";

export type MobileCompletionDraftValues = {
  finalTotal?: string;
  expectedFinalTotalCents?: string;
  finalTotalChangeReason?: string;
  crewMemberIds?: string[];
  crewHours?: Record<string, string>;
  crewRates?: Record<string, string>;
  proofOverrideReason?: string;
  sendReviewRequest?: boolean;
};

export const CompletionDraftContext = React.createContext<{
  draft: MobileCompletionDraftValues | null;
  revision: number;
  error?: string | null;
} | null>(null);

export function useMobileCompletionDraft() {
  return React.useContext(CompletionDraftContext);
}
