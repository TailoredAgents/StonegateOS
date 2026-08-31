import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePartnerStaffPreviewResponse } from "../../../site/src/app/team/partner-preview";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function validResponse() {
  return {
    ok: true,
    correlationId: "staff-preview-parser-test",
    readOnly: true,
    preview: {
      readOnly: true,
      previewScope: "account",
      account: {
        id: ACCOUNT_ID,
        name: "Acme Property Group",
        status: "portal_partner",
        portalAccessEnabled: true,
        createdAt: "2026-08-31T12:00:00.000Z",
        updatedAt: "2026-08-31T12:00:00.000Z",
      },
      summary: {
        activeMemberCount: 2,
        activeLocationCount: 3,
        totalJobCount: 1,
        statusCounts: { confirmed: 1 },
        outstandingBalances: [
          { amountMinor: 2_500, currency: "USD", minorUnit: 2 },
        ],
      },
      jobs: [
        {
          id: JOB_ID,
          status: "confirmed",
          confirmationMode: "instant",
          service: { key: "junk_removal", tierKey: "standard" },
          schedule: {
            arrivalWindow: {
              startAt: "2026-09-02T13:00:00.000Z",
              endAt: "2026-09-02T15:00:00.000Z",
              timezone: "America/New_York",
            },
            completedAt: null,
          },
          location: {
            id: "33333333-3333-4333-8333-333333333333",
            name: "North Campus",
            address: {
              line1: "100 Main Street",
              city: "Atlanta",
              state: "GA",
              postalCode: "30303",
            },
          },
          references: {
            poNumber: "PO-100",
            costCenter: null,
            project: null,
          },
          financial: { amountMinor: 25_000, currency: "USD", minorUnit: 2 },
          allowedActions: [],
          createdAt: "2026-08-31T12:00:00.000Z",
          updatedAt: "2026-08-31T12:00:00.000Z",
        },
      ],
      page: { limit: 100, returned: 1, hasMore: false },
      selectedJob: null,
    },
  };
}

describe("Partner Portal staff preview contracts", () => {
  it("accepts only a strict read-only account response", () => {
    const parsed = parsePartnerStaffPreviewResponse(validResponse());
    expect(parsed).toMatchObject({
      readOnly: true,
      previewScope: "account",
      account: { id: ACCOUNT_ID },
      jobs: [{ id: JOB_ID, allowedActions: [] }],
    });

    const actionable = validResponse();
    actionable.preview.jobs[0]!.allowedActions = ["reschedule"];
    expect(parsePartnerStaffPreviewResponse(actionable)).toBeNull();

    const leakedInternalField = validResponse() as ReturnType<
      typeof validResponse
    > & { preview: { appointmentId?: string } };
    leakedInternalField.preview.appointmentId =
      "44444444-4444-4444-8444-444444444444";
    expect(parsePartnerStaffPreviewResponse(leakedInternalField)).toBeNull();
  });

  it("uses one account-bound read model without partner-session impersonation", () => {
    const model = source("src/lib/partner-portal-staff-preview.ts");
    expect(model).toContain(
      "eq(partnerBookings.partnerAccountId, account.id)",
    );
    expect(model).toContain(
      "eq(partnerBookings.partnerAccountId, accountId)",
    );
    expect(model).toContain(
      "eq(partnerJobEvents.partnerAccountId, accountId)",
    );
    expect(model).toContain(
      "eq(partnerJobEvidence.partnerAccountId, accountId)",
    );
    expect(model).toContain(
      "eq(partnerDocuments.partnerAccountId, accountId)",
    );
    expect(model).toContain(
      "eq(partnerInvoices.partnerAccountId, accountId)",
    );
    expect(model).toContain("eq(conversationThreads.portalVisible, true)");
    expect(model.match(/allowedActions: Object\.freeze\(\[\]\)/gu)).toHaveLength(
      2,
    );
    expect(model).not.toContain("resolvePartnerPrincipal");
    expect(model).not.toContain("requirePartnerSession");
    expect(model).not.toContain("hostedPaymentUrl:");
    expect(model).not.toContain("accessSecretCiphertext:");
    expect(model).not.toContain("storageObjectKey:");
  });

  it("exposes one audited GET and no mutation handler", () => {
    const route = source(
      "app/api/admin/partners/portal-preview/[orgContactId]/route.ts",
    );
    const permissionIndex = route.indexOf(
      "await requirePermission(request, REQUIRED_PERMISSION)",
    );
    const loadIndex = route.indexOf("await loadPartnerStaffPreview(");
    const successAuditIndex = route.indexOf(
      'action: "partner_portal.staff_preview.viewed"',
    );
    const responseIndex = route.indexOf("return NextResponse.json(", loadIndex);

    expect(route).toContain('const REQUIRED_PERMISSION = "partners.read"');
    expect(permissionIndex).toBeGreaterThan(0);
    expect(permissionIndex).toBeLessThan(loadIndex);
    expect(successAuditIndex).toBeGreaterThan(loadIndex);
    expect(successAuditIndex).toBeLessThan(responseIndex);
    expect(route).toContain('action: "partner_portal.staff_preview.denied"');
    expect(route).toContain('error: "not_found"');
    expect(route).toContain('"Cache-Control": "private, no-store');
    expect(route).not.toMatch(
      /export async function (?:POST|PUT|PATCH|DELETE)\b/u,
    );
  });

  it("renders a conspicuous non-actionable preview inside Team partner management", () => {
    const component = source(
      "../site/src/app/team/components/PartnerPortalReadOnlyPreview.tsx",
    );
    const partners = source(
      "../site/src/app/team/components/PartnersSection.tsx",
    );
    const teamPage = source("../site/src/app/team/page.tsx");

    expect(component).toContain("Read-only support preview");
    expect(component).toContain("It does not\n            create a partner session");
    expect(component).toContain(
      'data-partner-preview-mutations="disabled"',
    );
    expect(component).toContain("All job actions are disabled");
    expect(component).not.toContain("<form");
    expect(component).not.toContain("PartnerJobActions");
    expect(component).not.toContain("PartnerInvoicePayment");
    expect(component).not.toContain("PartnerJobMessages");
    expect(component).not.toContain("PartnerDocumentDownloadButton");
    expect(partners).toContain("Read-only portal preview");
    expect(partners.indexOf("if (previewMode && selectedId)")).toBeLessThan(
      partners.indexOf("let members: TeamMember[]"),
    );
    expect(teamPage).toContain("p_preview_job?: string");
  });
});
