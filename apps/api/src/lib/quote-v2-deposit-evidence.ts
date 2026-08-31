export type QuoteV2CompletedDepositEvidence = {
  expectedCents: number;
  provider: string;
  currency: string;
  canonicalStatus: string | null;
  amountCents: number;
  jobAmountCents: number | null;
  totalAmountCents: number | null;
  tipCents: number;
  refundedAmountCents: number;
  attemptStatus: string;
  lateCapture: boolean;
};

export type QuoteV2CompletedDepositDisposition =
  | "bookable"
  | "staff_confirmation"
  | "invalid";

export function quoteV2CompletedDepositDisposition(
  input: QuoteV2CompletedDepositEvidence,
): QuoteV2CompletedDepositDisposition {
  const exact =
    input.expectedCents > 0 &&
    input.provider === "square" &&
    input.currency === "USD" &&
    input.canonicalStatus === "completed" &&
    input.amountCents === input.expectedCents &&
    input.jobAmountCents === input.expectedCents &&
    input.totalAmountCents === input.expectedCents &&
    input.tipCents === 0 &&
    input.refundedAmountCents === 0 &&
    input.attemptStatus === "completed";
  if (!exact) return "invalid";
  return input.lateCapture ? "staff_confirmation" : "bookable";
}

export function quoteV2CompletedDepositMatches(
  input: QuoteV2CompletedDepositEvidence,
): boolean {
  return quoteV2CompletedDepositDisposition(input) === "bookable";
}
