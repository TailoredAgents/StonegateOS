import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import {
  type PartnerMultiServiceRequest,
  partnerServiceRateSnapshotSchema,
} from "@myst-os/sdk";
import { multiplyPartnerRateToCents } from "@myst-os/pricing";
import {
  appointments,
  partnerBookings,
  partnerBookingServiceLines,
  partnerBookingVisits,
  partnerBookingVisitLines,
  partnerApprovalRequests,
  partnerJobEvents,
  partnerSchedulingProfiles,
  scheduleResources,
  scheduleResourcePools,
  outboxEvents,
  payments,
  paymentAttempts,
  partnerInvoices,
  partnerJobEvidence,
  mediaAssets,
  type DatabaseClient,
} from "@/db";
import {
  TeamMutationFailure,
  assertTeamMutationExpectedVersion,
  type TeamMutationTransaction,
  type TeamMutationContext,
} from "./team-mutation";
import { lockPartnerRequestFinancials } from "./partner-request-financials";
import { evaluatePartnerProofCompletion } from "./partner-proof-completion";
import { enqueueOwnerAlertEvaluation } from "./partner-owner-alerts";
import { loadPartnerServiceRateSnapshot } from "./partner-structured-rates";
import {
  resolveApplicableServiceRates,
  type ServiceLineRateEvidence,
} from "./partner-multi-service-rates";
import {
  acquireScheduleConflictLock,
  inspectScheduleConflicts,
} from "./appointment-schedule-conflicts";
import { resolveEasternAppointmentTime } from "./appointment-time";
import { getBusinessHoursPolicy, getBookingRulesPolicy } from "./policy";
import { partnerStaffArrivalWindow } from "./partner-staff-schedule";
import {
  loadNamedResourcePlan,
  loadNamedResourceBlocks,
  type NamedResourcePlan,
} from "./scheduling-resource-store";
import {
  assignNamedScheduleResources,
  type NamedScheduleResourceRequirement,
} from "./scheduling";
import { buildPartnerApprovalRequestInsert } from "./partner-portal-v2-approvals";
import {
  type PartnerMultiServicePriceSchema,
  type PartnerMultiServiceVisitSchema,
  type PartnerMultiServiceVisitStatusSchema,
  requiredVisitMinimum,
  requiredServiceRateVariants,
  multiServiceParentStatus,
  unscheduledMultiServiceLineIds,
  resolveMultiServiceApproval,
  sumExplicitLinePrices,
} from "./partner-multi-service-domain";
import type { z } from "zod";

type Reader = Pick<DatabaseClient, "select">;
type VisitMutationContext = Pick<
  TeamMutationContext,
  "expectedVersion" | "correlationId"
> & { actor: Pick<TeamMutationContext["actor"], "id"> };
type Visibility = {
  financials?: boolean;
  rates?: boolean;
  photos?: boolean;
  billing?: boolean;
  completion?: boolean;
  currentRates?: boolean;
};
function publicRateSnapshot(
  value: Record<string, unknown> | null,
  visible: boolean,
  line: Pick<ServiceLineRateEvidence, "serviceKey" | "scope">,
) {
  if (!visible)
    return {
      versionId: null,
      currency: "USD",
      visitMinimum: null,
      rates: [],
      status: "hidden" as const,
    };
  if (!value)
    return {
      versionId: null,
      currency: "USD",
      visitMinimum: null,
      rates: [],
      status: "missing" as const,
    };
  const quoteRequired =
    Array.isArray(value["quoteRequiredServiceKeys"]) &&
    value["quoteRequiredServiceKeys"].includes(line.serviceKey);
  const parsed = partnerServiceRateSnapshotSchema.safeParse({
    versionId: value["rateCardVersionId"] ?? null,
    currency: value["currency"] ?? "USD",
    visitMinimum: value["visitMinimum"] ?? null,
    rates: value["rates"] ?? [],
    status: "published",
  });
  if (!parsed.success) throw new Error("partner_service_rate_snapshot_invalid");
  return {
    ...parsed.data,
    status: quoteRequired
      ? ("quote_required" as const)
      : requiredServiceRateVariants(line.serviceKey, line.scope).every(
            (variant) =>
              parsed.data.rates.some((rate) => rate.variantKey === variant),
          )
        ? ("published" as const)
        : ("missing" as const),
  };
}

