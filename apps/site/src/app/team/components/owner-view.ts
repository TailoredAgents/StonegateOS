export type OwnerView =
  | "overview"
  | "revenue"
  | "payments"
  | "expenses"
  | "payroll"
  | "pl"
  | "assistant";

export type OwnerDataSource =
  | "revenue"
  | "expense_summary"
  | "expense_list"
  | "commission_summary"
  | "payroll_history"
  | "booking_sources"
  | "payment_reconciliation"
  | "appointment_directory";

export const OWNER_VIEWS: ReadonlyArray<{
  id: OwnerView;
  label: string;
  description: string;
}> = [
  {
    id: "overview",
    label: "Overview",
    description: "Cash flow, alerts, and next actions",
  },
  {
    id: "revenue",
    label: "Job revenue",
    description: "Completed jobs and final job totals",
  },
  {
    id: "payments",
    label: "Payments",
    description: "Provider reconciliation and refunds",
  },
  {
    id: "expenses",
    label: "Expenses",
    description: "Spend totals and recent receipts",
  },
  {
    id: "payroll",
    label: "Payroll",
    description: "Commissions, tips, and payout timing",
  },
  { id: "pl", label: "P&L", description: "Profit and margin snapshots" },
  {
    id: "assistant",
    label: "Assistant",
    description: "Ask live owner questions",
  },
];

const OWNER_VIEW_DATA: Readonly<Record<OwnerView, readonly OwnerDataSource[]>> =
  {
    overview: [
      "revenue",
      "expense_summary",
      "commission_summary",
      "booking_sources",
    ],
    revenue: ["revenue"],
    payments: ["payment_reconciliation", "appointment_directory"],
    expenses: ["expense_summary", "expense_list"],
    payroll: ["commission_summary", "payroll_history"],
    pl: ["revenue", "expense_summary"],
    assistant: [],
  };

export function isOwnerView(
  value: string | null | undefined,
): value is OwnerView {
  return OWNER_VIEWS.some((view) => view.id === value);
}

export function normalizeOwnerView(
  value: string | null | undefined,
): OwnerView {
  return isOwnerView(value) ? value : "overview";
}

export function ownerViewDataSources(
  view: OwnerView,
): readonly OwnerDataSource[] {
  return OWNER_VIEW_DATA[view];
}

export function ownerViewNeeds(
  view: OwnerView,
  source: OwnerDataSource,
): boolean {
  return OWNER_VIEW_DATA[view].includes(source);
}

export type OwnerReviewLevel = "clear" | "attention" | "critical";

export function ownerReviewLevel(
  count: number,
  critical = false,
): OwnerReviewLevel {
  if (!Number.isFinite(count) || count <= 0) return "clear";
  return critical ? "critical" : "attention";
}
