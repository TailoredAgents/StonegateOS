import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTeamRouteSecurityContract,
  routeIsInTeamSecurityScope,
  type TeamRouteHttpMethod,
} from "@/lib/team-route-security-manifest";
import {
  PartnerManagementListInputError,
  parsePartnerManagementListQuery,
} from "@/lib/partner-management-list";

const API_ROOT = process.cwd();
const SITE_TEAM_ROOT = resolve(API_ROOT, "../site/src/app/team");
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

function apiSource(relativePath: string): string {
  return readFileSync(resolve(API_ROOT, relativePath), "utf8");
}

function siteSource(relativePath: string): string {
  return readFileSync(resolve(SITE_TEAM_ROOT, relativePath), "utf8");
}

function exportedActionSource(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`Missing exported action ${name}`);
  const next = source.indexOf("export async function ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

describe("Partner Staff seam source contracts", () => {
  it.each(["needs_reconciliation", "ready", "completed", "cancelled"])(
    "accepts the bounded account-merge state %s",
    (status) => {
      const parsed = parsePartnerManagementListQuery(
        new URLSearchParams({ accountId: ACCOUNT_ID, status }),
        "account-merges",
      );
      expect(parsed).toMatchObject({
        resource: "account-merges",
        accountId: ACCOUNT_ID,
        status,
      });
    },
  );

  it("keeps account-merge cursors filter-bound and rejects identity filters", () => {
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ userId: ACCOUNT_ID }),
        "account-merges",
      ),
    ).toThrow(PartnerManagementListInputError);
    expect(() =>
      parsePartnerManagementListQuery(
        new URLSearchParams({ status: "merging" }),
        "account-merges",
      ),
    ).toThrow("supported account-merges status");
  });

  it("routes the account-merge resource through a bounded, partner-safe directory projection", () => {
    const route = apiSource(
      "app/api/admin/partner-management/v1/account-merges/route.ts",
    );
    const directory = apiSource("src/lib/partner-management-directory.ts");
    const listing = directory.slice(
      directory.indexOf("async function listAccountMergeCases"),
      directory.indexOf("async function listCancellationRequests"),
    );
    expect(route).toContain('"partners.accounts.read"');
    expect(route).toContain('"account-merges"');
    expect(route).toContain("partnerManagementListResponse");
    expect(directory).toContain('case "account-merges":');
    expect(listing).toContain("sourcePartnerAccountId");
    expect(listing).toContain("targetPartnerAccountId");
    expect(listing).toContain("conflictSummary");
    expect(listing).toContain("version: String(row.revision)");
    expect(listing).not.toContain("preflightHash");
  });

  it.each([
    {
      route: "app/api/admin/partner-management/v1/account-merges/route.ts",
      method: "GET" as const,
      permissions: ["partners.accounts.read"] as const,
      risk: "read",
      principalTypes: ["human", "service"],
      requiresIdempotency: false,
      auditRequired: false,
    },
    {
      route:
        "app/api/admin/partner-management/v1/location-reviews/[reviewId]/decision/route.ts",
      method: "POST" as const,
      permissions: ["partners.accounts.manage"] as const,
      risk: "destructive",
      principalTypes: ["human"],
      requiresIdempotency: true,
      auditRequired: true,
    },
    {
      route:
        "app/api/admin/partner-management/v1/accounts/[accountId]/merge/route.ts",
      method: "POST" as const,
      permissions: ["partners.accounts.merge"] as const,
      risk: "destructive",
      principalTypes: ["human"],
      requiresIdempotency: true,
      auditRequired: true,
    },
    {
      route:
        "app/api/admin/partner-management/v1/account-merges/[caseId]/complete/route.ts",
      method: "POST" as const,
      permissions: ["partners.accounts.merge"] as const,
      risk: "destructive",
      principalTypes: ["human"],
      requiresIdempotency: true,
      auditRequired: true,
    },
  ])(
    "keeps $method $route in the Team security manifest",
    ({
      route,
      method,
      permissions,
      risk,
      principalTypes,
      requiresIdempotency,
      auditRequired,
    }) => {
      expect(routeIsInTeamSecurityScope(route)).toBe(true);
      expect(
        buildTeamRouteSecurityContract({
          route,
          method: method as TeamRouteHttpMethod,
          permissions,
        }),
      ).toMatchObject({
        route,
        method,
        requiredPermissions: permissions,
        risk,
        principalTypes,
        requiresIdempotency,
        auditRequired,
      });
    },
  );

  it("keeps address-review actions permissioned, revision-safe, and decision-confirmed", () => {
    const actions = siteSource("actions/partner-administration.ts");
    const action = exportedActionSource(
      actions,
      "partnerLocationAddressReviewDecisionAction",
    );
    expect(action).toContain(
      'hasTeamPermission(principal, "partners.accounts.manage")',
    );
    expect(action).toContain("isPositiveIntegerVersion(expectedVersion)");
    expect(action).toContain("isIdempotencyKey(idempotencyKey)");
    expect(action).toContain('decision === "verified"');
    expect(action).toContain('decision === "correction_required"');
    expect(action).toContain('decision === "dismissed"');
    for (const confirmation of [
      "VERIFY LOCATION",
      "REQUEST ADDRESS CORRECTION",
      "DISMISS ADDRESS REVIEW",
    ]) {
      expect(action).toContain(confirmation);
    }
    expect(action).toContain("confirmation !== expectedConfirmation");
    expect(action).toContain('body["latitude"] = latitude');
    expect(action).toContain('body["longitude"] = longitude');
    expect(action).toContain('body["serviceAreaEligible"]');
  });

  it("keeps account merges owner-permissioned, explicitly confirmed, and non-rewriting", () => {
    const actions = siteSource("actions/partner-administration.ts");
    const prepare = exportedActionSource(
      actions,
      "partnerAccountMergePrepareAction",
    );
    const complete = exportedActionSource(
      actions,
      "partnerAccountMergeCompleteAction",
    );
    const workspace = siteSource("components/PartnerAdministrationSection.tsx");
    for (const action of [prepare, complete]) {
      expect(action).toContain(
        'hasTeamPermission(principal, "partners.accounts.merge")',
      );
      expect(action).toContain("isPositiveIntegerVersion(expectedVersion)");
      expect(action).toContain("isIdempotencyKey(idempotencyKey)");
      expect(action).not.toContain("automaticTenantRewrite");
    }
    expect(prepare).toContain('"PREPARE PARTNER ACCOUNT MERGE"');
    expect(complete).toContain('"COMPLETE PARTNER ACCOUNT MERGE"');
    expect(prepare).toContain(
      "sourcePartnerAccountId === targetPartnerAccountId",
    );
    expect(workspace).toContain(
      'hasTeamPermission(\n    principal,\n    "partners.accounts.merge",\n  )',
    );
    expect(workspace).toContain("Type PREPARE PARTNER ACCOUNT MERGE");
    expect(workspace).toContain("Type COMPLETE PARTNER ACCOUNT MERGE");
    expect(workspace).toContain("it never moves tenant data");
    expect(workspace).toContain("No automatic cross-tenant rewrite is");
    expect(workspace).toContain(
      "Completion rechecks the live database under lock.",
    );
  });

  it("renders all address-review confirmations only for account managers", () => {
    const workspace = siteSource("components/PartnerAdministrationSection.tsx");
    expect(workspace).toContain(
      'const canManageAccounts = hasTeamPermission(\n    principal,\n    "partners.accounts.manage",\n  )',
    );
    expect(workspace).toContain(
      'display(item["state"], "") === "pending" &&\n                    canManageAccounts',
    );
    expect(workspace).toContain(
      "action={partnerLocationAddressReviewDecisionAction}",
    );
    for (const confirmation of [
      "VERIFY LOCATION",
      "REQUEST ADDRESS CORRECTION",
      "DISMISS ADDRESS REVIEW",
    ]) {
      expect(workspace).toContain(`confirmation: "${confirmation}"`);
    }
    expect(workspace).toContain("Type {decision.confirmation}");
  });
});