export async function getPartnerMultiServiceRequest(
  db: Reader,
  accountId: string,
  bookingId: string,
  visibility: Visibility = {},
): Promise<PartnerMultiServiceRequest | null> {
  const [parent] = await db
    .select()
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.partnerAccountId, accountId),
        eq(partnerBookings.id, bookingId),
        eq(partnerBookings.modelVersion, 2),
      ),
    )
    .limit(1);
  if (!parent) return null;
  const [lines, visits, mappings] = await Promise.all([
    db
      .select()
      .from(partnerBookingServiceLines)
      .where(
        and(
          eq(partnerBookingServiceLines.partnerAccountId, accountId),
          eq(partnerBookingServiceLines.partnerBookingId, bookingId),
        ),
      )
      .orderBy(asc(partnerBookingServiceLines.position)),
    db
      .select({ visit: partnerBookingVisits, appointment: appointments })
      .from(partnerBookingVisits)
      .innerJoin(
        appointments,
        eq(appointments.id, partnerBookingVisits.appointmentId),
      )
      .where(
        and(
          eq(partnerBookingVisits.partnerAccountId, accountId),
          eq(partnerBookingVisits.partnerBookingId, bookingId),
        ),
      )
      .orderBy(asc(appointments.startAt)),
    db
      .select()
      .from(partnerBookingVisitLines)
      .where(
        and(
          eq(partnerBookingVisitLines.partnerAccountId, accountId),
          eq(partnerBookingVisitLines.partnerBookingId, bookingId),
        ),
      ),
  ]);
  const money = visibility.financials === true;
  const currentRates = visibility.currentRates
    ? await Promise.all(
        lines.map((line) =>
          resolveApplicableServiceRates(line, () =>
            loadPartnerServiceRateSnapshot(db, {
              accountId,
              serviceKey: line.serviceKey,
            }),
          ),
        ),
      )
    : [];
  return {
    modelVersion: 2,
    version: parent.version,
    pricingVersion: parent.pricingVersion,
    quotedTotalCents: money ? parent.quotedTotalCents : null,
    finalTotalCents: money ? parent.finalTotalCents : null,
    unscheduledServiceLineIds: unscheduledMultiServiceLineIds(
      lines,
      visits.map(({ visit }) => ({
        ...visit,
        serviceLineIds: mappings
          .filter((mapping) => mapping.visitId === visit.id)
          .map((mapping) => mapping.serviceLineId),
      })),
    ),
    serviceLines: lines.map((line, index) => ({
      photoEvidenceIds: visibility.photos
        ? Object.entries(
            ((
              parent.scopeSnapshot?.["scope"] as
                | Record<string, unknown>
                | undefined
            )?.["photoServiceAssociations"] as Record<string, string[]>) ?? {},
          )
            .filter(([, ids]) => Array.isArray(ids) && ids.includes(line.id))
            .map(([id]) => id)
        : [],
      currentRateSnapshot: visibility.currentRates
        ? publicRateSnapshot(currentRates[index] ?? null, true, line)
        : undefined,
      id: line.id,
      serviceKey: line.serviceKey,
      label: line.serviceLabel,
      description: line.description,
      scope: line.scope as Record<string, string>,
      selectedAddOns: line.selectedAddOns,
      proofRequirements: line.proofRequirements,
      status: line.status,
      rateSnapshot: publicRateSnapshot(
        line.rateSnapshot,
        (visibility.rates ?? money) &&
          (visibility.currentRates === true ||
            line.rateSnapshot?.["portalVisible"] !== false),
        line,
      ),
      pricingSnapshot: publicRateSnapshot(
        line.pricingSnapshot,
        (visibility.rates ?? money) &&
          (visibility.currentRates === true ||
            line.pricingSnapshot?.["portalVisible"] !== false),
        line,
      ),
      quotedAmountCents: money ? line.quotedAmountCents : null,
      priceDescription: money ? line.priceDescription : null,
    })),
    visits: visits.map(({ visit, appointment }) => {
      if (!appointment.startAt)
        throw new Error("partner_visit_missing_schedule");
      return {
        id: visit.id,
        appointmentId: visit.appointmentId,
        status: visit.status,
        serviceLineIds: mappings
          .filter((line) => line.visitId === visit.id)
          .map((line) => line.serviceLineId),
        startAt: appointment.startAt.toISOString(),
        endAt: new Date(
          appointment.startAt.getTime() + appointment.durationMinutes * 60000,
        ).toISOString(),
        arrivalStartAt:
          appointment.promisedArrivalStartAt?.toISOString() ?? null,
        arrivalEndAt: appointment.promisedArrivalEndAt?.toISOString() ?? null,
        timezone: appointment.schedulingTimezone ?? "America/New_York",
        version: visit.version,
        minimumAmountCents: money ? visit.minimumAmountCents : null,
      };
    }),
  };
}

async function lockParent(
  tx: TeamMutationTransaction,
  mutation: VisitMutationContext,
  accountId: string,
  bookingId: string,
) {
  await lockPartnerRequestFinancials(tx, accountId, bookingId);
  const [parent] = await tx
    .select()
    .from(partnerBookings)
    .where(
      and(
        eq(partnerBookings.partnerAccountId, accountId),
        eq(partnerBookings.id, bookingId),
      ),
    )
    .limit(1);
  if (!parent || parent.modelVersion !== 2)
    throw new TeamMutationFailure(
      "invalid",
      "Choose a multi-service request.",
      { status: 404 },
    );
  if (!mutation.expectedVersion || mutation.expectedVersion === "*")
    throw new TeamMutationFailure(
      "invalid",
      "Refresh the request before changing it.",
    );
  assertTeamMutationExpectedVersion(mutation, parent.version);
  if (["completed", "canceled", "declined"].includes(parent.publicStatus))
    throw new TeamMutationFailure(
      "conflict",
      "This request is closed. Create an additional service request for new work.",
    );
  return parent;
}
async function serviceLines(tx: Reader, accountId: string, bookingId: string) {
  return tx
    .select()
    .from(partnerBookingServiceLines)
    .where(
      and(
        eq(partnerBookingServiceLines.partnerAccountId, accountId),
        eq(partnerBookingServiceLines.partnerBookingId, bookingId),
      ),
    )
    .orderBy(asc(partnerBookingServiceLines.position));
}
async function visitsFor(tx: Reader, accountId: string, bookingId: string) {
  const visits = await tx
    .select()
    .from(partnerBookingVisits)
    .where(
      and(
        eq(partnerBookingVisits.partnerAccountId, accountId),
        eq(partnerBookingVisits.partnerBookingId, bookingId),
      ),
    );
  const mappings = await tx
    .select()
    .from(partnerBookingVisitLines)
    .where(
      and(
        eq(partnerBookingVisitLines.partnerAccountId, accountId),
        eq(partnerBookingVisitLines.partnerBookingId, bookingId),
      ),
    );
  return visits.map((visit) => ({
    ...visit,
    serviceLineIds: mappings
      .filter((mapping) => mapping.visitId === visit.id)
      .map((mapping) => mapping.serviceLineId),
  }));
}
async function requireRates(
  tx: TeamMutationTransaction,
  accountId: string,
  lines: readonly (ServiceLineRateEvidence & { serviceLabel: string })[],
  now: Date,
) {
  const snapshots = [];
  for (const line of lines) {
    const snapshot = await resolveApplicableServiceRates(line, () =>
      loadPartnerServiceRateSnapshot(tx, {
        accountId,
        serviceKey: line.serviceKey,
        now,
      }),
    );
    if (!snapshot)
      throw new TeamMutationFailure(
        "conflict",
        `Publish agreed rates or Quote required for ${line.serviceLabel} before pricing or scheduling it.`,
        {
          fieldErrors: {
            rates:
              "Publish rates for each requested variant or mark the service Quote required.",
          },
        },
      );
    snapshots.push(snapshot);
  }
  return snapshots;
}

