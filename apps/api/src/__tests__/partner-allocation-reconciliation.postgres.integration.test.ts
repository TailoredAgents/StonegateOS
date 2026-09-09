import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  appointments,
  auditLogs,
  closeDbForTests,
  contacts,
  getDb,
  partnerAccounts,
  partnerAllocationReconciliations,
  partnerBillingDocumentOperations,
  partnerBookings,
  partnerInvoices,
  partnerPaymentAllocations,
  partnerRefundAllocations,
  paymentAttempts,
  paymentRefunds,
  payments,
  properties,
  teamMembers,
  outboxEvents,
} from "@/db";
import {
  PartnerAllocationReconciliationCommand,
  readPartnerAllocationReconciliation,
  reconcilePartnerPaymentAllocations,
} from "@/lib/partner-allocation-reconciliation";
import { runPartnerBillingCommand } from "@/lib/partner-billing-administration";
import { finalizePartnerPortalPaymentReconciliation } from "@/lib/partner-portal-v2-payments";
import { lockAppointmentInvoiceCollection } from "@/lib/partner-invoice-ledger";
import type { TeamMutationContext } from "@/lib/team-mutation";
const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (name: string, factory: () => Record<string, unknown>) => void;
const actualMutation = await import("@/lib/team-mutation");
let actorId: string | null = null;
const permission = jest
  .fn<() => Promise<Response | null>>()
  .mockResolvedValue(null);
