import { NextResponse, type NextRequest } from "next/server";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  getDb,
  appointments,
  partnerAccounts,
  partnerBookings,
  partnerInvoices,
  partnerInvoiceLines,
  partnerPaymentAllocations,
  partnerStatements,
  payments,
} from "@/db";
import { readBoundedJsonRequest } from "@/lib/bounded-json-request";
import {
  PartnerBillingCommandSchema,
  runPartnerBillingCommand,
} from "@/lib/partner-billing-administration";
import { requirePermission } from "@/lib/permissions";
import { effectivePartnerInvoiceStatusSql } from "@/lib/partner-invoice-status";
import {
  beginTeamMutation,
  teamMutationErrorResponse,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  teamMutationIdempotencyReplayResponse,
  type TeamMutationIdempotencyClaim,
} from "@/lib/team-mutation-idempotency";

const Uuid = z.string().uuid();
const Headers = { "Cache-Control": "private, no-store", Pragma: "no-cache" };
type Context = { params: Promise<{ accountId: string }> };

export async function GET(
  request: NextRequest,
  context: Context,
): Promise<Response> {
  const denied = await requirePermission(request, "partners.commercial.read");
  if (denied) return denied;
  const account = Uuid.safeParse((await context.params).accountId);
  const query = z
    .object({
      cursor: Uuid.optional(),
      jobCursor: Uuid.optional(),
      statementCursor: Uuid.optional(),
      invoiceId: Uuid.optional(),
    })
    .safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!account.success || !query.success)
    return NextResponse.json(
      { ok: false, error: "invalid_filter" },
      { status: 400, headers: Headers },
    );
  try {
    const result = await getDb().transaction(
      async (tx) => {
        const [company] = await tx
          .select({ id: partnerAccounts.id, name: partnerAccounts.name })
          .from(partnerAccounts)
          .where(eq(partnerAccounts.id, account.data))
          .limit(1);
        if (!company) return null;
        const invoiceRows = await tx
          .select({
            id: partnerInvoices.id,
            jobId: partnerInvoices.partnerBookingId,
            number: partnerInvoices.invoiceNumber,
            currency: partnerInvoices.currency,
            status: effectivePartnerInvoiceStatusSql(),
            version: partnerInvoices.version,
            subtotalCents: partnerInvoices.subtotalCents,
            taxCents: partnerInvoices.taxCents,
            discountCents: partnerInvoices.discountCents,
            depositCents: partnerInvoices.depositCents,
            totalCents: partnerInvoices.totalCents,
            paidCents: partnerInvoices.paidCents,
            creditedCents: partnerInvoices.creditedCents,
            balanceCents: partnerInvoices.balanceCents,
            dueDate: partnerInvoices.dueDate,
            poNumber: partnerInvoices.poNumber,
            costCenter: partnerInvoices.costCenter,
            billingContact: partnerInvoices.billingContact,
            terms: partnerInvoices.terms,
            documentId: partnerInvoices.documentId,
            issuedAt: partnerInvoices.issuedAt,
          })
          .from(partnerInvoices)
          .where(
            and(
              eq(partnerInvoices.partnerAccountId, account.data),
              query.data.invoiceId
                ? eq(partnerInvoices.id, query.data.invoiceId)
                : undefined,
              !query.data.invoiceId && query.data.cursor
                ? gt(partnerInvoices.id, query.data.cursor)
                : undefined,
            ),
          )
          .orderBy(asc(partnerInvoices.id))
          .limit(26);
        if (query.data.invoiceId && !invoiceRows.length) return null;
        const invoices = invoiceRows.slice(0, 25);
        const ids = invoices.map((row) => row.id);
        const lines = ids.length
          ? await tx
              .select()
              .from(partnerInvoiceLines)
              .where(inArray(partnerInvoiceLines.partnerInvoiceId, ids))
              .orderBy(asc(partnerInvoiceLines.lineNumber))
          : [];
        const allocated = ids.length
          ? await tx
              .select({
                invoiceId: partnerPaymentAllocations.partnerInvoiceId,
                paymentId: payments.id,
                provider: payments.provider,
                method: payments.method,
                amountCents: partnerPaymentAllocations.amountCents,
                totalCents: sql<number>`coalesce(${payments.totalAmountCents}, ${payments.amount})`,
                refundedCents: payments.refundedAmountCents,
                status: payments.canonicalStatus,
              })
              .from(partnerPaymentAllocations)
              .innerJoin(
                payments,
                eq(payments.id, partnerPaymentAllocations.paymentId),
              )
              .where(
                and(
                  eq(partnerPaymentAllocations.partnerAccountId, account.data),
                  inArray(partnerPaymentAllocations.partnerInvoiceId, ids),
                ),
              )
          : [];
        const jobs = await tx
          .select({
            id: partnerBookings.id,
            service: partnerBookings.serviceKey,
            status: partnerBookings.publicStatus,
            arrivalAt: partnerBookings.arrivalWindowStartAt,
            reference: partnerBookings.projectReference,
            totalCents: sql<
              number | null
            >`coalesce(${appointments.finalTotalCents}, ${appointments.quotedTotalCents})`,
          })
          .from(partnerBookings)
          .innerJoin(
            appointments,
            eq(appointments.id, partnerBookings.appointmentId),
          )
          .where(
            and(
              eq(partnerBookings.partnerAccountId, account.data),
              query.data.jobCursor
                ? gt(partnerBookings.id, query.data.jobCursor)
                : undefined,
            ),
          )
          .orderBy(asc(partnerBookings.id))
          .limit(101);
        const statements = await tx
          .select({
            id: partnerStatements.id,
            periodStart: partnerStatements.periodStart,
            periodEnd: partnerStatements.periodEnd,
            revision: partnerStatements.revision,
            documentId: partnerStatements.documentId,
            closingBalanceCents: partnerStatements.closingBalanceCents,
          })
          .from(partnerStatements)
          .where(and(eq(partnerStatements.partnerAccountId, account.data), query.data.statementCursor ? gt(partnerStatements.id, query.data.statementCursor) : undefined))
          .orderBy(asc(partnerStatements.id))
          .limit(26);
        return {
          account: company,
          invoices: invoices.map((invoice) => ({
            ...invoice,
            lines: lines
              .filter((line) => line.partnerInvoiceId === invoice.id)
              .map(
                ({
                  description,
                  quantity,
                  unitAmountCents,
                  lineTotalCents,
                }) => ({
                  description,
                  quantity,
                  unitAmountCents,
                  lineTotalCents,
                }),
              ),
            payments: allocated.filter((row) => row.invoiceId === invoice.id),
            // Histories are independently paginated per invoice. Empty arrays
            // here must not be mistaken for a fully loaded empty history.
            historyLoaded: false,
            documents: [],
            refunds: [],
          })),
          jobs: jobs.slice(0, 100),
          statements: statements.slice(0, 25),
          nextStatementCursor: statements.length > 25 ? statements[24]!.id : null,
          nextCursor: invoiceRows.length > 25 ? invoices.at(-1)!.id : null,
          nextJobCursor: jobs.length > 100 ? jobs[99]!.id : null,
        };
      },
      { isolationLevel: "repeatable read" },
    );
    return NextResponse.json(
      result ? { ok: true, ...result } : { ok: false, error: "not_found" },
      { status: result ? 200 : 404, headers: Headers },
    );
  } catch (error) {
    return teamMutationExceptionResponse(error);
  }
}