export async function pricePartnerMultiServiceRequest(
  tx: TeamMutationTransaction,
  mutation: VisitMutationContext,
  bookingId: string,
  input: z.infer<typeof PartnerMultiServicePriceSchema>,
  now = new Date(),
) {
  const parent = await lockParent(tx, mutation, input.accountId, bookingId);
  const lines = await serviceLines(tx, input.accountId, bookingId);
  let total: number;
  try {
    total = sumExplicitLinePrices(lines, input.linePrices);
  } catch (error) {
    throw new TeamMutationFailure(
      "invalid",
      error instanceof Error ? error.message : "Review all service prices.",
    );
  }
  const [snapshots, visits, ledger, attempts, invoices] = await Promise.all([
    requireRates(tx, input.accountId, lines, now),
    visitsFor(tx, input.accountId, bookingId),
    tx
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.partnerBookingId, bookingId))
      .limit(1),
    tx
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(eq(paymentAttempts.partnerBookingId, bookingId))
      .limit(1),
    tx
      .select()
      .from(partnerInvoices)
      .where(
        and(
          eq(partnerInvoices.partnerAccountId, input.accountId),
          eq(partnerInvoices.partnerBookingId, bookingId),
        ),
      ),
  ]);
  if (
    parent.finalTotalCents !== null ||
    ledger.length ||
    attempts.length ||
    invoices.some(
      (invoice) =>
        !["draft", "void"].includes(invoice.status) ||
        invoice.paidCents > 0 ||
        invoice.hostedPaymentUrl ||
        invoice.providerOrderId ||
        invoice.providerInvoiceId,
    )
  )
    throw new TeamMutationFailure(
      "conflict",
      "This request has billing activity. Use the existing billing adjustment workflow to change its price.",
    );
  for (const [index, line] of lines.entries()) {
    const price = input.linePrices.find(
      (item) => item.serviceLineId === line.id,
    )!;
    if (!price.charges) continue;
    const allowedVariants = requiredServiceRateVariants(
      line.serviceKey,
      line.scope,
    );
    const calculated = price.charges.reduce((sum, charge) => {
      const rate = snapshots[index]!.rates.find(
        (candidate) =>
          candidate.key === charge.rateKey &&
          allowedVariants.includes(candidate.variantKey),
      );
      if (!rate)
        throw new TeamMutationFailure(
          "invalid",
          "Choose a published rate for this service and requested variant.",
        );
      return sum + multiplyPartnerRateToCents(rate.unitAmount, charge.quantity);
    }, 0);
    if (calculated !== price.amountCents)
      throw new TeamMutationFailure(
        "invalid",
        "The service amount does not match the reviewed rate and quantity.",
      );
  }
  if (total < requiredVisitMinimum(visits))
    throw new TeamMutationFailure(
      "invalid",
      "The confirmed total must cover one minimum for each scheduled visit.",
    );
  if (
    !parent.requestedByMembershipId ||
    typeof parent.scopeSnapshot?.["locationId"] !== "string"
  )
    throw new TeamMutationFailure(
      "conflict",
      "The request's approval identity needs review.",
    );
  const approval = await resolveMultiServiceApproval({
    tx,
    partnerAccountId: input.accountId,
    requestedByMembershipId: parent.requestedByMembershipId,
    serviceKeys: lines.map((line) => line.serviceKey),
    locationId: parent.scopeSnapshot["locationId"],
    amountMinor: total,
    currency: parent.currency,
    poNumber: parent.poNumber,
    costCenter: parent.costCenter,
  });
  // A changed price never inherits a decision about an earlier amount.
  await tx
    .update(partnerApprovalRequests)
    .set({
      state: "withdrawn",
      revision: sql`${partnerApprovalRequests.revision} + 1`,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerApprovalRequests.partnerAccountId, input.accountId),
        eq(partnerApprovalRequests.partnerBookingId, bookingId),
        inArray(partnerApprovalRequests.state, [
          "pending",
          "approved",
          "approved_needs_reschedule",
          "declined",
          "expired",
        ]),
      ),
    );
  if (approval.required) {
    const values = buildPartnerApprovalRequestInsert({
      resolution: approval,
      target: {
        kind: "booking",
        id: bookingId,
        partnerAccountId: input.accountId,
      },
      request: {
        description: lines
          .map((line) => `${line.serviceLabel}: ${line.description}`)
          .join("\n"),
      },
      now,
    });
    await tx.insert(partnerApprovalRequests).values({
      ...values,
      requestSnapshot: {
        ...values.requestSnapshot,
        modelVersion: 2,
        serviceKeys: lines.map((line) => line.serviceKey),
        pricingVersion: parent.pricingVersion + 1,
      },
    });
    await tx.insert(outboxEvents).values({
      type: "partner.approval.requested",
      payload: {
        partnerAccountId: input.accountId,
        partnerBookingId: bookingId,
        version: parent.version + 1,
      },
    });
  }
  for (const [index, line] of lines.entries()) {
    const price = input.linePrices.find(
      (item) => item.serviceLineId === line.id,
    )!;
    await tx
      .update(partnerBookingServiceLines)
      .set({
        quotedAmountCents: price.amountCents,
        priceDescription: price.description,
        pricingSnapshot: {
          ...snapshots[index]!,
          charges: price.charges ?? null,
          reason: input.reason,
          manuallyConfirmedAt: now.toISOString(),
          pricedByTeamMemberId: mutation.actor.id,
        },
      })
      .where(
        and(
          eq(partnerBookingServiceLines.partnerBookingId, bookingId),
          eq(partnerBookingServiceLines.id, line.id),
        ),
      );
  }
  await tx
    .update(partnerBookings)
    .set({
      quotedTotalCents: total,
      pricingVersion: parent.pricingVersion + 1,
      pricedAt: now,
      pricedByTeamMemberId: mutation.actor.id,
      confirmationMode: approval.required ? "approval" : "review",
      publicStatus: approval.required
        ? "approval_needed"
        : multiServiceParentStatus(lines, visits),
      version: parent.version + 1,
      updatedAt: now,
    })
    .where(eq(partnerBookings.id, bookingId));
  await enqueueOwnerAlertEvaluation(tx, {
    accountId: input.accountId,
    bookingId,
    now,
  });
  return {
    bookingId,
    version: parent.version + 1,
    pricingVersion: parent.pricingVersion + 1,
    quotedTotalCents: total,
    approvalRequired: approval.required,
  };
}

