import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasRecentPartnerMfa,
  PARTNER_RECENT_MFA_CLOCK_SKEW_MS,
  PARTNER_RECENT_MFA_WINDOW_MS,
} from "@/lib/partner-recent-mfa";

const REPO_ROOT = resolve(process.cwd(), "../..");
const ROUTE_ROOT = resolve(REPO_ROOT, "apps/api/app/api/portal/v2");

function context(assuranceLevel: "aal1" | "aal2", mfaVerifiedAt: Date | null) {
  return { session: { assuranceLevel, mfaVerifiedAt } };
}

function routeSource(relativePath: string): string {
  return readFileSync(resolve(ROUTE_ROOT, relativePath), "utf8");
}

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

describe("canonical Partner recent-MFA boundary", () => {
  const now = new Date("2026-09-01T16:00:00.000Z");

  it("accepts the exact fifteen-minute boundary and rejects one millisecond older", () => {
    expect(
      hasRecentPartnerMfa(
        context("aal2", new Date(now.getTime() - PARTNER_RECENT_MFA_WINDOW_MS)),
        now,
      ),
    ).toBe(true);
    expect(
      hasRecentPartnerMfa(
        context(
          "aal2",
          new Date(now.getTime() - PARTNER_RECENT_MFA_WINDOW_MS - 1),
        ),
        now,
      ),
    ).toBe(false);
  });

  it("allows bounded future clock skew and fails closed beyond it", () => {
    expect(
      hasRecentPartnerMfa(
        context(
          "aal2",
          new Date(now.getTime() + PARTNER_RECENT_MFA_CLOCK_SKEW_MS),
        ),
        now,
      ),
    ).toBe(true);
    expect(
      hasRecentPartnerMfa(
        context(
          "aal2",
          new Date(now.getTime() + PARTNER_RECENT_MFA_CLOCK_SKEW_MS + 1),
        ),
        now,
      ),
    ).toBe(false);
  });

  it("rejects AAL1, missing proof, and invalid timestamps", () => {
    expect(hasRecentPartnerMfa(context("aal1", now), now)).toBe(false);
    expect(hasRecentPartnerMfa(context("aal2", null), now)).toBe(false);
    expect(
      hasRecentPartnerMfa(context("aal2", new Date(Number.NaN)), now),
    ).toBe(false);
  });
});

describe("privileged Partner mutation inventory", () => {
  const directRoutes = [
    "invitations/route.ts",
    "invitations/[invitationId]/route.ts",
    "join-requests/[requestId]/route.ts",
    "members/[membershipId]/route.ts",
    "approval-requests/[requestId]/decision/route.ts",
    "invoices/[invoiceId]/payment-link/route.ts",
    "jobs/[jobId]/references/route.ts",
    "payment-intents/route.ts",
    "payment-intents/[paymentIntentId]/complete/route.ts",
  ];

  it.each(directRoutes)("uses the canonical boundary in %s", (path) => {
    const source = routeSource(path);
    expect(source).toContain("requireRecentPartnerMfaCapability");
  });

  it("covers account-profile and notification mutations through canonical adapters", () => {
    expect(routeSource("account-profile/route.ts")).toContain(
      "hasRecentPartnerMfa(principal)",
    );
    const notificationAuthorization = readFileSync(
      resolve(
        REPO_ROOT,
        "apps/api/src/lib/partner-notification-endpoint-authorization.ts",
      ),
      "utf8",
    );
    expect(notificationAuthorization).toContain(
      "hasRecentPartnerMfa(authorization.principal)",
    );
    for (const path of [
      "notification-endpoints/route.ts",
      "notification-endpoints/[endpointId]/route.ts",
      "notification-endpoints/[endpointId]/verify/route.ts",
    ]) {
      expect(routeSource(path)).toContain(
        "requirePartnerNotificationEndpointMutationAccess",
      );
    }
  });

  it("keeps the explicit privileged-capability mutation inventory closed", () => {
    const protectedCapability =
      /"(?:account\.members\.manage|account\.security\.manage|approvals\.decide|payments\.initiate|commercial\.edit)"/u;
    const mutationExport = /export async function (?:POST|PATCH|PUT|DELETE)\b/u;
    const discovered = routeFiles(ROUTE_ROOT)
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return protectedCapability.test(source) && mutationExport.test(source);
      })
      .map((path) => path.slice(ROUTE_ROOT.length + 1))
      .sort();
    expect(discovered).toEqual(
      [...directRoutes, "account-profile/route.ts"].sort(),
    );
  });

  it("does not use an assurance-level-only mutation check", () => {
    for (const path of [...directRoutes, "account-profile/route.ts"]) {
      const source = routeSource(path);
      const mutationStart = source.search(
        /export async function (?:POST|PATCH|PUT|DELETE)\b/u,
      );
      expect(mutationStart).toBeGreaterThanOrEqual(0);
      expect(source.slice(mutationStart)).not.toMatch(
        /session\.assuranceLevel\s*!==\s*"aal2"/u,
      );
    }
  });

  it("keeps Site recovery wired to the purpose-built MFA step-up endpoint", () => {
    for (const path of [
      "apps/site/src/app/partners/components/PartnerAccountSecurityManager.tsx",
      "apps/site/src/app/partners/components/PartnerApprovalWorkspace.tsx",
      "apps/site/src/app/partners/components/PartnerInvoicePayment.tsx",
    ]) {
      expect(readFileSync(resolve(REPO_ROOT, path), "utf8")).toContain(
        '"mfa/step-up"',
      );
    }
  });
});
