import fs from "node:fs";
import path from "node:path";
import { billingDisputeDecisionReplayResponse } from "../../app/api/admin/partner-management/v1/billing-disputes/[requestId]/decision/route";
import {
  encodePartnerBillingDisputeHistoryCursor,
  parsePartnerBillingDisputeHistoryCursor,
  PartnerBillingDisputeRequestBodySchema,
} from "@/lib/partner-billing-dispute-requests";
import { withPartnerBillingNoStore } from "@/lib/partner-billing-route-response";
import { createPortalV2ErrorResponse } from "@/lib/portal-v2-contract";

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("Partner billing-dispute lifecycle", () => {
  it("accepts bounded immutable request evidence and rejects malformed input", () => {
    expect(
      PartnerBillingDisputeRequestBodySchema.safeParse({
        category: "refund_request",
        reason: "Please review the duplicate service charge.",
        evidence: {
          disputedAmountMinor: 12_500,
          reference: "AP-992",
          details: null,
        },
      }).success,
    ).toBe(true);
    expect(
      PartnerBillingDisputeRequestBodySchema.safeParse({
        category: "refund_request",
        reason: "short",
        evidence: {
          disputedAmountMinor: -1,
          reference: null,
          details: null,
        },
      }).success,
    ).toBe(false);
    expect(
      PartnerBillingDisputeRequestBodySchema.safeParse({
        category: "refund_request",
        reason: "Please review the duplicate service charge.",
        evidence: {
          disputedAmountMinor: null,
          reference: null,
          details: null,
          providerPayload: {},
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the account/invoice/thread binding, open guard, and evidence immutable", () => {
    const migration = source(
      "src/db/migrations/0162_partner_billing_dispute_requests.sql",
    );
    expect(migration).toContain(
      'FOREIGN KEY ("partner_account_id", "partner_invoice_id")',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("requested_by_membership_id", "partner_account_id")',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("partner_account_id", "conversation_thread_id")',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("partner_account_id", "partner_booking_id")',
    );
    expect(migration).toContain("\"thread_scope\" = 'account_billing'");
    expect(migration).toContain(
      '"request_snapshot" @> \'{"version": 1}\'::jsonb',
    );
    expect(migration).toContain(
      '"request_snapshot" ? \'replayReceipt\'',
    );
    expect(migration).toContain('"monetaryMutationPerformed": false');
    expect(migration).toContain('"providerActionPerformed": false');
    expect(migration).toContain(
      'VALIDATE CONSTRAINT "partner_invoices_account_booking_fk"',
    );
    expect(migration).toContain(
      "\"staff_scope\" IN ('general', 'partner_billing')",
    );
    expect(migration).toContain(
      "partner_billing_dispute_invoice_booking_mismatch",
    );
    expect(migration).toContain("partner_billing_dispute_thread_not_financial");
    expect(migration).toContain(
      "conversation_thread_has_billing_dispute_conflict",
    );
    expect(migration).toContain("conversation_thread_staff_scope_immutable");
    expect(migration).toContain(
      '"partner_billing_disputes_pending_invoice_key"',
    );
    expect(migration).toContain("WHERE \"state\" = 'pending'");
    expect(migration).toContain(
      "partner_billing_dispute_request_evidence_immutable",
    );
    expect(migration).toContain("OLD.\"state\" <> 'pending'");
  });

  it("requires invoice access, recent partner MFA, origin, CAS, and idempotency", () => {
    const route = source(
      "app/api/portal/v2/invoices/[invoiceId]/dispute-requests/route.ts",
    );
    const service = source("src/lib/partner-billing-dispute-requests.ts");
    expect(route).toContain("requireRecentPartnerMfaCapability");
    expect(route).toContain('"invoices.disputes.request"');
    expect(route).toContain("isAllowedPartnerPortalMutationOrigin");
    expect(route).toContain("readPortalV2IdempotencyKey");
    expect(route).toContain('request.headers.get("if-match")');
    expect(service).toContain("createPartnerInvoiceAccessCondition(access)");
    expect(service).toContain("assertInvoiceRevision(invoice, input.ifMatch)");
    expect(service).toContain("acquireBillingDisputeLock");
    expect(service).toContain("acquireBillingDisputeOperationLock");
    expect(service).toContain("operationKeyHash");
    expect(service).toContain("rawBookingId: partnerInvoices.partnerBookingId");
    expect(service).toContain("bookingId: partnerBookings.id");
    expect(service).toContain("if (row?.rawBookingId && !row.bookingId)");
    expect(route).toContain("parsePartnerBillingDisputeHistoryCursor");
    expect(route).toContain("nextCursor: result.nextCursor");
    expect(service).toContain("MAX_HISTORY_PAGE_SIZE");
  });

  it("preserves the pending-request conflict as a stable 409 envelope", () => {
    expect(
      createPortalV2ErrorResponse(
        "billing_request_pending",
        "billing-dispute-correlation-0001",
      ),
    ).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error: "billing_request_pending",
        retryable: false,
      },
    });
    const component = source(
      "../site/src/app/partners/components/PartnerInvoiceDisputeManager.tsx",
    );
    expect(component).toContain('code === "billing_request_pending"');
  });

  it("uses canonical invoice-bound history cursors", () => {
    const invoiceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const cursor = encodePartnerBillingDisputeHistoryCursor({
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      invoiceId,
    });
    expect(parsePartnerBillingDisputeHistoryCursor(cursor, invoiceId)).toEqual({
      createdAt: new Date("2026-09-02T12:00:00.000Z"),
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      invoiceId,
      version: 1,
    });
    expect(
      parsePartnerBillingDisputeHistoryCursor(
        cursor,
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      ),
    ).toBe("invalid");
    expect(parsePartnerBillingDisputeHistoryCursor(`${cursor}=`, invoiceId)).toBe(
      "invalid",
    );
  });

  it("stores and reuses the immutable create response on idempotent replay", () => {
    const service = source("src/lib/partner-billing-dispute-requests.ts");
    const route = source(
      "app/api/portal/v2/invoices/[invoiceId]/dispute-requests/route.ts",
    );
    expect(service).toContain("replayReceipt");
    expect(service).toContain("item: initialPublicItem(replay)");
    expect(service).not.toContain("item: publicItem(replay)");
    expect(route).toContain("result.response.correlationId");
    expect(route).toContain("result.response.status");
    expect(route).toContain("ETag: result.response.etag");
    expect(route).not.toContain("result.replayed ? 200 : 201");
  });

  it("forces no-store onto delegated Staff billing failures", () => {
    const protectedResponse = withPartnerBillingNoStore(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    expect(protectedResponse.headers.get("cache-control")).toBe(
      "private, no-store, max-age=0",
    );
    expect(protectedResponse.headers.get("pragma")).toBe("no-cache");

    for (const route of [
      "app/api/admin/partner-management/v1/billing-disputes/route.ts",
      "app/api/admin/partner-management/v1/billing-disputes/[requestId]/route.ts",
      "app/api/admin/partner-management/v1/billing-disputes/[requestId]/decision/route.ts",
    ]) {
      expect(source(route)).toContain("withPartnerBillingNoStore");
    }
  });

  it("makes Staff decisions classification-only, recent-MFA, CAS, and audited", () => {
    const route = source(
      "app/api/admin/partner-management/v1/billing-disputes/[requestId]/decision/route.ts",
    );
    const service = source("src/lib/partner-billing-dispute-requests.ts");
    expect(route).toContain(
      'requiredPermissions: ["partners.billing_disputes.decide"]',
    );
    expect(route).toContain('risk: "financial"');
    expect(route).toContain("maxAuthenticationAgeSeconds: 15 * 60");
    expect(route).toContain("claimTeamMutationIdempotency");
    expect(route).toContain("mutation.audit.insertSuccess");
    expect(route).toContain('"Cache-Control": "private, no-store"');
    expect(route).toContain("replayVersion");
    expect(service).toContain("assertTeamMutationExpectedVersion");
    expect(service).toContain("monetaryMutationPerformed: false");
    expect(service).toContain("providerActionPerformed: false");
    expect(service).not.toContain("update(partnerInvoices)");
    expect(service).not.toContain("partnerPaymentAllocations");
    expect(service).not.toContain("providerInvoiceId");
    expect(service).toContain('.for("update")');
  });

  it("replays the stored Staff receipt with no-store and its exact revision ETag", async () => {
    const result = {
      ok: true as const,
      data: { state: "refund_review" },
      receipt: {
        operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        correlationId: "billing-decision-original",
        actorId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        committedAt: "2026-09-02T12:00:00.000Z",
        auditEventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        entityType: "partner_billing_dispute_request",
        entityId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        version: "2",
      },
    };
    const response = billingDisputeDecisionReplayResponse({
      result,
      status: 200,
      correlationId: result.receipt.correlationId,
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toBe('"2"');
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    await expect(response.json()).resolves.toEqual(result);
  });

  it("keeps notification/outbox payloads free of Partner free-form evidence", () => {
    const service = source("src/lib/partner-billing-dispute-requests.ts");
    for (const eventType of [
      "partner.billing_dispute.requested",
      "partner.billing_dispute.resolved",
    ]) {
      const start = service.indexOf(`type: "${eventType}"`);
      expect(start).toBeGreaterThan(0);
      const payload = service.slice(
        start,
        service.indexOf("createdAt:", start),
      );
      expect(payload).not.toContain("reason:");
      expect(payload).not.toContain("evidence:");
    }
    expect(service).toContain("id: input.requestId");
    expect(service).toContain('scope: "account_billing"');
    expect(service).toContain("partnerBookingId: null");
    expect(service).not.toContain('scope: "job"');
    const processor = source("src/lib/outbox-processor.ts");
    expect(processor).toContain('case "partner.billing_dispute.requested"');
    expect(processor).toContain('case "partner.billing_dispute.resolved"');
    expect(processor).toContain("queuePartnerBillingDisputeNotification");
    const delivery = source("src/lib/partner-notification-delivery.ts");
    expect(delivery).toContain('"billing.dispute_requested"');
    expect(delivery).toContain('"billing.dispute_resolved"');
    expect(delivery).toContain('actionPath: "/partners/billing"');
    expect(service).toContain('kind: "partner_billing_dispute_requested"');
  });

  it("does not grant billing decisions through the Access Administrator compatibility path", () => {
    const contracts = source("../../packages/sdk/src/team-contracts.ts");
    const writeCompatibility = contracts.slice(
      contracts.indexOf('"partners.write": ['),
      contracts.indexOf('"partners.invite": ['),
    );
    const commercialCompatibility = contracts.slice(
      contracts.indexOf('"partners.rates": ['),
      contracts.indexOf(
        "] as const satisfies",
        contracts.indexOf('"partners.rates": ['),
      ),
    );
    expect(writeCompatibility).not.toContain(
      "partners.billing_disputes.decide",
    );
    expect(commercialCompatibility).toContain(
      "partners.billing_disputes.decide",
    );
  });
});