async function visitResourcePlan(
  tx: TeamMutationTransaction,
  lines: readonly { serviceKey: string }[],
  selectedIds: readonly string[],
  duration: number,
  buffer: number,
  now: Date,
) {
  const profiles = await tx
    .select()
    .from(partnerSchedulingProfiles)
    .where(
      and(
        inArray(
          partnerSchedulingProfiles.serviceKey,
          lines.map((line) => line.serviceKey),
        ),
        eq(partnerSchedulingProfiles.active, true),
        lte(partnerSchedulingProfiles.effectiveFrom, now),
        or(
          isNull(partnerSchedulingProfiles.effectiveTo),
          gt(partnerSchedulingProfiles.effectiveTo, now),
        ),
      ),
    )
    .orderBy(desc(partnerSchedulingProfiles.version));
  const current = [
    ...new Map(
      profiles.reverse().map((profile) => [profile.serviceKey, profile]),
    ).values(),
  ];
  const pools = new Set(current.map((profile) => profile.capacityPoolKey));
  if (current.length < lines.length) pools.add("field_service");
  if (pools.size !== 1)
    throw new TeamMutationFailure(
      "invalid",
      "These services use different resource pools. Schedule them as separate visits.",
    );
  const poolKey = [...pools][0]!;
  if (
    current.some(
      (profile) =>
        duration < profile.durationMinutes ||
        buffer < profile.travelBufferMinutes,
    )
  )
    throw new TeamMutationFailure(
      "invalid",
      `Allow at least ${Math.max(30, ...current.map((profile) => profile.durationMinutes))} minutes of work and ${Math.max(0, ...current.map((profile) => profile.travelBufferMinutes))} minutes of travel buffer. Travel buffer is under Crew, truck and equipment.`,
    );
  const requirements = new Map<string, NamedScheduleResourceRequirement>();
  let resources: NamedResourcePlan["resources"] = [];
  for (const profile of current) {
    const { plan } = await loadNamedResourcePlan({ tx, profile });
    if (!plan)
      throw new TeamMutationFailure(
        "conflict",
        "Configure this service's crew and equipment requirements before scheduling.",
      );
    resources = plan.resources;
    for (const required of plan.requirements) {
      const prior = requirements.get(required.kind);
      requirements.set(required.kind, {
        ...required,
        quantity: Math.max(prior?.quantity ?? 0, required.quantity),
        capacityUnits: Math.max(
          prior?.capacityUnits ?? 0,
          required.capacityUnits,
        ),
        requiredSkillKeys: [
          ...new Set([
            ...(prior?.requiredSkillKeys ?? []),
            ...required.requiredSkillKeys,
          ]),
        ],
      });
    }
  }
  if (current.length < lines.length) {
    const rows = await tx
      .select()
      .from(scheduleResources)
      .where(
        and(
          eq(scheduleResources.capacityPoolKey, poolKey),
          eq(scheduleResources.active, true),
          eq(scheduleResources.source, "staff"),
        ),
      );
    resources = rows.map((row) => ({
      id: row.id,
      capacityPoolKey: row.capacityPoolKey,
      kind: row.kind,
      label: row.label,
      capacityUnits: row.capacityUnits,
      dailyJobMultiplier: 1,
      skillKeys: row.skillKeys,
    }));
    if (
      !selectedIds.length ||
      !rows.some((row) => row.kind === "crew" && selectedIds.includes(row.id))
    )
      throw new TeamMutationFailure(
        "invalid",
        "Choose a staff crew for services without a scheduling profile.",
      );
    if (!requirements.has("crew"))
      requirements.set("crew", {
        kind: "crew",
        quantity: 1,
        capacityUnits: 1,
        requiredSkillKeys: [],
      });
  }
  if (
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !resources.some((resource) => resource.id === id))
  )
    throw new TeamMutationFailure(
      "invalid",
      "Choose active resources from this visit's pool.",
    );
  // Explicit optional resources also reserve capacity; never silently discard them.
  for (const kind of ["crew", "truck", "equipment"] as const) {
    const selected = resources.filter(
      (resource) => resource.kind === kind && selectedIds.includes(resource.id),
    );
    if (selected.length) {
      const prior = requirements.get(kind);
      requirements.set(kind, {
        kind,
        quantity: Math.max(prior?.quantity ?? 0, selected.length),
        capacityUnits: prior?.capacityUnits ?? 1,
        requiredSkillKeys: prior?.requiredSkillKeys ?? [],
      });
    }
  }
  return {
    poolKey,
    units: Math.max(1, ...current.map((profile) => profile.capacityUnits)),
    plan: {
      resources,
      requirements: [...requirements.values()],
      revision: "staff-visit",
    } satisfies NamedResourcePlan,
  };
}

