import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  normalizeOwnerView,
  ownerReviewLevel,
  ownerViewDataSources,
  ownerViewNeeds,
  type OwnerView,
} from "../../../site/src/app/team/components/owner-view";

const OWNER_SECTION = readFileSync(
  join(process.cwd(), "../site/src/app/team/components/OwnerSection.tsx"),
  "utf8",
);

describe("Site Owner HQ active-view contract", () => {
  it("maps every Owner view to only the data it renders", () => {
    const expected: Readonly<Record<OwnerView, readonly string[]>> = {
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

    for (const [view, sources] of Object.entries(expected) as Array<
      [OwnerView, readonly string[]]
    >) {
      expect(ownerViewDataSources(view)).toEqual(sources);
    }

    expect(ownerViewNeeds("payments", "payment_reconciliation")).toBe(true);
    expect(ownerViewNeeds("payments", "revenue")).toBe(false);
    expect(ownerViewNeeds("assistant", "revenue")).toBe(false);
  });

  it("preserves valid canonical view ids and safely defaults invalid input", () => {
    for (const view of [
      "overview",
      "revenue",
      "payments",
      "expenses",
      "payroll",
      "pl",
      "assistant",
    ] as const) {
      expect(normalizeOwnerView(view)).toBe(view);
    }

    expect(normalizeOwnerView(undefined)).toBe("overview");
    expect(normalizeOwnerView(null)).toBe("overview");
    expect(normalizeOwnerView("profit-and-loss")).toBe("overview");
  });

  it("distinguishes clear, attention, and critical review states", () => {
    expect(ownerReviewLevel(0)).toBe("clear");
    expect(ownerReviewLevel(-1)).toBe("clear");
    expect(ownerReviewLevel(Number.NaN)).toBe("clear");
    expect(ownerReviewLevel(1)).toBe("attention");
    expect(ownerReviewLevel(1, true)).toBe("critical");
  });

  it("guards every fetch and renders only the selected workspace", () => {
    const fetchContract = OWNER_SECTION.slice(
      OWNER_SECTION.indexOf("] = await Promise.all(["),
      OWNER_SECTION.indexOf("const revenue = revenueResult.data"),
    );

    expect(
      fetchContract.match(/ownerViewNeeds\(activeOwnerView,/gu),
    ).toHaveLength(8);
    expect(fetchContract.match(/loadOwnerResource</gu)).toHaveLength(8);
    expect(OWNER_SECTION).not.toMatch(
      /activeOwnerView\s*===\s*[^\n]+\?[^\n]+:\s*"hidden"/u,
    );
    expect(OWNER_SECTION).toContain(
      "const { PaymentReconciliationPanel } = await import(",
    );
    expect(OWNER_SECTION).toContain(
      'const { OwnerAssistClient } = await import("./OwnerAssistClient")',
    );
    expect(OWNER_SECTION).toContain(
      '{activeOwnerView === "assistant" ? activeSubview : null}',
    );
  });

  it("keeps copyable Owner URLs and truthful source/error language", () => {
    expect(OWNER_SECTION).toContain('teamSurfaceHref("owner", {');
    expect(OWNER_SECTION).toContain("query: { ownerView: view.id }");
    expect(OWNER_SECTION).toContain(
      'aria-current={isActive ? "page" : undefined}',
    );
    expect(OWNER_SECTION).toContain("Owner data sources and freshness");
    expect(OWNER_SECTION).toContain("local system of record");
    expect(OWNER_SECTION).toContain(
      "unavailable sources are not treated as $0",
    );
    expect(OWNER_SECTION).toContain('role="alert"');
    expect(OWNER_SECTION).toContain('"Unavailable"');
    expect(OWNER_SECTION).toContain("No flagged ledger items");
  });
});
