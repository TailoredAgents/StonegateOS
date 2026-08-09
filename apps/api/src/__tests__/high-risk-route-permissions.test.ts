import { readFileSync } from "node:fs";
import { join } from "node:path";

type RouteContract = {
  path: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  permission: string;
};

const CONTRACTS: RouteContract[] = [
  ["app/api/admin/commissions/summary/route.ts", "GET", "commissions.read"],
  [
    "app/api/admin/commissions/payroll-summary/route.ts",
    "GET",
    "commissions.read",
  ],
  [
    "app/api/admin/commissions/crew-pool-overrides/route.ts",
    "GET",
    "commissions.read",
  ],
  [
    "app/api/admin/commissions/crew-pool-overrides/route.ts",
    "POST",
    "commissions.manage",
  ],
  [
    "app/api/admin/commissions/crew-pool-overrides/route.ts",
    "DELETE",
    "commissions.manage",
  ],
  ["app/api/admin/commissions/settings/route.ts", "GET", "commissions.read"],
  ["app/api/admin/commissions/settings/route.ts", "PUT", "commissions.manage"],
  ["app/api/admin/commissions/payout-runs/route.ts", "GET", "commissions.read"],
  [
    "app/api/admin/commissions/payout-runs/route.ts",
    "POST",
    "commissions.manage",
  ],
  [
    "app/api/admin/commissions/payout-runs/[payoutRunId]/export/route.ts",
    "GET",
    "commissions.read",
  ],
  [
    "app/api/admin/commissions/payout-runs/[payoutRunId]/report/route.ts",
    "GET",
    "commissions.read",
  ],
  [
    "app/api/admin/commissions/payout-runs/[payoutRunId]/lock/route.ts",
    "POST",
    "commissions.manage",
  ],
  [
    "app/api/admin/commissions/payout-runs/[payoutRunId]/mark-paid/route.ts",
    "POST",
    "commissions.pay",
  ],
  [
    "app/api/admin/commissions/payout-runs/[payoutRunId]/reimbursements/route.ts",
    "POST",
    "commissions.manage",
  ],
  [
    "app/api/admin/commissions/payout-runs/[payoutRunId]/reimbursements/route.ts",
    "DELETE",
    "commissions.manage",
  ],
  [
    "app/api/admin/google/ads/analyst/reports/route.ts",
    "GET",
    "marketing.read",
  ],
  [
    "app/api/admin/google/ads/analyst/reports/[id]/route.ts",
    "GET",
    "marketing.read",
  ],
  ["app/api/admin/google/ads/analyst/status/route.ts", "GET", "marketing.read"],
  [
    "app/api/admin/google/ads/analyst/recommendations/route.ts",
    "GET",
    "marketing.read",
  ],
  [
    "app/api/admin/google/ads/analyst/recommendations/route.ts",
    "POST",
    "marketing.write",
  ],
  [
    "app/api/admin/google/ads/analyst/recommendations/bulk/route.ts",
    "POST",
    "marketing.write",
  ],
  [
    "app/api/admin/google/ads/analyst/recommendations/events/route.ts",
    "GET",
    "marketing.read",
  ],
  [
    "app/api/admin/google/ads/analyst/recommendations/apply/route.ts",
    "POST",
    "marketing.apply",
  ],
  [
    "app/api/admin/google/ads/analyst/recommendations/apply/bulk/route.ts",
    "POST",
    "marketing.apply",
  ],
  ["app/api/admin/google/ads/analyst/run/route.ts", "POST", "marketing.write"],
  [
    "app/api/admin/google/ads/analyst/settings/route.ts",
    "GET",
    "marketing.read",
  ],
  [
    "app/api/admin/google/ads/analyst/settings/route.ts",
    "POST",
    "marketing.write",
  ],
  ["app/api/admin/seo/run/route.ts", "POST", "marketing.publish"],
  [
    "app/api/admin/seo/posts/[postId]/review/route.ts",
    "POST",
    "marketing.publish",
  ],
  [
    "app/api/admin/seo/posts/[postId]/publish/route.ts",
    "POST",
    "marketing.publish",
  ],
  ["app/api/admin/inbox/export/jsonl/route.ts", "POST", "messages.export"],
  ["app/api/admin/inbox/export/jsonl/route.ts", "PUT", "messages.export"],
  ["app/api/admin/expenses/export/route.ts", "GET", "expenses.export"],
  ["app/api/admin/inbox/threads/route.ts", "POST", "messages.send"],
  [
    "app/api/admin/inbox/threads/[threadId]/messages/route.ts",
    "POST",
    "messages.send",
  ],
  [
    "app/api/admin/inbox/messages/[messageId]/retry/route.ts",
    "POST",
    "messages.send",
  ],
  [
    "app/api/admin/inbox/threads/[threadId]/route.ts",
    "PATCH",
    "messages.write",
  ],
  ["app/api/admin/inbox/threads/ensure/route.ts", "POST", "messages.write"],
  [
    "app/api/admin/inbox/threads/[threadId]/draft/route.ts",
    "POST",
    "messages.write",
  ],
  [
    "app/api/admin/inbox/threads/[threadId]/suggest/route.ts",
    "POST",
    "messages.write",
  ],
  ["app/api/admin/inbox/uploads/route.ts", "POST", "messages.upload"],
  [
    "app/api/admin/inbox/messages/[messageId]/route.ts",
    "DELETE",
    "messages.delete",
  ],
  [
    "app/api/admin/inbox/facebook/backfill-names/route.ts",
    "POST",
    "contacts.write",
  ],
  ["app/api/quotes/[id]/send/route.ts", "POST", "quotes.send"],
  ["app/api/quotes/[id]/route.ts", "DELETE", "quotes.delete"],
  ["app/api/payments/route.ts", "GET", "payments.reconcile"],
  ["app/api/admin/payments/reconciliation/route.ts", "POST", "payments.manage"],
  ["app/api/payments/[id]/attach/route.ts", "POST", "payments.manage"],
  ["app/api/payments/[id]/detach/route.ts", "POST", "payments.manage"],
].map(([path, method, permission]) => ({
  path,
  method,
  permission,
})) as RouteContract[];