const begin = jest.fn(
  (request: NextRequest, policy: TeamMutationContext["policy"]) => {
    if (!actorId)
      return Promise.resolve({
        ok: false as const,
        response: Response.json({ ok: false }, { status: 403 }),
      });
    const committedAt = new Date();
    const mutation = {
      actor: { id: actorId },
      principalType: "human",
      policy,
      operationId: randomUUID(),
      correlationId: randomUUID(),
      idempotencyKeyHash: createHash("sha256")
        .update(request.headers.get("Idempotency-Key") ?? "missing")
        .digest("hex"),
      expectedVersion: request.headers.get("If-Match"),
      audit: {
        insertSuccess: async (tx, input) => {
          const [audit] = await tx
            .insert(auditLogs)
            .values({
              actorType: "human",
              actorId,
              action: policy.auditAction,
              entityType: input.entityType,
              entityId: input.entityId,
              meta: input.metadata,
            })
            .returning();
          return {
            auditEventId: audit!.id,
            committedAt: committedAt.toISOString(),
          };
        },
      },
    } as TeamMutationContext;
    return Promise.resolve({ ok: true as const, mutation });
  },
);
mockModule("@/lib/team-mutation", () => ({
  ...actualMutation,
  beginTeamMutation: begin,
}));
mockModule("@/lib/permissions", () => ({
  requirePermission: permission,
}));
const { GET, POST } = await import(
  "../../app/api/admin/partner-management/v1/accounts/[accountId]/billing/reconciliation/[jobId]/route"
);
const local =
  process.env["DATABASE_URL"] &&
  ["127.0.0.1", "localhost"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
async function fixture(
  options: {
    scalar?: boolean;
    refunds?: boolean;
    pending?: boolean;
    missingPayments?: boolean;
  } = {},
) {
  const f = {
    accountId: randomUUID(),
    jobId: randomUUID(),
    appointmentId: randomUUID(),
    contactId: randomUUID(),
    propertyId: randomUUID(),
    actorId: randomUUID(),
    invoiceIds: [randomUUID(), randomUUID()],
    paymentIds: [randomUUID(), randomUUID()],
    refundId: randomUUID(),
  };
  await getDb().transaction(async (tx) => {
    await tx
      .insert(teamMembers)
      .values({ id: f.actorId, name: "Local reconciliation reviewer" });
    await tx
      .insert(partnerAccounts)
      .values({
        id: f.accountId,
        name: "Local reconciliation",
        normalizedName: f.accountId,
        status: "active_partner",
        portalAccessEnabled: true,
      });
    await tx
      .insert(contacts)
      .values({
        id: f.contactId,
        firstName: "Local",
        lastName: "Reconciliation",
      });
    await tx
      .insert(properties)
      .values({
        id: f.propertyId,
        contactId: f.contactId,
        addressLine1: "1 Test Way",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
      });
    await tx
      .insert(appointments)
      .values({
        id: f.appointmentId,
        contactId: f.contactId,
        propertyId: f.propertyId,
        partnerAccountId: f.accountId,
        type: "job",
        status: "completed",
        finalTotalCents: 20000,
        rescheduleToken: randomUUID(),
      });
    await tx
      .insert(partnerBookings)
      .values({
        id: f.jobId,
        orgContactId: f.contactId,
        partnerAccountId: f.accountId,
        appointmentId: f.appointmentId,
        propertyId: f.propertyId,
        publicStatus: "completed",
      });
    await tx
      .insert(partnerInvoices)
      .values(
        f.invoiceIds.map((id) => ({
          id,
          partnerAccountId: f.accountId,
          partnerBookingId: f.jobId,
          invoiceNumber: `RECON-${id}`,
          status: options.scalar ? "paid" : "issued",
          currency: "USD",
          subtotalCents: 10000,
          totalCents: 10000,
          paidCents: options.scalar ? 10000 : 0,
          balanceCents: options.scalar ? 0 : 10000,
          billingContact: {},
          issuedAt: new Date(),
        })),
      );
    if (!options.missingPayments)
      await tx
        .insert(payments)
        .values(
          f.paymentIds.map((id) => ({
            id,
            appointmentId: f.appointmentId,
            provider: "manual",
            providerPaymentId: id,
            amount: 10500,
            jobAmountCents: 10000,
            totalAmountCents: 10500,
            tipCents: 500,
            currency: "USD",
            method: "cash",
            status: options.pending ? "pending" : "completed",
            canonicalStatus: options.pending ? "pending" : "completed",
            providerStatus: options.pending ? "PENDING" : "COMPLETED",
          })),
        );
    if (options.refunds) {
      await tx
        .insert(paymentRefunds)
        .values({
          id: f.refundId,
          paymentId: f.paymentIds[0]!,
          provider: "manual",
          providerRefundId: f.refundId,
          amountCents: 3250,
          jobAmountCents: 3000,
          tipCents: 250,
          currency: "USD",
          canonicalStatus: "completed",
          providerStatus: "COMPLETED",
          refundedAt: new Date(),
        });
      await tx
        .update(payments)
        .set({ refundedAmountCents: 3250 })
        .where(eq(payments.id, f.paymentIds[0]!));
    }
  });
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const read = (f: Fixture) =>
  getDb().transaction((tx) =>
    readPartnerAllocationReconciliation(tx, f.accountId, f.jobId),
  );
const plan = (f: Fixture) => ({
  reason: "Matched original receipts and invoice records",
  evidenceReference: "Local test receipt evidence",
  payments: f.paymentIds.map((paymentId, index) => ({
    paymentId,
    allocations: [
      {
        invoiceId: f.invoiceIds[index]!,
        grossAmountCents: 10000,
        refunds: [] as { refundId: string; amountCents: number }[],
      },
    ],
  })),
});
async function reconcile(
  f: Fixture,
  command: Parameters<
    typeof reconcilePartnerPaymentAllocations
  >[1]["command"] = plan(f),
  revision?: string,
) {
  return getDb().transaction((tx) =>
    reconcilePartnerPaymentAllocations(tx, {
      accountId: f.accountId,
      jobId: f.jobId,
      actorId: f.actorId,
      correlationId: randomUUID(),
      expectedVersion: revision ?? null,
      command,
    }),
  );
}
suite("audited explicit financial repair in local PostgreSQL", () => {
  afterAll(closeDbForTests);
  it("repairs a legacy paid scalar from two genuine payments in one atomic plan without changing invoices, payments or job revenue", async () => {
    const f = await fixture({ scalar: true });
    const before = await read(f);
    const [jobBefore] = await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, f.appointmentId));
    await reconcile(f, plan(f), before.revision);
    const after = await read(f);
    expect(after.invoices.map((row) => row.paidCents)).toEqual([10000, 10000]);
    expect(after.payments).toEqual(before.payments);
    expect(
      after.allocations.filter((row) => row.state === "settled"),
    ).toHaveLength(2);
    expect(
      (
        await getDb()
          .select()
          .from(appointments)
          .where(eq(appointments.id, f.appointmentId))
      )[0],
    ).toEqual(jobBefore);
    expect(after.history).toHaveLength(2);
    await expect(
      getDb()
        .update(partnerAllocationReconciliations)
        .set({ reason: "Erase history" })
        .where(eq(partnerAllocationReconciliations.id, after.history[0]!.id)),
    ).rejects.toThrow();
  });
  it("does not erase unexplained paid balances, count tips, invent payments, or allow over-allocation", async () => {
    const f = await fixture({ scalar: true });
    const before = await read(f);
    const insufficient = plan(f);
    insufficient.payments.pop();
    await expect(reconcile(f, insufficient, before.revision)).rejects.toThrow(
      "historical paid balance",
    );
    const tips = plan(f);
    tips.payments[0]!.allocations[0]!.grossAmountCents = 10500;
    await expect(reconcile(f, tips, before.revision)).rejects.toThrow(
      "Exclude tips",
    );
    const nonexistent = plan(f);
    nonexistent.payments[0]!.paymentId = randomUUID();
    await expect(reconcile(f, nonexistent, before.revision)).rejects.toThrow(
      "genuine settled",
    );
    expect((await read(f)).revision).toBe(before.revision);
    expect((await read(f)).history).toEqual([]);
  });
  it("reassigns existing funds with immutable correction history and conserves total principal", async () => {
    const f = await fixture();
    await reconcile(f, plan(f), (await read(f)).revision);
    const swap = plan(f);
    swap.payments[0]!.allocations[0]!.invoiceId = f.invoiceIds[1]!;
    swap.payments[1]!.allocations[0]!.invoiceId = f.invoiceIds[0]!;
    const result = await reconcile(f, swap, (await read(f)).revision);
    const after = await read(f);
    expect(
      after.allocations
        .filter((row) => row.state === "settled")
        .reduce((sum, row) => sum + row.amountCents, 0),
    ).toBe(20000);
    expect(
      after.allocations.filter((row) => row.state === "reversed"),
    ).toHaveLength(2);
    expect(after.invoices.every((row) => row.balanceCents === 0)).toBe(true);
    expect(after.history).toHaveLength(4);
    expect(result.revision).toBe(after.revision);
  });
  it("splits historical refunds explicitly across invoices without subtracting one refund twice", async () => {
    const f = await fixture({ refunds: true });
    const command = plan(f);
    command.payments[0]!.allocations = [
      {
        invoiceId: f.invoiceIds[0]!,
        grossAmountCents: 5000,
        refunds: [{ refundId: f.refundId, amountCents: 1000 }],
      },
      {
        invoiceId: f.invoiceIds[1]!,
        grossAmountCents: 5000,
        refunds: [{ refundId: f.refundId, amountCents: 2000 }],
      },
    ];
    command.payments[1]!.allocations = [
      { invoiceId: f.invoiceIds[0]!, grossAmountCents: 5000, refunds: [] },
      { invoiceId: f.invoiceIds[1]!, grossAmountCents: 5000, refunds: [] },
    ];
    await reconcile(f, command, (await read(f)).revision);
    const after = await read(f);
    expect(
      after.invoices.find((row) => row.id === f.invoiceIds[0])!.paidCents,
    ).toBe(9000);
    expect(
      after.invoices.find((row) => row.id === f.invoiceIds[1])!.paidCents,
    ).toBe(8000);
    expect(
      after.refundAllocations.reduce((sum, row) => sum + row.jobAmountCents, 0),
    ).toBe(3000);
    const today = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    await getDb().transaction((tx) =>
      runPartnerBillingCommand(tx, {
        accountId: f.accountId,
        actorId: f.actorId,
        expectedVersion: null,
        command: {
          action: "generate_statement",
          periodStart: today,
          periodEnd: today,
          reason: "Check repaired statement",
        },
      }),
    );
    const [statement] = await getDb()
      .select()
      .from(partnerBillingDocumentOperations)
      .where(
        and(
          eq(partnerBillingDocumentOperations.partnerAccountId, f.accountId),
          eq(partnerBillingDocumentOperations.documentType, "statement"),
        ),
      );
    expect(statement!.snapshot).toMatchObject({
      statement: {
        invoiceCents: 20000,
        paymentCents: 20000,
        refundCents: 3000,
        closingBalanceCents: 3000,
      },
    });
  });
  it("preserves an audited reassignment on an old portal-settlement replay but flags altered evidence", async () => {
    const f = await fixture();
    const attemptId = randomUUID(),
      paymentId = f.paymentIds[0]!;
    await getDb()
      .insert(paymentAttempts)
      .values({
        id: attemptId,
        appointmentId: f.appointmentId,
        provider: "square",
        clientRequestId: randomUUID(),
        status: "completed",
        requestedJobAmountCents: 10000,
        currency: "USD",
        expiresAt: new Date(Date.now() + 60000),
        metadata: {
          partnerPortalPayment: {
            schemaVersion: 1,
            partnerAccountId: f.accountId,
            partnerInvoiceId: f.invoiceIds[0],
            partnerMembershipId: randomUUID(),
            partnerUserId: randomUUID(),
            purpose: "invoice_balance",
            paymentMethod: "card",
            checkoutMode: "embedded_card",
            amountMinor: 10000,
            currency: "USD",
            minorUnit: 2,
            correlationId: "local-repaired-payment-replay",
            idempotencyKeyHash: "a".repeat(64),
            providerPaymentLinkId: null,
            checkoutUrl: null,
            providerCreatedAt: null,
            allocationState: "settled",
          },
        },
      });
    await getDb()
      .update(payments)
      .set({
        paymentAttemptId: attemptId,
        provider: "square",
        method: "card",
        tenderType: "card",
      })
      .where(eq(payments.id, paymentId));
    await reconcile(f, plan(f), (await read(f)).revision);
    const swap = plan(f);
    swap.payments[0]!.allocations[0]!.invoiceId = f.invoiceIds[1]!;
    swap.payments[1]!.allocations[0]!.invoiceId = f.invoiceIds[0]!;
    await reconcile(f, swap, (await read(f)).revision);
    const before = await read(f);
    const replay = () =>
      getDb().transaction(async (tx) => {
        await lockAppointmentInvoiceCollection(tx, f.appointmentId);
        await finalizePartnerPortalPaymentReconciliation(tx, {
          status: "verified",
          appointmentId: f.appointmentId,
          attemptId,
          paymentId,
          providerPaymentId: paymentId,
        });
      });
    await replay();
    await replay();
    const after = await read(f);
    expect(after.allocations).toEqual(before.allocations);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.payments).toEqual(before.payments);
    expect(
      (
        await getDb()
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, attemptId))
      )[0]!.metadata,
    ).toMatchObject({ partnerPortalPayment: { allocationState: "settled" } });
    const settled = after.allocations.find(
      (row) => row.paymentId === paymentId && row.state === "settled",
    )!;
    await getDb()
      .update(partnerPaymentAllocations)
      .set({ amountCents: settled.amountCents - 1 })
      .where(eq(partnerPaymentAllocations.id, settled.id));
    await replay();
    expect(
      (
        await getDb()
          .select()
          .from(paymentAttempts)
          .where(eq(paymentAttempts.id, attemptId))
      )[0]!.metadata,
    ).toMatchObject({
      partnerPortalPayment: { allocationState: "needs_review" },
    });
  });
  it("retains automatic cash refunds after a repaired split and refuses an invoice's over-refund", async () => {
    const f = await fixture();
    const command = plan(f);
    command.payments[0]!.allocations = [
      { invoiceId: f.invoiceIds[0]!, grossAmountCents: 6000, refunds: [] },
      { invoiceId: f.invoiceIds[1]!, grossAmountCents: 4000, refunds: [] },
    ];
    command.payments[1]!.allocations = [
      { invoiceId: f.invoiceIds[0]!, grossAmountCents: 4000, refunds: [] },
      { invoiceId: f.invoiceIds[1]!, grossAmountCents: 6000, refunds: [] },
    ];
    await reconcile(f, command, (await read(f)).revision);
    const invoice = (await read(f)).invoices.find(
      (row) => row.id === f.invoiceIds[1],
    )!;
    const refund = (amountCents: number) =>
      getDb().transaction((tx) =>
        runPartnerBillingCommand(tx, {
          accountId: f.accountId,
          actorId: f.actorId,
          expectedVersion: String(invoice.version),
          command: {
            action: "record_manual_refund",
            invoiceId: invoice.id,
            paymentId: f.paymentIds[0]!,
            amountCents,
            reason: "Cash returned for partial service",
            confirmation: "REFUND ALREADY GIVEN",
          },
        }),
      );
    await expect(refund(5000)).rejects.toThrow("exceeds the settled service");
    await refund(2000);
    expect(
      (await read(f)).invoices.find((row) => row.id === invoice.id)!.paidCents,
    ).toBe(8000);
  });
  it("uses revision and collection locks to serialize competing repairs", async () => {
    const f = await fixture();
    const before = await read(f);
    const results = await Promise.allSettled([
      reconcile(f, plan(f), before.revision),
      reconcile(f, plan(f), before.revision),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect((await read(f)).history).toHaveLength(2);
  });
  it("rejects foreign company/job/invoice substitution and pending money", async () => {
    const f = await fixture(),
      other = await fixture();
    const wrong = plan(f);
    wrong.payments[0]!.allocations[0]!.invoiceId = other.invoiceIds[0]!;
    await expect(reconcile(f, wrong, (await read(f)).revision)).rejects.toThrow(
      "exact company",
    );
    await expect(
      getDb().transaction((tx) =>
        readPartnerAllocationReconciliation(tx, other.accountId, f.jobId),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const pending = await fixture({ pending: true });
    await expect(
      reconcile(pending, plan(pending), (await read(pending)).revision),
    ).rejects.toThrow("payment is pending");
    await expect(
      getDb()
        .insert(partnerRefundAllocations)
        .values({
          partnerAccountId: other.accountId,
          partnerInvoiceId: other.invoiceIds[0]!,
          refundId: f.refundId,
          jobAmountCents: 1,
        }),
    ).rejects.toThrow();
  });
  it("persists and replays the actual HTTP command exactly once with matching account, revision and audit evidence", async () => {
    const f = await fixture();
    actorId = f.actorId;
    const key = randomUUID(),
      before = await read(f),
      command = plan(f);
    const context = {
      params: Promise.resolve({ accountId: f.accountId, jobId: f.jobId }),
    };
    const url = `https://api.example.test/api/admin/partner-management/v1/accounts/${f.accountId}/billing/reconciliation/${f.jobId}`;
    const send = (body = command) =>
      POST(
        new NextRequest(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "If-Match": `"${before.revision}"`,
          },
          body: JSON.stringify(body),
        }),
        context,
      );
    const first = await send();
    expect(first.status).toBe(200);
    const firstBody: unknown = await first.json();
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect((await read(f)).history).toHaveLength(2);
    const conflict = await send({
      ...command,
      reason: "A materially different repair reason",
    });
    expect(conflict.status).toBe(409);
    const readResponse = await GET(new NextRequest(url), context);
    expect(readResponse.status).toBe(200);
    const data: unknown = await readResponse.json();
    expect(data).toHaveProperty("data.job");
    expect(data).not.toHaveProperty("data.job.appointmentId");
    expect(data).not.toHaveProperty(["data", "invoices", 0, "providerInvoiceId"]);
    expect(readResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(begin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        requiredPermissions: ["partners.commercial.manage"],
        risk: "financial",
        requiresIdempotency: true,
        maxAuthenticationAgeSeconds: 900,
      }),
    );
    actorId = null;
    const deniedContext = {
      get params(): Promise<{ accountId: string; jobId: string }> {
        throw new Error("denial must precede target lookup");
      },
    };
    expect(
      (await POST(new NextRequest(url, { method: "POST" }), deniedContext))
        .status,
    ).toBe(403);
  });
  const historicalPlan = (f: Fixture) => ({
    payments: [],
    reason:
      "Original dated receipt proves this previously recorded paid balance",
    evidenceReference: "Local original cash receipt review",
    historicalPayments: [
      {
        paymentId: randomUUID(),
        tenderType: "cash" as const,
        jobAmountCents: 20000,
        receivedAt: "2025-06-15T15:30:00.000Z",
        evidenceReference: "Original receipt CASH-2025-06-15",
        tipAcknowledgment: "NO_UNRECORDED_TIP" as const,
        allocations: f.invoiceIds.map((invoiceId) => ({
          invoiceId,
          grossAmountCents: 10000,
          refunds: [],
        })),
      },
    ],
  });
  it("records a genuinely missing dated historical cash receipt against the legacy paid scalar without new collection, tips, payroll or settled notices", async () => {
    const f = await fixture({ scalar: true, missingPayments: true });
    actorId = f.actorId;
    const before = await read(f),
      command = historicalPlan(f),
      key = randomUUID();
    expect(before.unexplainedPaidPrincipalCents).toBe(20000);
    const [job] = await getDb()
      .select()
      .from(appointments)
      .where(eq(appointments.id, f.appointmentId));
    const url = `https://api.example.test/api/admin/partner-management/v1/accounts/${f.accountId}/billing/reconciliation/${f.jobId}`;
    const send = () =>
      POST(
        new NextRequest(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
            "If-Match": `"${before.revision}"`,
          },
          body: JSON.stringify(command),
        }),
        { params: Promise.resolve({ accountId: f.accountId, jobId: f.jobId }) },
      );
    const first = await send();
    expect(first.status).toBe(200);
    const receipt: unknown = await first.json();
    const replay = await send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const after = await read(f);
    expect(after.payments).toHaveLength(1);
    expect(after.unexplainedPaidPrincipalCents).toBe(0);
    expect(
      after.invoices.every(
        (row) => row.paidCents === 10000 && row.balanceCents === 0,
      ),
    ).toBe(true);
    expect(after.payments[0]).toMatchObject({
      jobAmountCents: 20000,
      tipCents: 0,
      capturedAt: new Date(command.historicalPayments[0]!.receivedAt),
    });
    expect(
      (
        await getDb()
          .select()
          .from(appointments)
          .where(eq(appointments.id, f.appointmentId))
      )[0],
    ).toEqual(job);
    const [evidence] = await getDb()
      .select()
      .from(partnerAllocationReconciliations)
      .where(eq(partnerAllocationReconciliations.partnerBookingId, f.jobId));
    expect(evidence!.beforeSnapshot["payments"]).toEqual([]);
    expect(evidence!.afterSnapshot["recordedHistoricalPayments"]).toEqual(
      command.historicalPayments,
    );
    const events = await getDb()
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.type, "partner.payment.settled"));
    expect(
      events.some((event) => event.payload["partnerAccountId"] === f.accountId),
    ).toBe(false);
    const duplicated = historicalPlan(f);
    duplicated.historicalPayments[0]!.paymentId = randomUUID();
    await expect(reconcile(f, duplicated, after.revision)).rejects.toThrow(
      "genuinely missing",
    );
    actorId = null;
  });
  it("rejects fabricated over-capacity, duplicate, future-dated or unreviewed-tip historic receipt plans atomically", async () => {
    const f = await fixture({ scalar: true, missingPayments: true }),
      before = await read(f);
    const future = historicalPlan(f);
    future.historicalPayments[0]!.receivedAt = "2199-01-01T00:00:00.000Z";
    await expect(reconcile(f, future, before.revision)).rejects.toThrow(
      "actual historical receipt date",
    );
    const over = historicalPlan(f);
    over.historicalPayments[0]!.jobAmountCents = 20001;
    await expect(reconcile(f, over, before.revision)).rejects.toThrow(
      "genuinely missing",
    );
    const duplicate = historicalPlan(f);
    duplicate.historicalPayments[0]!.jobAmountCents = 10000;
    duplicate.historicalPayments[0]!.allocations = [
      { invoiceId: f.invoiceIds[0]!, grossAmountCents: 10000, refunds: [] },
    ];
    duplicate.historicalPayments.push({
      ...duplicate.historicalPayments[0]!,
      paymentId: randomUUID(),
      allocations: [
        { invoiceId: f.invoiceIds[1]!, grossAmountCents: 10000, refunds: [] },
      ],
    });
    await expect(reconcile(f, duplicate, before.revision)).rejects.toThrow(
      "already has a payment record",
    );
    const tip = historicalPlan(f);
    expect(
      PartnerAllocationReconciliationCommand.safeParse({
        ...tip,
        historicalPayments: [
          {
            ...tip.historicalPayments[0],
            tipAcknowledgment: "TIP_NEEDS_PAYROLL_REVIEW",
          },
        ],
      }).success,
    ).toBe(false);
    expect((await read(f)).revision).toBe(before.revision);
    expect((await read(f)).payments).toHaveLength(0);
    expect((await read(f)).history).toHaveLength(0);
    const alreadyFunded = await fixture({ scalar: true });
    await expect(
      reconcile(
        alreadyFunded,
        historicalPlan(alreadyFunded),
        (await read(alreadyFunded)).revision,
      ),
    ).rejects.toThrow("genuinely missing");
  });
  it("serializes competing historical receipts without manufacturing a second canonical payment", async () => {
    const f = await fixture({ scalar: true, missingPayments: true }),
      before = await read(f);
    const a = historicalPlan(f),
      b = historicalPlan(f);
    b.historicalPayments[0]!.evidenceReference =
      "Other purported source for same balance";
    const results = await Promise.allSettled([
      reconcile(f, a, before.revision),
      reconcile(f, b, before.revision),
    ]);
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
    expect((await read(f)).payments).toHaveLength(1);
    expect((await read(f)).history).toHaveLength(1);
  });
});