export async function createPartnerMultiServiceVisit(
  tx: TeamMutationTransaction,
  mutation: VisitMutationContext,
  bookingId: string,
  input: z.infer<typeof PartnerMultiServiceVisitSchema>,
  now = new Date(),
  existingVisitId?: string,
) {
  const parent = await lockParent(tx, mutation, input.accountId, bookingId);
  await acquireScheduleConflictLock(tx);
  const [existingVisit] = existingVisitId
    ? await tx
        .select()
        .from(partnerBookingVisits)
        .where(
          and(
            eq(partnerBookingVisits.id, existingVisitId),
            eq(partnerBookingVisits.partnerBookingId, bookingId),
            eq(partnerBookingVisits.partnerAccountId, input.accountId),
          ),
        )
        .for("update")
        .limit(1)
    : [];
  if (
    existingVisitId &&
    (!existingVisit || existingVisit.status !== "scheduled")
  )
    throw new TeamMutationFailure(
      "conflict",
      "Only an upcoming visit can be rescheduled.",
    );
  if (existingVisit) {
    const mapped = await tx
      .select()
      .from(partnerBookingVisitLines)
      .where(eq(partnerBookingVisitLines.visitId, existingVisit.id));
    if (
      mapped.length !== input.serviceLineIds.length ||
      mapped.some((line) => !input.serviceLineIds.includes(line.serviceLineId))
    )
      throw new TeamMutationFailure(
        "invalid",
        "Keep the visit's services when rescheduling. Create a separate visit for other work.",
      );
  }
  if (parent.quotedTotalCents === null || !parent.pricedAt)
    throw new TeamMutationFailure(
      "conflict",
      "Confirm this request's service prices before scheduling.",
    );
  if (parent.publicStatus === "approval_needed")
    throw new TeamMutationFailure(
      "conflict",
      "Resolve company approval before scheduling this visit.",
    );
  const [unresolved] = await tx
    .select({ id: partnerApprovalRequests.id })
    .from(partnerApprovalRequests)
    .where(
      and(
        eq(partnerApprovalRequests.partnerAccountId, input.accountId),
        eq(partnerApprovalRequests.partnerBookingId, bookingId),
        inArray(partnerApprovalRequests.state, [
          "pending",
          "declined",
          "expired",
        ]),
      ),
    )
    .limit(1);
  if (unresolved)
    throw new TeamMutationFailure(
      "conflict",
      "Resolve company approval before scheduling this visit.",
    );
  const allLines = await serviceLines(tx, input.accountId, bookingId);
  const lines = allLines.filter((line) =>
    input.serviceLineIds.includes(line.id),
  );
  if (
    lines.length !== input.serviceLineIds.length ||
    lines.some((line) => ["completed", "canceled"].includes(line.status))
  )
    throw new TeamMutationFailure(
      "invalid",
      "Choose unfinished services from this request.",
    );
  const snapshots = await requireRates(tx, input.accountId, lines, now);
  const minimum =
    existingVisit?.minimumAmountCents ??
    Math.max(
      0,
      ...snapshots.map((snapshot) =>
        snapshot.visitMinimum
          ? multiplyPartnerRateToCents(snapshot.visitMinimum, "1")
          : 0,
      ),
    );
  const visits = await visitsFor(tx, input.accountId, bookingId);
  if (
    parent.quotedTotalCents <
    requiredVisitMinimum(
      visits.filter((visit) => visit.id !== existingVisitId),
      minimum,
    )
  )
    throw new TeamMutationFailure(
      "conflict",
      "This extra visit raises the minimum for the request. Confirm a revised service price before scheduling it.",
    );
  const resolved = resolveEasternAppointmentTime(input.date, input.startTime);
  if (!resolved.ok) throw new TeamMutationFailure("invalid", resolved.message);
  if (resolved.value <= now)
    throw new TeamMutationFailure("invalid", "Choose a future visit time.");
  if (!parent.propertyId)
    throw new TeamMutationFailure(
      "conflict",
      "Review the service property before scheduling.",
    );
  const [policy, rules, resources] = await Promise.all([
    getBusinessHoursPolicy(tx),
    getBookingRulesPolicy(tx),
    visitResourcePlan(
      tx,
      lines,
      input.resourceIds,
      input.durationMinutes,
      input.travelBufferMinutes,
      now,
    ),
  ]);
  const [pool] = await tx
    .select()
    .from(scheduleResourcePools)
    .where(
      and(
        eq(scheduleResourcePools.key, resources.poolKey),
        eq(scheduleResourcePools.active, true),
      ),
    )
    .limit(1);
  if (!pool)
    throw new TeamMutationFailure(
      "conflict",
      "Configure an active capacity pool before scheduling.",
    );
  const conflict = await inspectScheduleConflicts(tx, {
    startAt: resolved.value,
    durationMinutes: input.durationMinutes,
    travelBufferMinutes: input.travelBufferMinutes,
    capacity: pool.capacityUnits,
    capacityUnits: resources.units,
    capacityPoolKey: resources.poolKey,
    timezone: policy.timezone,
    includeHolds: true,
    excludeAppointmentId: existingVisit?.appointmentId,
    now,
  });
  if (conflict.conflict)
    throw new TeamMutationFailure(
      "conflict",
      "This visit conflicts with reserved crew capacity. Choose another time or crew.",
    );
  const endAt = new Date(
    resolved.value.getTime() +
      (input.durationMinutes + input.travelBufferMinutes) * 60000,
  );
  const blocks = await loadNamedResourceBlocks({
    tx,
    plan: resources.plan,
    capacityPoolKey: resources.poolKey,
    startAt: resolved.value,
    endAt,
    timezone: policy.timezone,
    excludeAppointmentId: existingVisit?.appointmentId,
    now,
  });
  const assignment = assignNamedScheduleResources({
    capacityPoolKey: resources.poolKey,
    occupancy: { startAt: resolved.value, endAt },
    localDate: DateTime.fromJSDate(resolved.value, {
      zone: policy.timezone,
    }).toISODate()!,
    resources: input.resourceIds.length
      ? resources.plan.resources.filter((resource) =>
          input.resourceIds.includes(resource.id),
        )
      : resources.plan.resources,
    requirements: resources.plan.requirements,
    blocks,
    maxJobsPerCrew: rules.maxJobsPerCrew,
  });
  if (!assignment.available)
    throw new TeamMutationFailure(
      "conflict",
      "The selected crew or equipment is unavailable for this visit.",
    );
  const arrival = partnerStaffArrivalWindow(resolved.value, policy);
  const appointmentValues = {
    contactId: parent.orgContactId,
    propertyId: parent.propertyId,
    partnerAccountId: input.accountId,
    type: "job",
    status: "confirmed",
    startAt: resolved.value,
    schedulingTimezone: policy.timezone,
    durationMinutes: input.durationMinutes,
    travelBufferMinutes: input.travelBufferMinutes,
    capacityPoolKey: resources.poolKey,
    capacityUnits: resources.units,
    resourceAssignmentSnapshot: assignment.assignments.map((item) => ({
      ...item,
    })),
    quotedScopeText: lines
      .map((line) => `${line.serviceLabel}: ${line.description}`)
      .join("\n")
      .slice(0, 4000),
    quotedTotalCents: null,
    finalTotalCents: null,
    rescheduleToken: randomUUID().replaceAll("-", ""),
    promisedArrivalStartAt: arrival.startAt,
    promisedArrivalEndAt: arrival.endAt,
    createdAt: now,
    updatedAt: now,
  };
  const [appointment] = existingVisit
    ? await tx
        .update(appointments)
        .set({
          startAt: resolved.value,
          durationMinutes: input.durationMinutes,
          travelBufferMinutes: input.travelBufferMinutes,
          capacityPoolKey: resources.poolKey,
          capacityUnits: resources.units,
          resourceAssignmentSnapshot:
            appointmentValues.resourceAssignmentSnapshot,
          promisedArrivalStartAt: arrival.startAt,
          promisedArrivalEndAt: arrival.endAt,
          schedulingTimezone: policy.timezone,
          updatedAt: now,
        })
        .where(eq(appointments.id, existingVisit.appointmentId))
        .returning()
    : await tx
        .insert(appointments)
        .values(appointmentValues as typeof appointments.$inferInsert)
        .returning();
  if (!appointment) throw new Error("partner_visit_appointment_failed");
  const [visit] = existingVisit
    ? await tx
        .update(partnerBookingVisits)
        .set({ version: existingVisit.version + 1, updatedAt: now })
        .where(eq(partnerBookingVisits.id, existingVisit.id))
        .returning()
    : await tx
        .insert(partnerBookingVisits)
        .values({
          partnerAccountId: input.accountId,
          partnerBookingId: bookingId,
          appointmentId: appointment.id,
          minimumAmountCents: minimum,
          rateSnapshot: {
            rateCardVersionIds: [
              ...new Set(
                snapshots.flatMap((snapshot) => [
                  snapshot.minimumRateCardVersionId,
                  ...snapshot.rateSources.map(
                    (source) => source.rateCardVersionId,
                  ),
                ]),
              ),
            ],
            minimumAmountCents: minimum,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning();
  if (!visit) throw new Error("partner_visit_create_failed");
  if (!existingVisit)
    await tx.insert(partnerBookingVisitLines).values(
      lines.map((line) => ({
        partnerAccountId: input.accountId,
        partnerBookingId: bookingId,
        visitId: visit.id,
        serviceLineId: line.id,
      })),
    );
  await tx
    .update(partnerBookings)
    .set({
      publicStatus: multiServiceParentStatus(allLines, [
        ...visits.filter((item) => item.id !== visit.id),
        { ...visit, serviceLineIds: input.serviceLineIds },
      ]),
      version: parent.version + 1,
      updatedAt: now,
    })
    .where(eq(partnerBookings.id, bookingId));
  await tx.insert(partnerJobEvents).values({
    partnerAccountId: input.accountId,
    partnerBookingId: bookingId,
    eventType: existingVisit ? "job.rescheduled" : "job.confirmed",
    publicLabel: existingVisit ? "Visit rescheduled" : "Visit confirmed",
    publicDetail: `${lines.map((line) => line.serviceLabel).join(", ")}: a service visit is confirmed.`,
    actorType: "staff",
    actorTeamMemberId: mutation.actor.id,
    effectiveAt: now,
    metadata: {
      visitId: visit.id,
      appointmentId: appointment.id,
      serviceLineIds: input.serviceLineIds,
    },
    createdAt: now,
  });
  await tx.insert(outboxEvents).values({
    type: "appointment.calendar_sync_requested",
    payload: {
      appointmentId: appointment.id,
      version: appointment.updatedAt.toISOString(),
      reason: existingVisit
        ? "partner.multi_service.visit_rescheduled"
        : "partner.multi_service.visit_created",
      requestedCalendarEventId: appointment.calendarEventId,
      correlationId: mutation.correlationId,
    },
    createdAt: now,
  });
  await tx.insert(outboxEvents).values({
    type: "partner.job.status_committed",
    payload: {
      accountId: input.accountId,
      jobId: bookingId,
      visitId: visit.id,
      status: existingVisit ? "rescheduled" : "confirmed",
      version: String(visit.version),
    },
    createdAt: now,
  });
  return {
    bookingId,
    version: parent.version + 1,
    visitId: visit.id,
    appointmentId: appointment.id,
    startAt: resolved.value.toISOString(),
    arrivalStartAt: arrival.startAt.toISOString(),
    arrivalEndAt: arrival.endAt.toISOString(),
  };
}

export async function updatePartnerMultiServiceVisit(
  tx: TeamMutationTransaction,
  mutation: VisitMutationContext,
  bookingId: string,
  visitId: string,
  input: z.infer<typeof PartnerMultiServiceVisitStatusSchema>,
  now = new Date(),
) {
  const parent = await lockParent(tx, mutation, input.accountId, bookingId);
  await acquireScheduleConflictLock(tx);
  const [visit] = await tx
    .select()
    .from(partnerBookingVisits)
    .where(
      and(
        eq(partnerBookingVisits.id, visitId),
        eq(partnerBookingVisits.partnerBookingId, bookingId),
        eq(partnerBookingVisits.partnerAccountId, input.accountId),
      ),
    )
    .for("update")
    .limit(1);
  if (!visit || ["completed", "canceled"].includes(visit.status))
    throw new TeamMutationFailure(
      "conflict",
      "This visit is closed or unavailable.",
    );
  const mappings = await tx
    .select()
    .from(partnerBookingVisitLines)
    .where(eq(partnerBookingVisitLines.visitId, visitId));
  if (
    input.completedServiceLineIds.some(
      (id) => !mappings.some((mapping) => mapping.serviceLineId === id),
    ) ||
    (input.status !== "completed" && input.completedServiceLineIds.length)
  )
    throw new TeamMutationFailure(
      "invalid",
      "Only services completed on this visit can be marked complete.",
    );
  if (input.completedServiceLineIds.length) {
    const outstanding = await tx
      .select({ id: partnerBookingVisits.id })
      .from(partnerBookingVisitLines)
      .innerJoin(
        partnerBookingVisits,
        eq(partnerBookingVisits.id, partnerBookingVisitLines.visitId),
      )
      .where(
        and(
          eq(partnerBookingVisitLines.partnerBookingId, bookingId),
          inArray(
            partnerBookingVisitLines.serviceLineId,
            input.completedServiceLineIds,
          ),
          inArray(partnerBookingVisits.status, ["scheduled", "in_progress"]),
          sql`${partnerBookingVisits.id} <> ${visitId}`,
        ),
      )
      .limit(1);
    if (outstanding.length)
      throw new TeamMutationFailure(
        "conflict",
        "These services still have another unfinished visit. Finish or cancel that visit first.",
      );
    const completingLines = (
      await serviceLines(tx, input.accountId, bookingId)
    ).filter((line) => input.completedServiceLineIds.includes(line.id));
    const evidence = await tx
      .select({
        id: partnerJobEvidence.id,
        category: partnerJobEvidence.category,
      })
      .from(partnerJobEvidence)
      .innerJoin(
        mediaAssets,
        eq(mediaAssets.id, partnerJobEvidence.mediaAssetId),
      )
      .where(
        and(
          eq(partnerJobEvidence.partnerAccountId, input.accountId),
          eq(partnerJobEvidence.partnerBookingId, bookingId),
          isNull(partnerJobEvidence.deletedAt),
          eq(mediaAssets.status, "ready"),
          isNull(mediaAssets.deletedAt),
        ),
      );
    const associations = (
      parent.scopeSnapshot?.["scope"] as Record<string, unknown> | undefined
    )?.["photoServiceAssociations"] as Record<string, string[]> | undefined;
    for (const line of completingLines) {
      for (const category of ["before", "after"] as const) {
        const minimum = line.proofRequirements[category] ?? 0;
        if (
          typeof minimum !== "number" ||
          !Number.isSafeInteger(minimum) ||
          minimum < 0 ||
          minimum > 100
        )
          throw new TeamMutationFailure(
            "conflict",
            "The service completion evidence requirements need review.",
          );
        const available = evidence.filter(
          (item) =>
            item.category === category &&
            (!associations?.[item.id]?.length ||
              associations[item.id]!.includes(line.id)),
        ).length;
        if (available < minimum)
          throw new TeamMutationFailure(
            "conflict",
            `Add ${line.serviceLabel} ${category} evidence before completing this service (${available}/${minimum}).`,
          );
      }
    }
    await tx
      .update(partnerBookingServiceLines)
      .set({ status: "completed", completedAt: now })
      .where(
        and(
          eq(partnerBookingServiceLines.partnerBookingId, bookingId),
          inArray(partnerBookingServiceLines.id, input.completedServiceLineIds),
        ),
      );
  }
  if (input.status === "in_progress")
    await tx
      .update(partnerBookingServiceLines)
      .set({ status: "in_progress" })
      .where(
        and(
          eq(partnerBookingServiceLines.partnerBookingId, bookingId),
          inArray(
            partnerBookingServiceLines.id,
            mappings.map((mapping) => mapping.serviceLineId),
          ),
          eq(partnerBookingServiceLines.status, "pending"),
        ),
      );
  await tx
    .update(partnerBookingVisits)
    .set({ status: input.status, version: visit.version + 1, updatedAt: now })
    .where(eq(partnerBookingVisits.id, visitId));
  const [appointment] = await tx
    .update(appointments)
    .set({
      status: input.status === "in_progress" ? "confirmed" : input.status,
      completedAt: input.status === "completed" ? now : null,
      updatedAt: now,
    })
    .where(eq(appointments.id, visit.appointmentId))
    .returning();
  const lines = await serviceLines(tx, input.accountId, bookingId);
  const remaining = await visitsFor(tx, input.accountId, bookingId);
  const nextStatus = multiServiceParentStatus(lines, remaining);
  const completed = nextStatus === "completed";
  if (completed) {
    const proof = await evaluatePartnerProofCompletion(tx, {
      accountId: input.accountId,
      bookingId,
    });
    if (proof.kind !== "satisfied")
      throw new TeamMutationFailure(
        "conflict",
        proof.kind === "missing"
          ? `Add the required completion evidence before finishing: ${proof.missing.map((item) => `${item.category} (${item.availableCount}/${item.minimumCount})`).join(", ")}.`
          : "The request's completion evidence needs review.",
      );
  }
  await tx
    .update(partnerBookings)
    .set({
      publicStatus: nextStatus,
      version: parent.version + 1,
      updatedAt: now,
    })
    .where(eq(partnerBookings.id, bookingId));
  if (completed && parent.publicStatus !== "completed")
    await tx.insert(outboxEvents).values([
      {
        type: "partner.job.status_committed",
        payload: {
          accountId: input.accountId,
          jobId: bookingId,
          status: "completed",
          version: String(parent.version + 1),
        },
        createdAt: now,
      },
      {
        type: "partner.proof.prepare",
        payload: { accountId: input.accountId, jobId: bookingId },
        createdAt: now,
      },
    ]);
  await tx.insert(partnerJobEvents).values({
    partnerAccountId: input.accountId,
    partnerBookingId: bookingId,
    eventType: completed ? "job.completed" : "job.updated",
    publicLabel:
      input.status === "completed"
        ? "Visit completed"
        : input.status === "canceled"
          ? "Visit canceled"
          : "Visit started",
    actorType: "staff",
    actorTeamMemberId: mutation.actor.id,
    effectiveAt: now,
    metadata: {
      visitId,
      completedServiceLineIds: input.completedServiceLineIds,
    },
    createdAt: now,
  });
  if (appointment && input.status !== "canceled")
    await tx.insert(outboxEvents).values({
      type: "appointment.calendar_sync_requested",
      payload: {
        appointmentId: appointment.id,
        version: appointment.updatedAt.toISOString(),
        reason: "partner.multi_service.visit_updated",
        requestedCalendarEventId: appointment.calendarEventId,
        correlationId: mutation.correlationId,
      },
    });
  return {
    bookingId,
    visitId,
    version: parent.version + 1,
    status: input.status,
    parentCompleted: completed,
  };
}

/** Caller already owns the parent mutation lock and preserves commercial history. */
export async function cancelPartnerMultiServiceRequest(
  tx: TeamMutationTransaction,
  accountId: string,
  bookingId: string,
  now = new Date(),
) {
  await acquireScheduleConflictLock(tx);
  const visits = await visitsFor(tx, accountId, bookingId);
  const open = visits.filter(
    (visit) => !["completed", "canceled"].includes(visit.status),
  );
  for (const visit of open) {
    await tx
      .update(partnerBookingVisits)
      .set({ status: "canceled", version: visit.version + 1, updatedAt: now })
      .where(eq(partnerBookingVisits.id, visit.id));
    await tx
      .update(appointments)
      .set({ status: "canceled", updatedAt: now })
      .where(eq(appointments.id, visit.appointmentId))
      .returning();
  }
  await tx
    .update(partnerBookingServiceLines)
    .set({ status: "canceled" })
    .where(
      and(
        eq(partnerBookingServiceLines.partnerAccountId, accountId),
        eq(partnerBookingServiceLines.partnerBookingId, bookingId),
        inArray(partnerBookingServiceLines.status, ["pending", "in_progress"]),
      ),
    );
  return {
    canceledVisitIds: open.map((visit) => visit.id),
    completedWorkRemains: visits.some((visit) => visit.status === "completed"),
  };
}