function methodSource(contract: RouteContract): string {
  const source = readFileSync(join(process.cwd(), contract.path), "utf8");
  const marker = `export async function ${contract.method}(`;
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Missing ${contract.method} in ${contract.path}`);
  }
  const next = source.indexOf("export async function ", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

describe("high-risk route permission contracts", () => {
  test.each(CONTRACTS)(
    "$method $path requires $permission before parsing or effects",
    (contract) => {
      const source = methodSource(contract);
      const guardIndex = Math.max(
        source.indexOf("requirePermission("),
        source.indexOf("beginTeamMutation("),
      );
      const permissionIndex = source.indexOf(
        `"${contract.permission}"`,
        guardIndex,
      );
      const protectedBoundaries = [
        source.indexOf("request.json("),
        source.indexOf("request.formData("),
        source.indexOf("getDb("),
        source.indexOf("context.params"),
        source.indexOf("applyCustomerNegativeKeyword("),
        source.indexOf("maybeGenerateSeoDraft("),
      ].filter((index) => index >= 0);

      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(permissionIndex).toBeGreaterThan(guardIndex);
      expect(protectedBoundaries.length).toBeGreaterThan(0);
      expect(guardIndex).toBeLessThan(Math.min(...protectedBoundaries));
      expect(permissionIndex).toBeLessThan(Math.min(...protectedBoundaries));
    },
  );

  it("does not let the review endpoint mark an ad recommendation applied", () => {
    const source = methodSource({
      path: "app/api/admin/google/ads/analyst/recommendations/route.ts",
      method: "POST",
      permission: "marketing.write",
    });

    expect(source).not.toContain('status === "applied"');
    expect(source).not.toContain('toStatus: "applied"');
  });

  it.each([
    "app/api/payments/[id]/attach/route.ts",
    "app/api/payments/[id]/detach/route.ts",
  ])(
    "requires reconciliation and financial authority without a role slug: %s",
    (path) => {
      const source = methodSource({
        path,
        method: "POST",
        permission: "payments.manage",
      });

      expect(source).toContain("beginTeamMutation(request");
      expect(source).toContain(
        'requiredPermissions: ["payments.reconcile", "payments.manage"]',
      );
      expect(source).toContain('risk: "financial"');
      expect(source).toContain("requiresIdempotency: true");
      expect(source).toContain('principalTypes: ["human"]');
      expect(source).not.toContain("actor.role");
      expect(source).not.toContain("owner_required");
    },
  );

  it("separates payment reconciliation reads from financial mutations", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/admin/payments/reconciliation/route.ts"),
      "utf8",
    );
    const postSource = methodSource({
      path: "app/api/admin/payments/reconciliation/route.ts",
      method: "POST",
      permission: "payments.manage",
    });
    const readGuard = source.indexOf(
      'requirePermission(request, "payments.reconcile")',
    );

    expect(readGuard).toBeGreaterThanOrEqual(0);
    expect(postSource).toContain("beginTeamMutation(request");
    expect(postSource).toContain(
      'requiredPermissions: ["payments.reconcile", "payments.manage"]',
    );
    expect(postSource).toContain('risk: "financial"');
    expect(postSource).toContain("requiresIdempotency: true");
    expect(postSource.indexOf("beginTeamMutation(request")).toBeLessThan(
      postSource.indexOf("request.json()"),
    );
    expect(postSource.indexOf("beginTeamMutation(request")).toBeLessThan(
      postSource.indexOf("getDb()"),
    );
    expect(postSource).not.toContain("actor.role");
    expect(source).not.toContain("owner_required");
  });
});