export async function POST(
  request: NextRequest,
  context: Context,
): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.commercial.manage"],
    risk: "financial",
    requiresIdempotency: true,
    maxAuthenticationAgeSeconds: 15 * 60,
    auditAction: "partner_billing.changed",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;
  const account = Uuid.safeParse((await context.params).accountId);
  if (!account.success)
    return teamMutationErrorResponse("invalid", "Choose a valid company.", {
      correlationId: mutation.correlationId,
    });
  let claim: TeamMutationIdempotencyClaim | null = null;
  const db = getDb();
  try {
    const parsed = PartnerBillingCommandSchema.safeParse(
      await readBoundedJsonRequest(request, {
        maximumBytes: 64 * 1024,
        deadlineMs: 10_000,
        rejectDuplicateObjectKeys: true,
      }),
    );
    if (!parsed.success)
      return teamMutationErrorResponse(
        "invalid",
        "Check the invoice fields and provide a reason for the change.",
        {
          correlationId: mutation.correlationId,
          fieldErrors: Object.fromEntries(
            parsed.error.issues.map((issue) => [
              issue.path.join("."),
              issue.message,
            ]),
          ),
        },
      );
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route:
        "POST /api/admin/partner-management/v1/accounts/:accountId/billing",
      entityType: "partner_billing",
      entityId: account.data,
      payload: parsed.data,
    });
    if (claimed.kind === "replay")
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    claim = claimed.claim;
    const result = await db.transaction(
      async (tx) => {
        const changed = await runPartnerBillingCommand(tx, {
          accountId: account.data,
          actorId: mutation.actor.id!,
          command: parsed.data,
          expectedVersion: mutation.expectedVersion ?? null,
        });
        const audit = await mutation.audit.insertSuccess(tx, {
          entityType: "partner_billing",
          entityId: changed.invoiceId ?? account.data,
          after: changed,
          metadata: {
            accountId: account.data,
            action: parsed.data.action,
            reason: parsed.data.reason,
          },
        });
        const response = teamMutationSuccessResult(
          mutation,
          { accountId: account.data, ...changed },
          {
            auditEventId: audit.auditEventId,
            committedAt: audit.committedAt,
            entityType: "partner_billing",
            entityId: changed.invoiceId ?? account.data,
            ...(changed.revision ? { version: String(changed.revision) } : {}),
          },
        );
        await completeTeamMutationIdempotency(
          tx,
          mutation,
          claimed.claim,
          response,
          200,
        );
        return response;
      },
      {
        isolationLevel:
          parsed.data.action === "generate_statement"
            ? "repeatable read"
            : "read committed",
      },
    );
    return teamMutationResultResponse(
      result,
      200,
      mutation.correlationId,
      Headers,
    );
  } catch (error) {
    if (claim)
      await settleTeamMutationIdempotencyFailure(
        db,
        mutation,
        claim,
        error,
      ).catch(() => undefined);
    return teamMutationExceptionResponse(error, mutation);
  }
}
